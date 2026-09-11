//! HTTP API. JSON, snake_case, big integers as decimal strings, unix seconds.
//!
//! Read-only: this service holds no keys and sends no transactions. Executable numbers come from
//! `TremorLens`, which calls the same engine the router does; anything computed here is a replica for
//! charts and diagnostics and says so in a `source` field.

use std::collections::{BTreeMap, HashMap};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use alloy::eips::BlockNumberOrTag;
use alloy::primitives::{Address, U256};
use alloy::providers::Provider;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use futures::future::join_all;
use serde_json::{json, Value};
use tower::limit::ConcurrencyLimitLayer;
use tower_http::cors::{Any, CorsLayer};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

use crate::chainlink::{FeedError, Sample};
use crate::db::{
    FillRow, FillStats, PortfolioCheckpointRow, PortfolioEventRow, PortfolioGroupRow, SeriesRow,
};
use crate::error::{ApiError, ApiResult};
use crate::market::{self, Checkpoint, Flow, Params};
use crate::rpc::{retry, transport_retryable};
use crate::rv;
use crate::util::{now_unix, parse_window, wad_string, SECONDS_PER_DAY};
use crate::AppState;

type S = State<Arc<AppState>>;
type Q = Query<HashMap<String, String>>;

pub const MARKET_POINTS: usize = 200;
pub const MAX_HISTORY_POINTS: u64 = 256;
pub const MAX_SERIES_PAGE: u64 = 100;
pub const MAX_FILLS_PAGE: u64 = 500;
pub const MAX_VAULT_EVENTS: u64 = 200;

pub fn router(state: Arc<AppState>) -> Router {
    let cors = build_cors(&state.cfg.cors_origin);
    Router::new()
        .route("/health", get(health))
        .route("/config", get(config))
        .route("/vault/:address", get(vault_detail))
        .route("/portfolio/:address", get(portfolio))
        .route("/series", get(series_list))
        .route("/series/:id", get(series_detail))
        .route("/series/:id/fills", get(series_fills))
        .route("/series/:id/variance", get(series_variance))
        .route("/series/:id/market", get(series_market))
        .route("/series/:id/quote", get(series_quote))
        .route("/series/:id/checkpoints", get(series_checkpoints))
        .route("/series/:id/aqua", get(series_aqua))
        .route("/variance/trailing", get(variance_trailing))
        .route("/feed/history", get(feed_history))
        .route("/lvr", get(lvr))
        .route("/pairs", get(pairs_list))
        .route("/pairs/:id", get(pairs_detail))
        .route("/pairs/:id/events", get(pairs_events))
        .route("/pairs/:id/checkpoints", get(pairs_checkpoints))
        .fallback(not_found)
        .layer(ConcurrencyLimitLayer::new(32))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(30),
        ))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}

fn build_cors(origins: &str) -> CorsLayer {
    let layer = CorsLayer::new()
        .allow_methods([Method::GET, Method::OPTIONS])
        .allow_headers(Any);
    if origins.trim() == "*" {
        layer.allow_origin(Any)
    } else {
        let list: Vec<HeaderValue> = origins
            .split(',')
            .filter_map(|o| o.trim().parse().ok())
            .collect();
        layer.allow_origin(list)
    }
}

async fn not_found() -> impl IntoResponse {
    ApiError::NotFound("no such route".into())
}

// ---- helpers -------------------------------------------------------------------------------

fn upstream(e: impl std::fmt::Display) -> ApiError {
    tracing::warn!(error = %e, "upstream request failed");
    ApiError::Upstream("upstream request failed".to_string())
}

fn feed_err(e: anyhow::Error) -> ApiError {
    if let Some(FeedError::WindowPredatesFeed(_)) = e.downcast_ref::<FeedError>() {
        ApiError::BadRequest(e.to_string())
    } else {
        tracing::warn!(error = format!("{e:#}"), "feed request failed");
        ApiError::Upstream("feed request failed".to_string())
    }
}

fn parse_id(id: &str) -> ApiResult<i64> {
    id.parse::<i64>()
        .map_err(|_| ApiError::BadRequest(format!("invalid series id '{id}'")))
}

fn parse_address(s: &str) -> ApiResult<Address> {
    s.trim()
        .parse::<Address>()
        .map_err(|_| ApiError::BadRequest(format!("'{s}' is not an address")))
}

fn qp_u64(q: &HashMap<String, String>, key: &str) -> ApiResult<Option<u64>> {
    match q.get(key) {
        None => Ok(None),
        Some(v) => v
            .trim()
            .parse::<u64>()
            .map(Some)
            .map_err(|_| ApiError::BadRequest(format!("{key} must be a non-negative integer"))),
    }
}

fn qp_f64(q: &HashMap<String, String>, key: &str) -> ApiResult<Option<f64>> {
    match q.get(key) {
        None => Ok(None),
        Some(v) => v
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|x| x.is_finite())
            .map(Some)
            .ok_or_else(|| ApiError::BadRequest(format!("{key} must be a number"))),
    }
}

fn qp_addr(q: &HashMap<String, String>, key: &str) -> ApiResult<Option<Address>> {
    match q.get(key) {
        None => Ok(None),
        Some(v) => v
            .trim()
            .parse::<Address>()
            .map(Some)
            .map_err(|_| ApiError::BadRequest(format!("{key} must be an address"))),
    }
}

fn qp_u256(q: &HashMap<String, String>, key: &str) -> ApiResult<Option<U256>> {
    match q.get(key) {
        None => Ok(None),
        Some(v) => U256::from_str(v.trim())
            .map(Some)
            .map_err(|_| ApiError::BadRequest(format!("{key} must be an unsigned integer"))),
    }
}

/// The chain's own head timestamp, with no local adjustment.
///
/// Use this wherever a value has to line up with what a contract would compute in the next call:
/// `chain_now` deliberately runs ahead of an idle Anvil, and a chart drawn on wall-clock time would
/// disagree with the Lens quote sitting next to it on the page.
async fn chain_head_time(state: &AppState) -> ApiResult<u64> {
    let p = &state.provider;
    let b = retry(
        "eth_getBlockByNumber(latest)",
        transport_retryable,
        || async { p.get_block_by_number(BlockNumberOrTag::Latest).await },
    )
    .await
    .map_err(upstream)?;
    Ok(b.map(|b| b.header.timestamp).unwrap_or(0))
}

/// Chain time, except on local Anvil, which only mines on demand and would otherwise report a
/// timestamp minutes or hours in the past. Used for lifecycle questions ("is the sale still open?"),
/// never for anything that must match a contract read.
async fn chain_now(state: &AppState) -> ApiResult<u64> {
    let p = &state.provider;
    let b = retry(
        "eth_getBlockByNumber(latest)",
        transport_retryable,
        || async { p.get_block_by_number(BlockNumberOrTag::Latest).await },
    )
    .await
    .map_err(upstream)?;
    let ts = b.map(|b| b.header.timestamp).unwrap_or(0);
    Ok(if state.manifest.chain_id == 31_337 {
        ts.max(now_unix())
    } else {
        ts
    })
}

async fn series_or_404(state: &AppState, id: &str) -> ApiResult<SeriesRow> {
    let id = parse_id(id)?;
    state
        .db
        .series_get(id)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("series {id} not found")))
}

fn db_u64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

fn parse_u128(s: &str) -> u128 {
    s.parse::<u128>().unwrap_or(0)
}

fn params_json_from_row(r: &SeriesRow) -> Value {
    json!({
        "feed": r.feed, "quote_token": r.quote_token, "start": r.start, "expiry": r.expiry,
        "sale_end": r.sale_end, "sample_interval": r.sample_interval, "unit_notional": r.unit_notional,
        "cap_variance": r.cap_variance, "anchor_variance": r.anchor_variance,
        "impact_per_unit": r.impact_per_unit, "half_life": r.half_life,
        "half_spread_bps": r.half_spread_bps, "max_units": r.max_units,
    })
}

fn market_params(r: &SeriesRow) -> Params {
    Params {
        start: db_u64(r.start),
        expiry: db_u64(r.expiry),
        sample_interval: db_u64(r.sample_interval).max(1),
        unit_notional: parse_u128(&r.unit_notional),
        cap_variance: parse_u128(&r.cap_variance),
        anchor_variance: parse_u128(&r.anchor_variance),
        impact_per_unit: parse_u128(&r.impact_per_unit),
        half_life: r.half_life.clamp(0, u32::MAX as i64) as u32,
        half_spread_bps: r.half_spread_bps.clamp(0, u16::MAX as i64) as u16,
    }
}

/// ISSUE fills push the market's inventory skew up; EXIT fills pull it back down. SETTLE does not
/// move the market: by then the variance is already fixed.
fn market_flows(fills: &[FillRow]) -> Vec<Flow> {
    let mut flows: Vec<Flow> = fills
        .iter()
        .filter_map(|f| {
            let units = f.units.parse::<i128>().ok()?;
            match f.leg.as_str() {
                "issue" => Some(Flow {
                    t: db_u64(f.timestamp),
                    units_delta: units,
                }),
                "exit" => Some(Flow {
                    t: db_u64(f.timestamp),
                    units_delta: -units,
                }),
                _ => None,
            }
        })
        .collect();
    flows.sort_by_key(|f| f.t);
    flows
}

async fn market_checkpoints(state: &AppState, series_id: i64) -> ApiResult<Vec<Checkpoint>> {
    Ok(state
        .db
        .checkpoints_for(series_id)
        .await?
        .iter()
        .map(|c| Checkpoint {
            // Checkpoints are submitted later than the historical window they cover. For the
            // market chart, place the accumulated variance on the observation timeline rather
            // than at the transaction timestamp, otherwise a backdated series appears to have
            // zero realized variance until the checkpoint transaction itself.
            t: db_u64(c.processed_through),
            processed_through: db_u64(c.processed_through),
            sum_squared_returns: parse_u128(&c.sum_squared_returns),
        })
        .collect())
}

/// Lens `state(id)` (or a DB-derived approximation when the Lens is unreachable) plus fill statistics.
async fn series_summary(state: &AppState, row: &SeriesRow, now: u64, stats: &FillStats) -> Value {
    let mut v = match state.lens.state(db_u64(row.id)).await {
        Ok(js) => serde_json::to_value(js).unwrap_or(Value::Null),
        Err(e) => {
            tracing::debug!(series = row.id, error = %e, "lens unavailable; serving a db-derived summary");
            let fills = state.db.fills_for(row.id).await.unwrap_or_default();
            let checkpoints = state.db.checkpoints_for(row.id).await.unwrap_or_default();
            let p = market_params(row);
            let cps: Vec<Checkpoint> = checkpoints
                .iter()
                .map(|c| Checkpoint {
                    t: db_u64(c.processed_through),
                    processed_through: db_u64(c.processed_through),
                    sum_squared_returns: parse_u128(&c.sum_squared_returns),
                })
                .collect();
            let point = market::market_at(&p, &market_flows(&fills), &cps, now);
            // Nulls are deliberate: a value the Lens owns is unknown here, and inventing one would be
            // worse than showing an em dash.
            json!({
                "id": row.id, "writer": row.writer, "vault": row.vault, "receipt": row.receipt,
                "params": params_json_from_row(row),
                "issue_order_hash": row.issue_order_hash, "exit_order_hash": row.exit_order_hash,
                "settlement_order_hash": row.settlement_order_hash,
                "status": null, "issuance_open": null, "exit_open": null, "settle_open": null,
                "market_variance": point.market_variance, "projected_variance": point.projected_variance,
                "realized_variance_so_far": point.realized_variance,
                "bid_variance": point.bid_variance, "ask_variance": point.ask_variance,
                "bid_per_unit": point.bid_per_unit, "ask_per_unit": point.ask_per_unit,
                "units_outstanding": null, "units_available": null, "locked_liability": null,
                "final_variance": null, "payout_per_unit": null, "fully_collateralized": null,
                "vault_state": null, "checkpoints_current": point.checkpoints_fresh,
                "source": "db", "lens_error": e.to_string(),
            })
        }
    };
    if let Value::Object(m) = &mut v {
        m.insert("fills_count".into(), json!(stats.count));
        m.insert("issue_count".into(), json!(stats.issue_count));
        m.insert("exit_count".into(), json!(stats.exit_count));
        m.insert("settle_count".into(), json!(stats.settle_count));
        m.insert(
            "premium_quote".into(),
            json!(stats.premium_quote.to_string()),
        );
        m.insert("exit_quote".into(), json!(stats.exit_quote.to_string()));
        m.insert(
            "settlement_quote".into(),
            json!(stats.settlement_quote.to_string()),
        );
        m.insert("units_issued".into(), json!(stats.units_issued.to_string()));
        m.insert("units_exited".into(), json!(stats.units_exited.to_string()));
        m.insert(
            "units_settled".into(),
            json!(stats.units_settled.to_string()),
        );
        m.insert("last_fill_at".into(), json!(stats.last_fill_at));
        m.insert("created_at".into(), json!(row.created_at));
        m.insert("created_block".into(), json!(row.created_block));
        m.insert("created_tx".into(), json!(row.created_tx));
        m.insert("issuance_stopped_at".into(), json!(row.issuance_stopped_at));
        m.insert("closed_at".into(), json!(row.closed_at));
    }
    v
}

fn sample_json(s: &Sample, decimals: u8, log_return: Option<f64>) -> Value {
    json!({
        "t": s.t,
        "price": s.round.price_f64(decimals),
        "answer": s.round.answer.to_string(),
        "price_wad": s.round.price_wad_string(decimals),
        "round_id": s.round.round_id().to_string(),
        "phase": s.round.phase,
        "updated_at": s.round.updated_at,
        "log_return": log_return,
    })
}

fn phases_used(samples: &[Sample]) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    for s in samples {
        if !out.contains(&s.round.phase) {
            out.push(s.round.phase);
        }
    }
    out
}

// ---- handlers ------------------------------------------------------------------------------

async fn health(State(s): S) -> ApiResult<(StatusCode, Json<Value>)> {
    let st = s.indexer.snapshot().await;
    let head = match s.provider.get_block_number().await {
        Ok(h) => Some(h),
        Err(_) => st.head_block,
    };
    let chain_id = match st.chain_id {
        Some(c) => Some(c),
        None => s.provider.get_chain_id().await.ok(),
    };
    let indexed = match st.indexed_block {
        Some(b) => Some(b),
        None => s.db.cursor().await?.map(|c| db_u64(c.last_block)),
    };
    let lag = head.zip(indexed).map(|(h, i)| h.saturating_sub(i));
    let fresh = st
        .last_tick_at
        .is_some_and(|t| now_unix().saturating_sub(t) <= 30);
    let ok = chain_id == Some(s.manifest.chain_id)
        && st.last_error.is_none()
        && fresh
        && lag.is_some_and(|n| n <= crate::indexer::CHUNK_BLOCKS * 2);
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    Ok((
        status,
        Json(json!({
            "ok": ok,
            "chain_id": chain_id,
            "head_block": head,
            "indexed_block": indexed,
            "series_indexed": s.db.series_count().await?,
            "vaults_indexed": st.vault_count,
            "schema_version": s.db.schema_version().await?,
            "manifest_schema_version": s.manifest.schema_version,
            "indexer_error": st.last_error,
            "last_tick_at": st.last_tick_at,
            "resets": st.resets,
            "lag_blocks": lag,
        })),
    ))
}

async fn config(State(s): S) -> ApiResult<Json<Value>> {
    let m = &s.manifest;
    Ok(Json(json!({
        "schemaVersion": m.schema_version,
        "chainId": m.chain_id,
        "aqua": m.aqua,
        "router": m.router,
        "routerSourceCommit": m.router_source_commit,
        "routerBytecodeHash": m.router_bytecode_hash,
        "weth": m.weth,
        "usdc": m.usdc,
        "feed": m.feed,
        "seriesFactory": m.series_factory,
        "marketEngine": m.market_engine,
        "accumulator": m.accumulator,
        "seriesDeployer": m.series_deployer,
        "programs": m.programs,
        "lens": m.lens,
        "oracle": m.oracle,
        "deploymentBlock": m.deployment_block,
        "feed_decimals": s.feed_decimals,
        "quote_decimals": 6,
        "max_samples_per_checkpoint": s.max_samples_per_checkpoint,
    })))
}

/// A writer's vault: the enforceable collateral position, the series it backs, and its history.
///
/// Accepts either the vault address or the writer's address, because a writer knows their own address
/// and should not have to look up the vault's first.
async fn vault_detail(
    State(s): S,
    Path(address): Path<String>,
    Query(q): Q,
) -> ApiResult<Json<Value>> {
    let requested = parse_address(&address)?;
    let key = format!("{requested:#x}");

    let (row, resolved) = match s.db.vault_get(&key).await? {
        Some(row) => (Some(row), requested),
        None => match s.db.vault_for_writer(&key).await? {
            Some(row) => {
                let vault = parse_address(&row.address)?;
                (Some(row), vault)
            }
            None => (None, requested),
        },
    };

    // The Lens knows the vault a writer will have even before they create it, because the address is a
    // pure function of the deployer's. That is what lets the writer page show the address up front.
    let (lens_vault, exists, vault_state) = s
        .lens
        .writer_vault(requested)
        .await
        .map(|(v, e, st)| (Some(v), e, Some(st)))
        .unwrap_or((None, row.is_some(), None));

    let vault_state = match (vault_state, row.is_some()) {
        (Some(st), _) if st.owner != format!("{:#x}", Address::ZERO) => Some(st),
        _ => s.lens.vault_state(resolved).await.ok(),
    };

    let limit = qp_u64(&q, "events")?
        .unwrap_or(50)
        .clamp(1, MAX_VAULT_EVENTS);
    let events =
        s.db.vault_events_for(&format!("{resolved:#x}"), limit)
            .await?;
    let series = s.db.series_for_vault(&format!("{resolved:#x}")).await?;
    let series_json: Vec<Value> = series
        .iter()
        .map(|r| {
            json!({
                "id": r.id, "receipt": r.receipt, "start": r.start, "expiry": r.expiry,
                "sale_end": r.sale_end, "max_units": r.max_units, "unit_notional": r.unit_notional,
                "cap_variance": r.cap_variance, "issuance_stopped_at": r.issuance_stopped_at,
                "closed_at": r.closed_at,
            })
        })
        .collect();

    Ok(Json(json!({
        "requested": key,
        "vault": lens_vault.unwrap_or(format!("{resolved:#x}")),
        "exists": exists,
        "indexed": row,
        "state": vault_state,
        "series": series_json,
        "events": events,
    })))
}

/// A holder's indexed position in every series they have traded.
///
/// `indexed_units` and `indexed_cost` cover only fills this indexer saw for this address. A receipt
/// that arrived by plain ERC-20 transfer has no indexed cost, so `cost_basis_known` is false and the
/// UI shows an em dash rather than inventing an entry price.
async fn portfolio(State(s): S, Path(address): Path<String>) -> ApiResult<Json<Value>> {
    let holder = parse_address(&address)?;
    let key = format!("{holder:#x}");
    let mut positions = Vec::new();

    for row in s.db.series_all().await? {
        let fills = s.db.fills_for_taker(row.id, &key).await?;
        if fills.is_empty() {
            continue;
        }
        let mut units_bought = U256::ZERO;
        let mut quote_paid = U256::ZERO;
        let mut units_exited = U256::ZERO;
        let mut exit_proceeds = U256::ZERO;
        let mut units_settled = U256::ZERO;
        let mut settle_proceeds = U256::ZERO;
        for f in &fills {
            let units = U256::from_str(&f.units).unwrap_or(U256::ZERO);
            let quote = U256::from_str(&f.quote_amount).unwrap_or(U256::ZERO);
            match f.leg.as_str() {
                "issue" => {
                    units_bought = units_bought.saturating_add(units);
                    quote_paid = quote_paid.saturating_add(quote);
                }
                "exit" => {
                    units_exited = units_exited.saturating_add(units);
                    exit_proceeds = exit_proceeds.saturating_add(quote);
                }
                "settle" => {
                    units_settled = units_settled.saturating_add(units);
                    settle_proceeds = settle_proceeds.saturating_add(quote);
                }
                _ => {}
            }
        }
        let indexed_units = units_bought
            .saturating_sub(units_exited)
            .saturating_sub(units_settled);
        let entry = if units_bought.is_zero() {
            None
        } else {
            Some((quote_paid * U256::from(market::WAD) / units_bought).to_string())
        };
        positions.push(json!({
            "series_id": row.id,
            "receipt": row.receipt,
            "expiry": row.expiry,
            "units_bought": units_bought.to_string(),
            "units_exited": units_exited.to_string(),
            "units_settled": units_settled.to_string(),
            "indexed_units": indexed_units.to_string(),
            "indexed_cost": quote_paid.to_string(),
            "indexed_entry_per_unit": entry,
            "exit_proceeds": exit_proceeds.to_string(),
            "settlement_proceeds": settle_proceeds.to_string(),
            "cost_basis_known": !units_bought.is_zero(),
            "fills": fills.len(),
        }));
    }

    Ok(Json(json!({
        "holder": key,
        "positions": positions,
        "note": "indexed_* covers only fills this indexer saw for this address; receipts received by \
                 plain transfer have no indexed cost basis",
    })))
}

async fn series_list(State(s): S, Query(q): Q) -> ApiResult<Json<Vec<Value>>> {
    let limit = qp_u64(&q, "limit")?.unwrap_or(50).clamp(1, MAX_SERIES_PAGE);
    let offset = qp_u64(&q, "offset")?.unwrap_or(0);
    let rows = s.db.series_page(limit, offset).await?;
    if rows.is_empty() {
        return Ok(Json(vec![]));
    }
    let now = chain_now(&s).await?;
    let stats = s.db.fill_stats_all().await?;
    let empty = FillStats::default();
    let mut out = Vec::with_capacity(rows.len());
    for chunk in rows.chunks(8) {
        let futs = chunk
            .iter()
            .map(|r| series_summary(&s, r, now, stats.get(&r.id).unwrap_or(&empty)));
        out.extend(join_all(futs).await);
    }
    Ok(Json(out))
}

async fn series_detail(State(s): S, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let row = series_or_404(&s, &id).await?;
    let now = chain_now(&s).await?;
    let fills = s.db.fills_page(row.id, MAX_FILLS_PAGE, 0).await?;
    let stats = s.db.fill_stats(row.id).await?;
    let aqua = s.db.aqua_events_for(row.id).await?;
    let checkpoints = s.db.checkpoints_for(row.id).await?;
    let finalization = s.db.finalization_for(row.id).await?;
    let orders = s.db.orders_for(row.id).await?;
    let mut v = series_summary(&s, &row, now, &stats).await;
    if let Value::Object(m) = &mut v {
        m.insert(
            "fills".into(),
            serde_json::to_value(&fills).unwrap_or(Value::Null),
        );
        m.insert(
            "aqua_events".into(),
            serde_json::to_value(&aqua).unwrap_or(Value::Null),
        );
        m.insert(
            "checkpoints".into(),
            serde_json::to_value(&checkpoints).unwrap_or(Value::Null),
        );
        m.insert(
            "finalization".into(),
            serde_json::to_value(&finalization).unwrap_or(Value::Null),
        );
        m.insert(
            "orders".into(),
            json!(orders
                .iter()
                .map(|(hash, leg)| json!({ "order_hash": hash, "leg": leg }))
                .collect::<Vec<_>>()),
        );
    }
    Ok(Json(v))
}

async fn series_fills(
    State(s): S,
    Path(id): Path<String>,
    Query(q): Q,
) -> ApiResult<Json<Vec<FillRow>>> {
    let row = series_or_404(&s, &id).await?;
    let limit = qp_u64(&q, "limit")?.unwrap_or(200).clamp(1, MAX_FILLS_PAGE);
    let offset = qp_u64(&q, "offset")?.unwrap_or(0);
    Ok(Json(s.db.fills_page(row.id, limit, offset).await?))
}

async fn series_aqua(State(s): S, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let row = series_or_404(&s, &id).await?;
    Ok(Json(
        serde_json::to_value(s.db.aqua_events_for(row.id).await?).unwrap_or(Value::Null),
    ))
}

async fn series_checkpoints(State(s): S, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let row = series_or_404(&s, &id).await?;
    let checkpoints = s.db.checkpoints_for(row.id).await?;
    let finalization = s.db.finalization_for(row.id).await?;
    let interval = db_u64(row.sample_interval).max(1);
    let total = (db_u64(row.expiry).saturating_sub(db_u64(row.start))) / interval + 1;
    Ok(Json(json!({
        "series_id": row.id,
        "start": row.start,
        "expiry": row.expiry,
        "sample_interval": row.sample_interval,
        "samples_total": total,
        "checkpoints": checkpoints,
        "finalization": finalization,
    })))
}

/// The market chart: realized volatility, the market's own quote volatility, and the executable
/// bid/ask band, reconstructed at every point from indexed fills and checkpoints.
async fn series_market(State(s): S, Path(id): Path<String>, Query(q): Q) -> ApiResult<Json<Value>> {
    let row = series_or_404(&s, &id).await?;
    // Head time, not wall time: the last point on this chart sits next to a Lens quote on the page,
    // and the two must be computed at the same instant to agree.
    let now = chain_head_time(&s).await?;
    let params = market_params(&row);
    let fills = s.db.fills_for(row.id).await?;
    let flows = market_flows(&fills);
    let checkpoints = market_checkpoints(&s, row.id).await?;

    let from = qp_u64(&q, "from")?
        .unwrap_or(params.start)
        .max(params.start);
    let default_to = now.min(params.expiry).max(params.start);
    let to = qp_u64(&q, "to")?.unwrap_or(default_to).min(params.expiry);
    if to < from {
        return Err(ApiError::BadRequest("from must be <= to".into()));
    }
    let points = qp_u64(&q, "points")?
        .unwrap_or(MARKET_POINTS as u64)
        .clamp(2, 1_000) as usize;

    let path = market::path(&params, &flows, &checkpoints, from, to, points);
    // The last point is also available from the Lens, which is the executable authority. Serving both
    // makes any divergence visible instead of hidden.
    let lens = s.lens.state(db_u64(row.id)).await.ok();

    Ok(Json(json!({
        "series_id": row.id,
        "from": from,
        "to": to,
        "start": row.start,
        "expiry": row.expiry,
        "sale_end": row.sale_end,
        "sample_interval": row.sample_interval,
        "cap_variance": row.cap_variance,
        "max_payout_per_unit": lens.as_ref().map(|l| l.max_payout_per_unit.clone()),
        "points": path,
        "lens": lens,
        "source": "replica of contracts/src/libs/VariancePricing.sol; executable prices come from the lens field",
    })))
}

async fn series_variance(State(s): S, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let row = series_or_404(&s, &id).await?;
    let feed: Address = row
        .feed
        .parse()
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("bad feed address in db")))?;
    let now = chain_now(&s).await?;
    let start = db_u64(row.start);
    let expiry = db_u64(row.expiry);
    let interval = db_u64(row.sample_interval).max(1);
    let samples_total = (expiry.saturating_sub(start)) / interval;
    let end = now.min(expiry);
    let (samples, elapsed, end_aligned) = if end < start {
        (Vec::new(), 0u64, start)
    } else {
        let elapsed = ((end - start) / interval).min(samples_total);
        let end_aligned = start + elapsed * interval;
        (
            s.chainlink
                .sample(feed, start, end_aligned, interval)
                .await
                .map_err(feed_err)?,
            elapsed,
            end_aligned,
        )
    };
    let prices: Vec<f64> = samples
        .iter()
        .map(|x| x.round.price_f64(s.feed_decimals))
        .collect();
    let returns = rv::log_returns(&prices);
    let rv_val = rv::realized_variance(&prices, elapsed * interval);
    let vol_val = rv::vol(rv_val);
    let samples_json: Vec<Value> = samples
        .iter()
        .enumerate()
        .map(|(i, x)| {
            sample_json(
                x,
                s.feed_decimals,
                if i == 0 { None } else { Some(returns[i - 1]) },
            )
        })
        .collect();

    // On-chain parity: the checkpointed accumulator is the authority, this is the replica.
    let lens = s.lens.state(db_u64(row.id)).await.ok();

    Ok(Json(json!({
        "series_id": row.id,
        "feed": row.feed,
        "start": start,
        "expiry": expiry,
        "sample_interval": interval,
        "from": start,
        "to": end_aligned,
        "samples": samples_json,
        "rv_so_far": wad_string(rv_val),
        "vol_so_far": wad_string(vol_val),
        "rv_so_far_float": rv_val,
        "vol_so_far_float": vol_val,
        "samples_elapsed": elapsed,
        "samples_total": samples_total,
        "cap_variance": row.cap_variance,
        "chain_realized_variance_so_far": lens.as_ref().map(|l| l.realized_variance_so_far.clone()),
        "chain_final_variance": lens.as_ref().and_then(|l| {
            if l.status == "finalized" || l.status == "closed" {
                Some(l.final_variance.clone())
            } else {
                None
            }
        }),
        "chain_samples_stored": lens.as_ref().map(|l| l.samples_stored),
        "chain_samples_available": lens.as_ref().map(|l| l.samples_available),
        "chain_checkpoints_current": lens.as_ref().map(|l| l.checkpoints_current),
        "chain_status": lens.as_ref().map(|l| l.status),
        "phases_used": phases_used(&samples),
        "source": "replica of contracts/src/libs/RealizedVariance.sol",
    })))
}

/// Executable quotes for all three legs, straight from the Lens.
async fn series_quote(State(s): S, Path(id): Path<String>, Query(q): Q) -> ApiResult<Json<Value>> {
    let row = series_or_404(&s, &id).await?;
    let id = db_u64(row.id);
    let issue_usdc = qp_u256(&q, "issue_usdc")?;
    let issue_units = qp_u256(&q, "issue_units")?;
    let exit_units = qp_u256(&q, "exit_units")?;
    let settle_units = qp_u256(&q, "settle_units")?;
    if issue_usdc.is_none()
        && issue_units.is_none()
        && exit_units.is_none()
        && settle_units.is_none()
    {
        return Err(ApiError::BadRequest(
            "pass at least one of issue_usdc=<quote 6dec>, issue_units=<units 18dec>, \
             exit_units=<units 18dec>, settle_units=<units 18dec>"
                .into(),
        ));
    }
    // The leg flags travel with the quote so a zero cannot be mistaken for a price. A settlement
    // quote before finalization is zero because the payout is not yet known, which is a different
    // thing from a receipt being worthless.
    let legs = s.lens.state(id).await.ok();
    let mut out = json!({
        "series_id": id,
        "source": "lens",
        "issuance_open": legs.as_ref().map(|l| l.issuance_open),
        "exit_open": legs.as_ref().map(|l| l.exit_open),
        "settle_open": legs.as_ref().map(|l| l.settle_open),
        "status": legs.as_ref().map(|l| l.status),
    });
    if let Some(x) = issue_usdc {
        let (units, premium) = s.lens.quote_issue_exact_in(id, x).await.map_err(upstream)?;
        out["issue_exact_in"] = json!({
            "quote_in": x.to_string(), "units": units.to_string(), "premium": premium.to_string(),
        });
    }
    if let Some(u) = issue_units {
        let (filled, premium) = s
            .lens
            .quote_issue_exact_out(id, u)
            .await
            .map_err(upstream)?;
        out["issue_exact_out"] = json!({
            "units_requested": u.to_string(), "units_filled": filled.to_string(),
            "premium": premium.to_string(),
        });
    }
    if let Some(u) = exit_units {
        let (filled, quote_out) = s.lens.quote_exit_exact_in(id, u).await.map_err(upstream)?;
        out["exit_exact_in"] = json!({
            "units_requested": u.to_string(), "units_filled": filled.to_string(),
            "quote_out": quote_out.to_string(),
        });
    }
    if let Some(u) = settle_units {
        let (filled, quote_out) = s
            .lens
            .quote_settle_exact_in(id, u)
            .await
            .map_err(upstream)?;
        out["settle_exact_in"] = json!({
            "units_requested": u.to_string(), "units_filled": filled.to_string(),
            "quote_out": quote_out.to_string(),
        });
    }
    Ok(Json(out))
}

async fn variance_trailing(State(s): S, Query(q): Q) -> ApiResult<Json<Value>> {
    let window_str = q.get("window").cloned().unwrap_or_else(|| "7d".to_string());
    let window = parse_window(&window_str)
        .ok_or_else(|| ApiError::BadRequest("window must be like 1d, 7d, 30d or 12h".into()))?;
    let interval = qp_u64(&q, "interval")?.unwrap_or(3600);
    if interval == 0 || window % interval != 0 {
        return Err(ApiError::BadRequest(format!(
            "window ({window}s) must be a positive multiple of interval ({interval}s)"
        )));
    }
    let feed = qp_addr(&q, "feed")?.unwrap_or(s.manifest.feed);
    if feed != s.manifest.feed {
        return Err(ApiError::BadRequest(
            "only the configured feed is supported".into(),
        ));
    }
    if window / interval > MAX_HISTORY_POINTS {
        return Err(ApiError::BadRequest(format!(
            "too many samples (max {MAX_HISTORY_POINTS}); raise interval"
        )));
    }
    let to = match qp_u64(&q, "to")? {
        Some(t) => t,
        None => chain_now(&s).await?,
    };
    let from = to
        .checked_sub(window)
        .ok_or_else(|| ApiError::BadRequest("window larger than `to`".into()))?;
    let samples = s
        .chainlink
        .sample(feed, from, to, interval)
        .await
        .map_err(feed_err)?;
    let prices: Vec<f64> = samples
        .iter()
        .map(|x| x.round.price_f64(s.feed_decimals))
        .collect();
    let rv_val = rv::realized_variance(&prices, window);
    let vol_val = rv::vol(rv_val);
    Ok(Json(json!({
        "rv": wad_string(rv_val),
        "vol": wad_string(vol_val),
        "rv_float": rv_val,
        "vol_float": vol_val,
        "samples": samples.len(),
        "from": from,
        "to": to,
        "interval": interval,
        "window": window_str,
        "feed": format!("{feed:#x}"),
        "phases_used": phases_used(&samples),
        "first_round_id": samples.first().map(|x| x.round.round_id().to_string()),
        "last_round_id": samples.last().map(|x| x.round.round_id().to_string()),
        "first_price": prices.first().copied(),
        "last_price": prices.last().copied(),
    })))
}

async fn feed_history(State(s): S, Query(q): Q) -> ApiResult<Json<Vec<Value>>> {
    let interval = qp_u64(&q, "interval")?.unwrap_or(3600);
    if interval == 0 {
        return Err(ApiError::BadRequest("interval must be > 0".into()));
    }
    let to = match qp_u64(&q, "to")? {
        Some(t) => t,
        None => chain_now(&s).await?,
    };
    let from = qp_u64(&q, "from")?.unwrap_or_else(|| to.saturating_sub(7 * SECONDS_PER_DAY));
    if from > to {
        return Err(ApiError::BadRequest("from must be <= to".into()));
    }
    if (to - from) / interval + 1 > MAX_HISTORY_POINTS {
        return Err(ApiError::BadRequest(format!(
            "too many points (max {MAX_HISTORY_POINTS}); raise interval"
        )));
    }
    let feed = qp_addr(&q, "feed")?.unwrap_or(s.manifest.feed);
    if feed != s.manifest.feed {
        return Err(ApiError::BadRequest(
            "only the configured feed is supported".into(),
        ));
    }
    let samples = s
        .chainlink
        .sample(feed, from, to, interval)
        .await
        .map_err(feed_err)?;
    Ok(Json(
        samples
            .iter()
            .map(|x| json!({ "t": x.t, "price": x.round.price_f64(s.feed_decimals), "answer": x.round.answer.to_string(), "round_id": x.round.round_id().to_string() }))
            .collect(),
    ))
}

/// A gross sizing estimate for loss-versus-rebalancing, not a replicating hedge.
///
/// `E[LVR] ~= V * sigma^2 * T / 8` is an approximation for a constant-product pool under a diffusion.
/// The residual basis between that and a capped receipt on a Chainlink sample path is real and is not
/// bounded here.
async fn lvr(State(s): S, Query(q): Q) -> ApiResult<Json<Value>> {
    let pool_value = qp_f64(&q, "pool_value_usd")?
        .ok_or_else(|| ApiError::BadRequest("pool_value_usd is required".into()))?;
    let horizon_days = qp_f64(&q, "horizon_days")?
        .ok_or_else(|| ApiError::BadRequest("horizon_days is required".into()))?;
    if pool_value <= 0.0 || horizon_days <= 0.0 {
        return Err(ApiError::BadRequest(
            "pool_value_usd and horizon_days must be > 0".into(),
        ));
    }
    let window_str = q.get("window").cloned().unwrap_or_else(|| "7d".to_string());
    let window = parse_window(&window_str)
        .ok_or_else(|| ApiError::BadRequest("window must be like 1d, 7d, 30d".into()))?;
    let interval = qp_u64(&q, "interval")?.unwrap_or(3600);
    if interval == 0 || window % interval != 0 {
        return Err(ApiError::BadRequest(
            "window must be a positive multiple of interval".into(),
        ));
    }
    if window / interval > MAX_HISTORY_POINTS {
        return Err(ApiError::BadRequest(format!(
            "too many samples (max {MAX_HISTORY_POINTS}); raise interval"
        )));
    }
    let now = chain_now(&s).await?;
    let from = now - window;
    let samples = s
        .chainlink
        .sample(s.manifest.feed, from, now, interval)
        .await
        .map_err(feed_err)?;
    let prices: Vec<f64> = samples
        .iter()
        .map(|x| x.round.price_f64(s.feed_decimals))
        .collect();
    let variance = rv::realized_variance(&prices, window);
    let sigma = rv::vol(variance);
    let horizon_years = horizon_days / 365.0;
    let expected_lvr = pool_value * variance * horizon_years / 8.0;
    let budget = pool_value * horizon_years / 8.0;
    let mut hedge: BTreeMap<String, String> = BTreeMap::new();
    let mut hedge_f: BTreeMap<String, f64> = BTreeMap::new();
    for row in s.db.series_all().await? {
        if now >= db_u64(row.expiry) || row.closed_at.is_some() {
            continue;
        }
        let unit_notional_usd = row.unit_notional.parse::<f64>().unwrap_or(0.0) / 1e6;
        if unit_notional_usd <= 0.0 {
            continue;
        }
        let units = budget / unit_notional_usd;
        hedge.insert(row.id.to_string(), wad_string(units));
        hedge_f.insert(row.id.to_string(), units);
    }
    Ok(Json(json!({
        "sigma": sigma,
        "variance": variance,
        "expected_lvr_usd": expected_lvr,
        "pool_value_usd": pool_value,
        "horizon_days": horizon_days,
        "window": window_str,
        "from": from,
        "to": now,
        "hedge_units_for": hedge,
        "hedge_units_for_float": hedge_f,
        "caveat": "gross sizing estimate; realized variance of a Chainlink sample path is not the \
                   quadratic variation an AMM pays, and the residual basis is not bounded here",
    })))
}

async fn pairs_list(State(s): S) -> ApiResult<Json<Vec<PortfolioGroupRow>>> {
    Ok(Json(s.db.portfolio_groups_all().await?))
}

async fn pairs_detail(State(s): S, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let group_id = parse_id(&id)?;
    let row =
        s.db.portfolio_group_by_id(group_id)
            .await?
            .ok_or_else(|| ApiError::NotFound(format!("portfolio group {group_id} not found")))?;
    let events = s.db.portfolio_events_for_group(group_id, 200).await?;
    let checkpoints = s.db.portfolio_checkpoints_for_group(group_id).await?;

    let onchain_view = if s.manifest.portfolio_market != Address::ZERO {
        let market =
            crate::abi::TremorPortfolioMarket::new(s.manifest.portfolio_market, s.provider.clone());
        match market
            .groupView(alloy::primitives::U256::from(group_id))
            .call()
            .await
        {
            Ok(v) => Some(json!({
                "writer": format!("{:#x}", v.writer),
                "vault": format!("{:#x}", v.vault),
                "high_receipt": format!("{:#x}", v.highReceipt),
                "calm_receipt": format!("{:#x}", v.calmReceipt),
                "high_outstanding": v.highOutstanding.to_string(),
                "calm_outstanding": v.calmOutstanding.to_string(),
                "reserve_locked": v.reserveLocked.to_string(),
                "exit_buffer": v.exitBuffer.to_string(),
                "standalone_caps": v.standaloneCaps.to_string(),
                "finalized": v.finalized,
                "final_variance": v.finalVariance.to_string(),
                "x_wad": v.xWad.to_string(),
                "high_ppu": v.highPpu.to_string(),
                "calm_ppu": v.calmPpu.to_string(),
            })),
            Err(e) => {
                tracing::debug!(group_id, error = %e, "could not read groupView from chain");
                None
            }
        }
    } else {
        None
    };

    Ok(Json(json!({
        "group": row,
        "onchain": onchain_view,
        "events": events,
        "checkpoints": checkpoints,
    })))
}

async fn pairs_events(
    State(s): S,
    Path(id): Path<String>,
    Query(q): Q,
) -> ApiResult<Json<Vec<PortfolioEventRow>>> {
    let group_id = parse_id(&id)?;
    let limit = qp_u64(&q, "limit")?.unwrap_or(200).clamp(1, 1000);
    Ok(Json(
        s.db.portfolio_events_for_group(group_id, limit).await?,
    ))
}

async fn pairs_checkpoints(
    State(s): S,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<PortfolioCheckpointRow>>> {
    let group_id = parse_id(&id)?;
    Ok(Json(s.db.portfolio_checkpoints_for_group(group_id).await?))
}
