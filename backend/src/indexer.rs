//! Indexer task.
//!
//! Polls `eth_getLogs` from `deploymentBlock` in bounded chunks for
//!
//!   controller  VaultCreated, SeriesCreated, Issued, Exited, Settled, Finalized, IssuanceStopped,
//!               WorthlessBurned, SeriesClosed
//!   accumulator Checkpointed
//!   router      Swapped
//!   aqua        Shipped, Docked, Pulled, Pushed  (only where `app == router`)
//!   vaults      Deposited, FreeWithdrawn, LockedIncreased, LockedDecreased, ReceiptRegistered,
//!               StrategyShipped, StrategyDocked
//!
//! and maps `orderHash -> (series_id, leg)` so a `Swapped` can be attributed to ISSUE, EXIT or SETTLE.
//!
//! Vault addresses are discovered from `VaultCreated`, so each chunk is scanned twice: once for the
//! fixed addresses, then once for the vault set, which the first pass may have grown. That ordering
//! matters — a writer can create a vault and deposit into it in the same block.
//!
//! The cursor never advances over a log that failed to process, and a node reset (head below the
//! cursor, a changed block hash at the cursor, or a different manifest) triggers a full re-index.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use alloy::eips::BlockNumberOrTag;
use alloy::primitives::{Address, B256, U256};
use alloy::providers::Provider;
use alloy::rpc::types::{Filter, Log};
use alloy::sol_types::SolEvent;
use anyhow::{Context, Result};
use serde::Serialize;
use tokio::sync::RwLock;

use crate::abi::{
    Aqua, AquaSwapVMRouter, TremorMakerVault, TremorPortfolioMarket, VarianceAccumulator,
    VarianceSeriesFactory,
};
use crate::db::{
    AquaEventRow, CheckpointRow, FillRow, FinalizationRow, PortfolioCheckpointRow,
    PortfolioEventRow, PortfolioGroupRow, SeriesRow, VaultEventRow, VaultRow,
};
use crate::rpc::{retry, transport_retryable};
use crate::util::{nonnegative_u64, now_unix, sqlite_i64};
use crate::AppState;

pub const CHUNK_BLOCKS: u64 = 2000;

#[derive(Clone, Debug, Default, Serialize)]
pub struct IndexerStatus {
    pub chain_id: Option<u64>,
    pub head_block: Option<u64>,
    pub indexed_block: Option<u64>,
    pub series_count: u64,
    pub vault_count: u64,
    pub last_error: Option<String>,
    pub last_tick_at: Option<u64>,
    pub resets: u64,
}

#[derive(Clone)]
pub struct IndexerHandle(pub Arc<RwLock<IndexerStatus>>);

impl IndexerHandle {
    pub fn new(chain_id: Option<u64>) -> Self {
        Self(Arc::new(RwLock::new(IndexerStatus {
            chain_id,
            ..Default::default()
        })))
    }
    pub async fn snapshot(&self) -> IndexerStatus {
        self.0.read().await.clone()
    }
}

/// Which of a series' three Aqua strategies a fill belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Leg {
    Issue,
    Exit,
    Settle,
}

impl Leg {
    pub fn as_str(self) -> &'static str {
        match self {
            Leg::Issue => "issue",
            Leg::Exit => "exit",
            Leg::Settle => "settle",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "issue" => Some(Leg::Issue),
            "exit" => Some(Leg::Exit),
            "settle" => Some(Leg::Settle),
            _ => None,
        }
    }

    /// ISSUE takes the quote token in; the two burn legs take receipts in and pay the quote token out.
    pub fn quote_is_amount_in(self) -> bool {
        matches!(self, Leg::Issue)
    }
}

/// `orderHash` (== the Aqua `strategyHash`) → `(series_id, leg)`, built from `SeriesCreated`.
#[derive(Clone, Debug, Default)]
pub struct OrderMap {
    map: HashMap<B256, (u64, Leg)>,
    series: HashSet<u64>,
}

impl OrderMap {
    pub fn insert_series(&mut self, id: u64, issue: B256, exit: B256, settle: B256) {
        self.map.insert(issue, (id, Leg::Issue));
        self.map.insert(exit, (id, Leg::Exit));
        self.map.insert(settle, (id, Leg::Settle));
        self.series.insert(id);
    }

    pub fn insert_one(&mut self, hash: B256, id: u64, leg: Leg) {
        self.map.insert(hash, (id, leg));
        self.series.insert(id);
    }

    pub fn lookup(&self, hash: &B256) -> Option<(u64, Leg)> {
        self.map.get(hash).copied()
    }

    pub fn series_count(&self) -> u64 {
        self.series.len() as u64
    }

    pub fn from_rows(rows: &[(String, i64, String)]) -> Self {
        let mut m = Self::default();
        for (hash, id, leg) in rows {
            if let (Ok(h), Some(leg)) = (hash.parse::<B256>(), Leg::parse(leg)) {
                m.insert_one(h, *id as u64, leg);
            }
        }
        m
    }
}

/// Inclusive block ranges of at most `size` blocks covering `from..=to`.
pub fn block_chunks(from: u64, to: u64, size: u64) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    if from > to || size == 0 {
        return out;
    }
    let mut a = from;
    while a <= to {
        let b = a.saturating_add(size - 1).min(to);
        out.push((a, b));
        if b == u64::MAX {
            break;
        }
        a = b + 1;
    }
    out
}

/// Quote base units paid or received per 1e18 receipt units.
pub fn price_per_unit(quote: U256, units: U256) -> U256 {
    if units.is_zero() {
        U256::ZERO
    } else {
        quote * U256::from(1_000_000_000_000_000_000u128) / units
    }
}

fn hex_addr(a: Address) -> String {
    format!("{a:#x}")
}

fn hex_b256(h: B256) -> String {
    format!("{h:#x}")
}

pub async fn run(state: Arc<AppState>) {
    let mut order_map = match state.db.orders_all().await {
        Ok(rows) => OrderMap::from_rows(&rows),
        Err(e) => {
            tracing::warn!(error = %e, "could not rebuild the order map from sqlite");
            OrderMap::default()
        }
    };
    let mut vaults: HashSet<Address> = match state.db.vaults_all().await {
        Ok(rows) => rows.iter().filter_map(|v| v.address.parse().ok()).collect(),
        Err(e) => {
            tracing::warn!(error = %e, "could not rebuild the vault set from sqlite");
            HashSet::new()
        }
    };
    if order_map.series_count() > 0 || !vaults.is_empty() {
        tracing::info!(
            series = order_map.series_count(),
            vaults = vaults.len(),
            "index restored from sqlite"
        );
    }
    let poll = Duration::from_millis(state.cfg.poll_ms.max(250));
    loop {
        match tick(&state, &mut order_map, &mut vaults).await {
            Ok(()) => state.indexer.0.write().await.last_error = None,
            Err(e) => {
                tracing::warn!(error = format!("{e:#}"), "indexer tick failed");
                state.indexer.0.write().await.last_error = Some(format!("{e:#}"));
            }
        }
        tokio::time::sleep(poll).await;
    }
}

async fn block_hash(state: &AppState, n: u64) -> Result<Option<String>> {
    let p = &state.provider;
    let b = retry("eth_getBlockByNumber", transport_retryable, || async {
        p.get_block_by_number(BlockNumberOrTag::Number(n)).await
    })
    .await
    .with_context(|| format!("eth_getBlockByNumber({n})"))?;
    Ok(b.map(|b| format!("{:#x}", b.header.hash)))
}

fn controller_topics() -> Vec<B256> {
    vec![
        VarianceSeriesFactory::VaultCreated::SIGNATURE_HASH,
        VarianceSeriesFactory::SeriesCreated::SIGNATURE_HASH,
        VarianceSeriesFactory::Issued::SIGNATURE_HASH,
        VarianceSeriesFactory::Exited::SIGNATURE_HASH,
        VarianceSeriesFactory::Settled::SIGNATURE_HASH,
        VarianceSeriesFactory::Finalized::SIGNATURE_HASH,
        VarianceSeriesFactory::IssuanceStopped::SIGNATURE_HASH,
        VarianceSeriesFactory::WorthlessBurned::SIGNATURE_HASH,
        VarianceSeriesFactory::SeriesClosed::SIGNATURE_HASH,
        VarianceAccumulator::Checkpointed::SIGNATURE_HASH,
        AquaSwapVMRouter::Swapped::SIGNATURE_HASH,
        Aqua::Shipped::SIGNATURE_HASH,
        Aqua::Docked::SIGNATURE_HASH,
        Aqua::Pulled::SIGNATURE_HASH,
        Aqua::Pushed::SIGNATURE_HASH,
        TremorPortfolioMarket::GroupCreated::SIGNATURE_HASH,
        TremorPortfolioMarket::PortfolioIssued::SIGNATURE_HASH,
        TremorPortfolioMarket::PortfolioExited::SIGNATURE_HASH,
        TremorPortfolioMarket::PortfolioSettled::SIGNATURE_HASH,
        TremorPortfolioMarket::GroupFinalized::SIGNATURE_HASH,
        TremorPortfolioMarket::ExitBufferFunded::SIGNATURE_HASH,
        TremorPortfolioMarket::ExitBufferWithdrawn::SIGNATURE_HASH,
        TremorPortfolioMarket::WorthlessBurned::SIGNATURE_HASH,
    ]
}

fn vault_topics() -> Vec<B256> {
    vec![
        TremorMakerVault::Deposited::SIGNATURE_HASH,
        TremorMakerVault::FreeWithdrawn::SIGNATURE_HASH,
        TremorMakerVault::LockedIncreased::SIGNATURE_HASH,
        TremorMakerVault::LockedDecreased::SIGNATURE_HASH,
        TremorMakerVault::ReceiptRegistered::SIGNATURE_HASH,
        TremorMakerVault::StrategyShipped::SIGNATURE_HASH,
        TremorMakerVault::StrategyDocked::SIGNATURE_HASH,
    ]
}

async fn tick(
    state: &AppState,
    order_map: &mut OrderMap,
    vaults: &mut HashSet<Address>,
) -> Result<()> {
    let provider = &state.provider;
    let m = &state.manifest;

    let head = retry("eth_blockNumber", transport_retryable, || async {
        provider.get_block_number().await
    })
    .await
    .context("eth_blockNumber")?;

    let chain_id = {
        let known = state.indexer.0.read().await.chain_id;
        match known {
            Some(c) => Some(c),
            None => {
                let c = provider.get_chain_id().await.ok();
                state.indexer.0.write().await.chain_id = c;
                c
            }
        }
    };

    let mut cursor = state.db.cursor().await?;
    if let Some(c) = &cursor {
        let mut reason: Option<&str> = None;
        let cursor_deployment = nonnegative_u64(c.deployment_block, "cursor deployment block")?;
        let cursor_block = nonnegative_u64(c.last_block, "cursor last block")?;
        if cursor_deployment != m.deployment_block || c.controller != hex_addr(m.series_factory) {
            reason = Some("deployment manifest changed");
        } else if head < cursor_block {
            reason = Some("head is below the cursor (node reset)");
        } else if let Some(stored) = &c.last_block_hash {
            if let Some(onchain) = block_hash(state, cursor_block).await? {
                if &onchain != stored {
                    reason = Some("block hash at the cursor changed (node reset / reorg)");
                }
            }
        }
        if let Some(reason) = reason {
            tracing::warn!(
                reason,
                cursor = c.last_block,
                head,
                deployment_block = m.deployment_block,
                "resetting index"
            );
            state.db.reset_chain_state().await?;
            *order_map = OrderMap::default();
            vaults.clear();
            cursor = None;
            let mut st = state.indexer.0.write().await;
            st.resets += 1;
            st.indexed_block = None;
            st.series_count = 0;
            st.vault_count = 0;
        }
    }

    let start = match cursor.as_ref() {
        Some(c) => nonnegative_u64(c.last_block, "cursor last block")?
            .checked_add(1)
            .context("cursor block overflow")?,
        None => m.deployment_block,
    };
    {
        let mut st = state.indexer.0.write().await;
        st.head_block = Some(head);
        st.last_tick_at = Some(now_unix());
        if let Some(c) = &cursor {
            st.indexed_block = Some(nonnegative_u64(c.last_block, "cursor last block")?);
        }
    }
    if start > head {
        return Ok(());
    }

    let mut fixed = vec![m.series_factory, m.accumulator, m.router, m.aqua];
    if m.portfolio_market != Address::ZERO {
        fixed.push(m.portfolio_market);
    }
    if m.portfolio_accumulator != Address::ZERO {
        fixed.push(m.portfolio_accumulator);
    }
    let fixed_topics = controller_topics();
    let vault_event_topics = vault_topics();

    for (from, to) in block_chunks(start, head, CHUNK_BLOCKS) {
        let mut ts_cache: HashMap<u64, u64> = HashMap::new();

        // Pass 1: the fixed addresses. This is what discovers new vaults.
        let filter = Filter::new()
            .address(fixed.clone())
            .from_block(from)
            .to_block(to)
            .event_signature(fixed_topics.clone());
        let mut logs = retry("eth_getLogs", transport_retryable, || async {
            provider.get_logs(&filter).await
        })
        .await
        .with_context(|| format!("eth_getLogs {from}..={to}"))?;
        logs.sort_by_key(|l| (l.block_number.unwrap_or(0), l.log_index.unwrap_or(0)));
        for log in &logs {
            process_log(state, order_map, vaults, log, &mut ts_cache)
                .await
                .with_context(|| {
                    format!(
                        "processing log {:?}; cursor not advanced",
                        log.transaction_hash
                    )
                })?;
        }

        // Pass 2: the vaults, including any the first pass just found.
        let mut vault_log_count = 0usize;
        if !vaults.is_empty() {
            let addresses: Vec<Address> = vaults.iter().copied().collect();
            let vfilter = Filter::new()
                .address(addresses)
                .from_block(from)
                .to_block(to)
                .event_signature(vault_event_topics.clone());
            let mut vlogs = retry("eth_getLogs(vaults)", transport_retryable, || async {
                provider.get_logs(&vfilter).await
            })
            .await
            .with_context(|| format!("eth_getLogs vaults {from}..={to}"))?;
            vlogs.sort_by_key(|l| (l.block_number.unwrap_or(0), l.log_index.unwrap_or(0)));
            vault_log_count = vlogs.len();
            for log in &vlogs {
                process_vault_log(state, log, &mut ts_cache)
                    .await
                    .with_context(|| {
                        format!(
                            "processing vault log {:?}; cursor not advanced",
                            log.transaction_hash
                        )
                    })?;
            }
        }

        let hash = block_hash(state, to).await?;
        state
            .db
            .set_cursor(to, hash, m.deployment_block, m.series_factory, chain_id)
            .await?;
        {
            let mut st = state.indexer.0.write().await;
            st.indexed_block = Some(to);
            st.series_count = order_map.series_count();
            st.vault_count = vaults.len() as u64;
        }
        if !logs.is_empty() || vault_log_count > 0 {
            tracing::info!(
                from,
                to,
                logs = logs.len(),
                vault_logs = vault_log_count,
                "indexed chunk"
            );
        } else {
            tracing::debug!(from, to, "indexed empty chunk");
        }
    }
    Ok(())
}

async fn block_timestamp(
    state: &AppState,
    log: &Log,
    block: u64,
    cache: &mut HashMap<u64, u64>,
) -> Result<u64> {
    if let Some(ts) = log.block_timestamp {
        return Ok(ts);
    }
    if let Some(ts) = cache.get(&block) {
        return Ok(*ts);
    }
    let p = &state.provider;
    let b = retry("eth_getBlockByNumber", transport_retryable, || async {
        p.get_block_by_number(BlockNumberOrTag::Number(block)).await
    })
    .await
    .with_context(|| format!("eth_getBlockByNumber({block})"))?
    .with_context(|| format!("block {block} not found"))?;
    let ts = b.header.timestamp;
    cache.insert(block, ts);
    Ok(ts)
}

/// Common log identity: block, tx hash, log index, timestamp.
struct LogMeta {
    block: i64,
    tx_hash: String,
    log_index: i64,
    timestamp: i64,
}

async fn log_meta(state: &AppState, log: &Log, cache: &mut HashMap<u64, u64>) -> Result<LogMeta> {
    let block = log.block_number.context("log without block number")?;
    Ok(LogMeta {
        block: sqlite_i64(block, "log block")?,
        tx_hash: log.transaction_hash.map(hex_b256).unwrap_or_default(),
        log_index: sqlite_i64(log.log_index.unwrap_or(0), "log index")?,
        timestamp: sqlite_i64(
            block_timestamp(state, log, block, cache).await?,
            "block timestamp",
        )?,
    })
}

async fn process_log(
    state: &AppState,
    order_map: &mut OrderMap,
    vaults: &mut HashSet<Address>,
    log: &Log,
    ts_cache: &mut HashMap<u64, u64>,
) -> Result<()> {
    let m = &state.manifest;
    let addr = log.inner.address;
    let Some(topic0) = log.inner.data.topics().first().copied() else {
        return Ok(());
    };
    let meta = log_meta(state, log, ts_cache).await?;

    if addr == m.series_factory {
        return process_controller_log(state, order_map, vaults, log, topic0, &meta).await;
    }
    if addr == m.accumulator && topic0 == VarianceAccumulator::Checkpointed::SIGNATURE_HASH {
        let ev = log
            .log_decode::<VarianceAccumulator::Checkpointed>()
            .context("decode Checkpointed")?
            .inner
            .data;
        let row = CheckpointRow {
            tx_hash: meta.tx_hash.clone(),
            log_index: meta.log_index,
            block: meta.block,
            timestamp: meta.timestamp,
            series_id: sqlite_i64(
                u64::try_from(ev.seriesId).context("series id")?,
                "series id",
            )?,
            from_sample: sqlite_i64(
                u64::try_from(ev.fromSample).context("from sample")?,
                "from sample",
            )?,
            to_sample: sqlite_i64(
                u64::try_from(ev.toSample).context("to sample")?,
                "to sample",
            )?,
            processed_through: sqlite_i64(ev.processedThrough.to::<u64>(), "processed through")?,
            last_round_id: ev.lastRoundId.to_string(),
            sum_squared_returns: ev.sumSquaredReturnsWad.to_string(),
        };
        tracing::info!(
            series_id = row.series_id,
            from = row.from_sample,
            to = row.to_sample,
            "Checkpointed"
        );
        state.db.insert_checkpoint(&row).await?;
        return Ok(());
    }
    if addr == m.portfolio_accumulator
        && topic0 == VarianceAccumulator::Checkpointed::SIGNATURE_HASH
    {
        let ev = log
            .log_decode::<VarianceAccumulator::Checkpointed>()
            .context("decode portfolio Checkpointed")?
            .inner
            .data;
        let row = PortfolioCheckpointRow {
            tx_hash: meta.tx_hash.clone(),
            log_index: meta.log_index,
            block: meta.block,
            timestamp: meta.timestamp,
            group_id: sqlite_i64(u64::try_from(ev.seriesId).context("group id")?, "group id")?,
            from_sample: sqlite_i64(
                u64::try_from(ev.fromSample).context("from sample")?,
                "from sample",
            )?,
            to_sample: sqlite_i64(
                u64::try_from(ev.toSample).context("to sample")?,
                "to sample",
            )?,
            processed_through: sqlite_i64(ev.processedThrough.to::<u64>(), "processed through")?,
            last_round_id: ev.lastRoundId.to_string(),
            sum_squared_returns: ev.sumSquaredReturnsWad.to_string(),
        };
        tracing::info!(
            group_id = row.group_id,
            from = row.from_sample,
            to = row.to_sample,
            "Portfolio Checkpointed"
        );
        state.db.insert_portfolio_checkpoint(&row).await?;
        return Ok(());
    }
    if addr == m.portfolio_market {
        return process_portfolio_market_log(state, vaults, log, topic0, &meta).await;
    }
    if addr == m.router && topic0 == AquaSwapVMRouter::Swapped::SIGNATURE_HASH {
        return process_swap(state, order_map, log, &meta).await;
    }
    if addr == m.aqua {
        return process_aqua(state, order_map, log, topic0, &meta).await;
    }
    Ok(())
}

async fn process_controller_log(
    state: &AppState,
    order_map: &mut OrderMap,
    vaults: &mut HashSet<Address>,
    log: &Log,
    topic0: B256,
    meta: &LogMeta,
) -> Result<()> {
    if topic0 == VarianceSeriesFactory::VaultCreated::SIGNATURE_HASH {
        let ev = log
            .log_decode::<VarianceSeriesFactory::VaultCreated>()
            .context("decode VaultCreated")?
            .inner
            .data;
        let row = VaultRow {
            address: hex_addr(ev.vault),
            writer: hex_addr(ev.writer),
            quote_token: hex_addr(ev.quoteToken),
            created_block: meta.block,
            created_tx: meta.tx_hash.clone(),
            created_at: meta.timestamp,
            deposited: "0".into(),
            withdrawn: "0".into(),
            last_balance: None,
            last_locked: None,
            last_event_at: None,
        };
        state.db.insert_vault(&row).await?;
        vaults.insert(ev.vault);
        tracing::info!(vault = %row.address, writer = %row.writer, "VaultCreated");
        return Ok(());
    }

    if topic0 == VarianceSeriesFactory::SeriesCreated::SIGNATURE_HASH {
        let ev = log
            .log_decode::<VarianceSeriesFactory::SeriesCreated>()
            .context("decode SeriesCreated")?
            .inner
            .data;
        let id = u64::try_from(ev.seriesId).context("series id exceeds u64")?;
        let p = &ev.params;
        let row = SeriesRow {
            id: sqlite_i64(id, "series id")?,
            writer: hex_addr(ev.writer),
            vault: hex_addr(ev.vault),
            receipt: hex_addr(ev.receipt),
            issue_order_hash: hex_b256(ev.issueOrderHash),
            exit_order_hash: hex_b256(ev.exitOrderHash),
            settlement_order_hash: hex_b256(ev.settlementOrderHash),
            feed: hex_addr(p.feed),
            quote_token: hex_addr(p.quoteToken),
            start: sqlite_i64(p.start.to::<u64>(), "series start")?,
            expiry: sqlite_i64(p.expiry.to::<u64>(), "series expiry")?,
            sale_end: sqlite_i64(p.saleEnd.to::<u64>(), "series sale end")?,
            sample_interval: p.sampleInterval as i64,
            unit_notional: p.unitNotional.to_string(),
            cap_variance: p.capVariance.to_string(),
            anchor_variance: p.anchorVariance.to_string(),
            impact_per_unit: p.impactPerUnit.to_string(),
            half_life: p.halfLife as i64,
            half_spread_bps: p.halfSpreadBps as i64,
            max_units: p.maxUnits.to_string(),
            created_block: meta.block,
            created_tx: meta.tx_hash.clone(),
            created_at: meta.timestamp,
            issuance_stopped_at: None,
            closed_at: None,
        };
        state.db.insert_series(&row).await?;
        state
            .db
            .insert_order(
                &row.issue_order_hash,
                row.id,
                Leg::Issue.as_str(),
                &row.vault,
            )
            .await?;
        state
            .db
            .insert_order(&row.exit_order_hash, row.id, Leg::Exit.as_str(), &row.vault)
            .await?;
        state
            .db
            .insert_order(
                &row.settlement_order_hash,
                row.id,
                Leg::Settle.as_str(),
                &row.vault,
            )
            .await?;
        order_map.insert_series(
            id,
            ev.issueOrderHash,
            ev.exitOrderHash,
            ev.settlementOrderHash,
        );
        vaults.insert(ev.vault);
        tracing::info!(id, writer = %row.writer, vault = %row.vault, receipt = %row.receipt, "SeriesCreated");
        return Ok(());
    }

    if topic0 == VarianceSeriesFactory::Finalized::SIGNATURE_HASH {
        let ev = log
            .log_decode::<VarianceSeriesFactory::Finalized>()
            .context("decode Finalized")?
            .inner
            .data;
        let row = FinalizationRow {
            series_id: sqlite_i64(
                u64::try_from(ev.seriesId).context("series id")?,
                "series id",
            )?,
            tx_hash: meta.tx_hash.clone(),
            block: meta.block,
            timestamp: meta.timestamp,
            final_variance: ev.finalVariance.to_string(),
            capped_variance: ev.cappedVariance.to_string(),
            payout_per_unit: ev.payoutPerUnit.to_string(),
            outstanding_units: ev.outstandingUnits.to_string(),
            released_collateral: ev.releasedCollateral.to_string(),
        };
        tracing::info!(
            series_id = row.series_id,
            final_variance = %row.final_variance,
            payout_per_unit = %row.payout_per_unit,
            "Finalized"
        );
        state.db.insert_finalization(&row).await?;
        return Ok(());
    }

    if topic0 == VarianceSeriesFactory::IssuanceStopped::SIGNATURE_HASH {
        let ev = log
            .log_decode::<VarianceSeriesFactory::IssuanceStopped>()
            .context("decode IssuanceStopped")?
            .inner
            .data;
        let id = sqlite_i64(
            u64::try_from(ev.seriesId).context("series id")?,
            "series id",
        )?;
        state.db.mark_issuance_stopped(id, meta.timestamp).await?;
        tracing::info!(series_id = id, "IssuanceStopped");
        return Ok(());
    }

    if topic0 == VarianceSeriesFactory::SeriesClosed::SIGNATURE_HASH {
        let ev = log
            .log_decode::<VarianceSeriesFactory::SeriesClosed>()
            .context("decode SeriesClosed")?
            .inner
            .data;
        let id = sqlite_i64(
            u64::try_from(ev.seriesId).context("series id")?,
            "series id",
        )?;
        state.db.mark_closed(id, meta.timestamp).await?;
        tracing::info!(series_id = id, "SeriesClosed");
        return Ok(());
    }

    // `Issued`, `Exited`, `Settled` and `WorthlessBurned` are the controller's own record of what a
    // fill did. The fill row itself comes from the router's `Swapped`, which carries the order hash;
    // these are logged for the record and left to the Lens for current state, so there is exactly one
    // writer of the fills table.
    if topic0 == VarianceSeriesFactory::WorthlessBurned::SIGNATURE_HASH {
        let ev = log
            .log_decode::<VarianceSeriesFactory::WorthlessBurned>()
            .context("decode WorthlessBurned")?
            .inner
            .data;
        tracing::info!(
            series_id = %ev.seriesId,
            holder = %ev.holder,
            units = %ev.units,
            "WorthlessBurned"
        );
    }
    Ok(())
}

async fn process_portfolio_market_log(
    state: &AppState,
    vaults: &mut HashSet<Address>,
    log: &Log,
    topic0: B256,
    meta: &LogMeta,
) -> Result<()> {
    if topic0 == TremorPortfolioMarket::VaultCreated::SIGNATURE_HASH {
        let ev = log
            .log_decode::<TremorPortfolioMarket::VaultCreated>()
            .context("decode portfolio VaultCreated")?
            .inner
            .data;
        let row = VaultRow {
            address: hex_addr(ev.vault),
            writer: hex_addr(ev.writer),
            quote_token: hex_addr(state.manifest.usdc),
            created_block: meta.block,
            created_tx: meta.tx_hash.clone(),
            created_at: meta.timestamp,
            deposited: "0".into(),
            withdrawn: "0".into(),
            last_balance: None,
            last_locked: None,
            last_event_at: None,
        };
        state.db.insert_vault(&row).await?;
        vaults.insert(ev.vault);
        tracing::info!(vault = %row.address, writer = %row.writer, "Portfolio VaultCreated");
        return Ok(());
    }

    if topic0 == TremorPortfolioMarket::GroupCreated::SIGNATURE_HASH {
        let ev = log
            .log_decode::<TremorPortfolioMarket::GroupCreated>()
            .context("decode GroupCreated")?
            .inner
            .data;
        let id = u64::try_from(ev.groupId).context("group id exceeds u64")?;
        let p = &ev.params;
        let row = PortfolioGroupRow {
            id: sqlite_i64(id, "group id")?,
            writer: hex_addr(ev.writer),
            vault: hex_addr(ev.vault),
            high_receipt: hex_addr(ev.highReceipt),
            calm_receipt: hex_addr(ev.calmReceipt),
            feed: hex_addr(p.feed),
            quote_token: hex_addr(p.quoteToken),
            start: sqlite_i64(p.start.to::<u64>(), "group start")?,
            expiry: sqlite_i64(p.expiry.to::<u64>(), "group expiry")?,
            sale_end: sqlite_i64(p.saleEnd.to::<u64>(), "group sale end")?,
            sample_interval: p.sampleInterval as i64,
            cap_variance: p.capVariance.to_string(),
            cap_payout_per_unit: p.capPayoutPerUnit.to_string(),
            max_units_per_side: p.maxUnitsPerSide.to_string(),
            ask_high: p.askHigh.to_string(),
            bid_high: p.bidHigh.to_string(),
            ask_calm: p.askCalm.to_string(),
            bid_calm: p.bidCalm.to_string(),
            high_outstanding: "0".into(),
            calm_outstanding: "0".into(),
            reserve_locked: "0".into(),
            exit_buffer: "0".into(),
            finalized: 0,
            final_variance: None,
            high_ppu: None,
            calm_ppu: None,
            created_block: meta.block,
            created_tx: meta.tx_hash.clone(),
            created_at: meta.timestamp,
        };
        state.db.insert_portfolio_group(&row).await?;
        vaults.insert(ev.vault);
        tracing::info!(id, writer = %row.writer, vault = %row.vault, "GroupCreated");
        return Ok(());
    }

    if topic0 == TremorPortfolioMarket::PortfolioIssued::SIGNATURE_HASH {
        let ev = log
            .log_decode::<TremorPortfolioMarket::PortfolioIssued>()
            .context("decode PortfolioIssued")?
            .inner
            .data;
        let group_id = sqlite_i64(u64::try_from(ev.groupId).context("group id")?, "group id")?;
        let side = if ev.high { "high" } else { "calm" };
        let event_row = PortfolioEventRow {
            id: 0,
            group_id,
            event_type: "issued".into(),
            actor: Some(hex_addr(ev.buyer)),
            side: Some(side.into()),
            units: ev.units.to_string(),
            amount: ev.premium.to_string(),
            new_outstanding: Some(if ev.high {
                ev.highOutstanding.to_string()
            } else {
                ev.calmOutstanding.to_string()
            }),
            new_reserve: Some(ev.reserveLocked.to_string()),
            new_buffer: None,
            block_number: meta.block,
            tx_hash: meta.tx_hash.clone(),
            log_index: meta.log_index,
            timestamp: meta.timestamp,
        };
        let inserted = state.db.insert_portfolio_event(&event_row).await?;
        if inserted {
            state
                .db
                .update_portfolio_group_balances(
                    group_id,
                    Some(&ev.highOutstanding.to_string()),
                    Some(&ev.calmOutstanding.to_string()),
                    Some(&ev.reserveLocked.to_string()),
                    None,
                )
                .await?;
        }
        tracing::info!(group_id, side, units = %ev.units, premium = %ev.premium, "PortfolioIssued");
        return Ok(());
    }

    if topic0 == TremorPortfolioMarket::PortfolioExited::SIGNATURE_HASH {
        let ev = log
            .log_decode::<TremorPortfolioMarket::PortfolioExited>()
            .context("decode PortfolioExited")?
            .inner
            .data;
        let group_id = sqlite_i64(u64::try_from(ev.groupId).context("group id")?, "group id")?;
        let side = if ev.high { "high" } else { "calm" };
        let event_row = PortfolioEventRow {
            id: 0,
            group_id,
            event_type: "exited".into(),
            actor: Some(hex_addr(ev.holder)),
            side: Some(side.into()),
            units: ev.units.to_string(),
            amount: ev.amountOut.to_string(),
            new_outstanding: None,
            new_reserve: Some(ev.reserveLocked.to_string()),
            new_buffer: None,
            block_number: meta.block,
            tx_hash: meta.tx_hash.clone(),
            log_index: meta.log_index,
            timestamp: meta.timestamp,
        };
        let inserted = state.db.insert_portfolio_event(&event_row).await?;
        if inserted {
            state
                .db
                .deduct_portfolio_units(
                    group_id,
                    ev.high,
                    &ev.units.to_string(),
                    &ev.reserveLocked.to_string(),
                    Some(&ev.bufferDrawn.to_string()),
                )
                .await?;
        }
        tracing::info!(group_id, side, units = %ev.units, amount_out = %ev.amountOut, "PortfolioExited");
        return Ok(());
    }

    if topic0 == TremorPortfolioMarket::PortfolioSettled::SIGNATURE_HASH {
        let ev = log
            .log_decode::<TremorPortfolioMarket::PortfolioSettled>()
            .context("decode PortfolioSettled")?
            .inner
            .data;
        let group_id = sqlite_i64(u64::try_from(ev.groupId).context("group id")?, "group id")?;
        let side = if ev.high { "high" } else { "calm" };
        let event_row = PortfolioEventRow {
            id: 0,
            group_id,
            event_type: "settled".into(),
            actor: Some(hex_addr(ev.holder)),
            side: Some(side.into()),
            units: ev.units.to_string(),
            amount: ev.amountOut.to_string(),
            new_outstanding: None,
            new_reserve: Some(ev.reserveLocked.to_string()),
            new_buffer: None,
            block_number: meta.block,
            tx_hash: meta.tx_hash.clone(),
            log_index: meta.log_index,
            timestamp: meta.timestamp,
        };
        let inserted = state.db.insert_portfolio_event(&event_row).await?;
        if inserted {
            state
                .db
                .deduct_portfolio_units(
                    group_id,
                    ev.high,
                    &ev.units.to_string(),
                    &ev.reserveLocked.to_string(),
                    None,
                )
                .await?;
        }
        tracing::info!(group_id, side, units = %ev.units, amount_out = %ev.amountOut, "PortfolioSettled");
        return Ok(());
    }

    if topic0 == TremorPortfolioMarket::GroupFinalized::SIGNATURE_HASH {
        let ev = log
            .log_decode::<TremorPortfolioMarket::GroupFinalized>()
            .context("decode GroupFinalized")?
            .inner
            .data;
        let group_id = sqlite_i64(u64::try_from(ev.groupId).context("group id")?, "group id")?;
        let final_var = ev.finalVariance.to_string();
        let high_ppu = ev.highPayoutPerUnit.to_string();
        let calm_ppu = ev.calmPayoutPerUnit.to_string();
        let rel_collateral = ev.releasedCollateral.to_string();

        let group_opt = state.db.portfolio_group_by_id(group_id).await?;
        let final_reserve = if let Some(g) = &group_opt {
            let h_units: U256 = g.high_outstanding.parse().unwrap_or_default();
            let c_units: U256 = g.calm_outstanding.parse().unwrap_or_default();
            let wad = U256::from(1_000_000_000_000_000_000u128);
            let h_liab = h_units * ev.highPayoutPerUnit / wad;
            let c_liab = c_units * ev.calmPayoutPerUnit / wad;
            (h_liab + c_liab).to_string()
        } else {
            "0".to_string()
        };

        state
            .db
            .finalize_portfolio_group(group_id, &final_var, &high_ppu, &calm_ppu, &final_reserve)
            .await?;

        let event_row = PortfolioEventRow {
            id: 0,
            group_id,
            event_type: "finalized".into(),
            actor: None,
            side: None,
            units: "0".into(),
            amount: rel_collateral,
            new_outstanding: None,
            new_reserve: None,
            new_buffer: None,
            block_number: meta.block,
            tx_hash: meta.tx_hash.clone(),
            log_index: meta.log_index,
            timestamp: meta.timestamp,
        };
        state.db.insert_portfolio_event(&event_row).await?;
        tracing::info!(group_id, final_var = %final_var, high_ppu = %high_ppu, calm_ppu = %calm_ppu, "GroupFinalized");
        return Ok(());
    }

    if topic0 == TremorPortfolioMarket::ExitBufferFunded::SIGNATURE_HASH {
        let ev = log
            .log_decode::<TremorPortfolioMarket::ExitBufferFunded>()
            .context("decode ExitBufferFunded")?
            .inner
            .data;
        let group_id = sqlite_i64(u64::try_from(ev.groupId).context("group id")?, "group id")?;
        let new_buf = ev.newBuffer.to_string();
        let event_row = PortfolioEventRow {
            id: 0,
            group_id,
            event_type: "buffer_funded".into(),
            actor: Some(hex_addr(ev.payer)),
            side: None,
            units: "0".into(),
            amount: ev.amount.to_string(),
            new_outstanding: None,
            new_reserve: None,
            new_buffer: Some(new_buf.clone()),
            block_number: meta.block,
            tx_hash: meta.tx_hash.clone(),
            log_index: meta.log_index,
            timestamp: meta.timestamp,
        };
        let inserted = state.db.insert_portfolio_event(&event_row).await?;
        if inserted {
            state
                .db
                .update_portfolio_group_balances(group_id, None, None, None, Some(&new_buf))
                .await?;
        }
        tracing::info!(group_id, amount = %ev.amount, new_buffer = %new_buf, "ExitBufferFunded");
        return Ok(());
    }

    if topic0 == TremorPortfolioMarket::ExitBufferWithdrawn::SIGNATURE_HASH {
        let ev = log
            .log_decode::<TremorPortfolioMarket::ExitBufferWithdrawn>()
            .context("decode ExitBufferWithdrawn")?
            .inner
            .data;
        let group_id = sqlite_i64(u64::try_from(ev.groupId).context("group id")?, "group id")?;
        let new_buf = ev.newBuffer.to_string();
        let event_row = PortfolioEventRow {
            id: 0,
            group_id,
            event_type: "buffer_withdrawn".into(),
            actor: None,
            side: None,
            units: "0".into(),
            amount: ev.amount.to_string(),
            new_outstanding: None,
            new_reserve: None,
            new_buffer: Some(new_buf.clone()),
            block_number: meta.block,
            tx_hash: meta.tx_hash.clone(),
            log_index: meta.log_index,
            timestamp: meta.timestamp,
        };
        let inserted = state.db.insert_portfolio_event(&event_row).await?;
        if inserted {
            state
                .db
                .update_portfolio_group_balances(group_id, None, None, None, Some(&new_buf))
                .await?;
        }
        tracing::info!(group_id, amount = %ev.amount, new_buffer = %new_buf, "ExitBufferWithdrawn");
        return Ok(());
    }

    if topic0 == TremorPortfolioMarket::WorthlessBurned::SIGNATURE_HASH {
        let ev = log
            .log_decode::<TremorPortfolioMarket::WorthlessBurned>()
            .context("decode WorthlessBurned")?
            .inner
            .data;
        let group_id = sqlite_i64(u64::try_from(ev.groupId).context("group id")?, "group id")?;
        let side = if ev.high { "high" } else { "calm" };
        let event_row = PortfolioEventRow {
            id: 0,
            group_id,
            event_type: "worthless_burned".into(),
            actor: Some(hex_addr(ev.holder)),
            side: Some(side.into()),
            units: ev.units.to_string(),
            amount: "0".into(),
            new_outstanding: None,
            new_reserve: None,
            new_buffer: None,
            block_number: meta.block,
            tx_hash: meta.tx_hash.clone(),
            log_index: meta.log_index,
            timestamp: meta.timestamp,
        };
        let inserted = state.db.insert_portfolio_event(&event_row).await?;
        if inserted {
            if let Some(group) = state.db.portfolio_group_by_id(group_id).await? {
                state
                    .db
                    .deduct_portfolio_units(
                        group_id,
                        ev.high,
                        &ev.units.to_string(),
                        &group.reserve_locked,
                        None,
                    )
                    .await?;
            }
        }
        tracing::info!(group_id, side, holder = %ev.holder, units = %ev.units, "WorthlessBurned");
        return Ok(());
    }

    Ok(())
}

async fn process_swap(
    state: &AppState,
    order_map: &OrderMap,
    log: &Log,
    meta: &LogMeta,
) -> Result<()> {
    let ev = log
        .log_decode::<AquaSwapVMRouter::Swapped>()
        .context("decode Swapped")?
        .inner
        .data;
    let Some((series_id, leg)) = order_map.lookup(&ev.orderHash) else {
        tracing::debug!(order_hash = %ev.orderHash, "Swapped for an order that is not a Tremor leg; skipped");
        return Ok(());
    };
    let (quote, units) = if leg.quote_is_amount_in() {
        (ev.amountIn, ev.amountOut)
    } else {
        (ev.amountOut, ev.amountIn)
    };
    let row = FillRow {
        tx_hash: meta.tx_hash.clone(),
        log_index: meta.log_index,
        block: meta.block,
        timestamp: meta.timestamp,
        series_id: sqlite_i64(series_id, "fill series id")?,
        leg: leg.as_str().to_string(),
        order_hash: hex_b256(ev.orderHash),
        maker_vault: hex_addr(ev.maker),
        taker: hex_addr(ev.taker),
        token_in: hex_addr(ev.tokenIn),
        token_out: hex_addr(ev.tokenOut),
        amount_in: ev.amountIn.to_string(),
        amount_out: ev.amountOut.to_string(),
        units: units.to_string(),
        quote_amount: quote.to_string(),
        price_per_unit: price_per_unit(quote, units).to_string(),
    };
    tracing::info!(series_id, leg = leg.as_str(), taker = %row.taker, units = %row.units, quote = %quote, "Swapped");
    state.db.insert_fill(&row).await?;
    Ok(())
}

async fn process_aqua(
    state: &AppState,
    order_map: &OrderMap,
    log: &Log,
    topic0: B256,
    meta: &LogMeta,
) -> Result<()> {
    let m = &state.manifest;
    let (kind, maker, app, strategy_hash, token, amount, strategy) =
        if topic0 == Aqua::Shipped::SIGNATURE_HASH {
            let ev = log
                .log_decode::<Aqua::Shipped>()
                .context("decode Shipped")?
                .inner
                .data;
            (
                "shipped",
                ev.maker,
                ev.app,
                ev.strategyHash,
                None,
                None,
                Some(format!("{:#x}", ev.strategy)),
            )
        } else if topic0 == Aqua::Docked::SIGNATURE_HASH {
            let ev = log
                .log_decode::<Aqua::Docked>()
                .context("decode Docked")?
                .inner
                .data;
            (
                "docked",
                ev.maker,
                ev.app,
                ev.strategyHash,
                None,
                None,
                None,
            )
        } else if topic0 == Aqua::Pulled::SIGNATURE_HASH {
            let ev = log
                .log_decode::<Aqua::Pulled>()
                .context("decode Pulled")?
                .inner
                .data;
            (
                "pulled",
                ev.maker,
                ev.app,
                ev.strategyHash,
                Some(ev.token),
                Some(ev.amount),
                None,
            )
        } else if topic0 == Aqua::Pushed::SIGNATURE_HASH {
            let ev = log
                .log_decode::<Aqua::Pushed>()
                .context("decode Pushed")?
                .inner
                .data;
            (
                "pushed",
                ev.maker,
                ev.app,
                ev.strategyHash,
                Some(ev.token),
                Some(ev.amount),
                None,
            )
        } else {
            return Ok(());
        };
    if app != m.router {
        return Ok(());
    }
    let mapped = order_map.lookup(&strategy_hash);
    let row = AquaEventRow {
        tx_hash: meta.tx_hash.clone(),
        log_index: meta.log_index,
        block: meta.block,
        timestamp: meta.timestamp,
        kind: kind.to_string(),
        maker: hex_addr(maker),
        app: hex_addr(app),
        strategy_hash: hex_b256(strategy_hash),
        series_id: mapped
            .map(|(id, _)| sqlite_i64(id, "Aqua event series id"))
            .transpose()?,
        leg: mapped.map(|(_, leg)| leg.as_str().to_string()),
        token: token.map(hex_addr),
        amount: amount.map(|a| a.to_string()),
        strategy,
    };
    tracing::debug!(kind, series_id = ?row.series_id, leg = ?row.leg, maker = %row.maker, "Aqua event");
    state.db.insert_aqua_event(&row).await?;
    Ok(())
}

async fn process_vault_log(
    state: &AppState,
    log: &Log,
    ts_cache: &mut HashMap<u64, u64>,
) -> Result<()> {
    let Some(topic0) = log.inner.data.topics().first().copied() else {
        return Ok(());
    };
    let meta = log_meta(state, log, ts_cache).await?;
    let vault = hex_addr(log.inner.address);

    let mut row = VaultEventRow {
        tx_hash: meta.tx_hash.clone(),
        log_index: meta.log_index,
        block: meta.block,
        timestamp: meta.timestamp,
        vault: vault.clone(),
        kind: String::new(),
        actor: None,
        amount: None,
        balance: None,
        locked: None,
        reference: None,
    };
    let mut deposited_delta: Option<String> = None;
    let mut withdrawn_delta: Option<String> = None;

    if topic0 == TremorMakerVault::Deposited::SIGNATURE_HASH {
        let ev = log
            .log_decode::<TremorMakerVault::Deposited>()
            .context("decode Deposited")?
            .inner
            .data;
        row.kind = "deposited".into();
        row.actor = Some(hex_addr(ev.payer));
        row.amount = Some(ev.amount.to_string());
        row.balance = Some(ev.newBalance.to_string());
        row.locked = Some(ev.lockedBalance.to_string());
        deposited_delta = Some(ev.amount.to_string());
    } else if topic0 == TremorMakerVault::FreeWithdrawn::SIGNATURE_HASH {
        let ev = log
            .log_decode::<TremorMakerVault::FreeWithdrawn>()
            .context("decode FreeWithdrawn")?
            .inner
            .data;
        row.kind = "free_withdrawn".into();
        row.actor = Some(hex_addr(ev.recipient));
        row.amount = Some(ev.amount.to_string());
        row.balance = Some(ev.newBalance.to_string());
        row.locked = Some(ev.lockedBalance.to_string());
        withdrawn_delta = Some(ev.amount.to_string());
    } else if topic0 == TremorMakerVault::LockedIncreased::SIGNATURE_HASH {
        let ev = log
            .log_decode::<TremorMakerVault::LockedIncreased>()
            .context("decode LockedIncreased")?
            .inner
            .data;
        row.kind = "locked_increased".into();
        row.amount = Some(ev.amount.to_string());
        row.locked = Some(ev.lockedBalance.to_string());
    } else if topic0 == TremorMakerVault::LockedDecreased::SIGNATURE_HASH {
        let ev = log
            .log_decode::<TremorMakerVault::LockedDecreased>()
            .context("decode LockedDecreased")?
            .inner
            .data;
        row.kind = "locked_decreased".into();
        row.amount = Some(ev.amount.to_string());
        row.locked = Some(ev.lockedBalance.to_string());
    } else if topic0 == TremorMakerVault::ReceiptRegistered::SIGNATURE_HASH {
        let ev = log
            .log_decode::<TremorMakerVault::ReceiptRegistered>()
            .context("decode ReceiptRegistered")?
            .inner
            .data;
        row.kind = "receipt_registered".into();
        row.reference = Some(hex_addr(ev.receipt));
    } else if topic0 == TremorMakerVault::StrategyShipped::SIGNATURE_HASH {
        let ev = log
            .log_decode::<TremorMakerVault::StrategyShipped>()
            .context("decode StrategyShipped")?
            .inner
            .data;
        row.kind = "strategy_shipped".into();
        row.reference = Some(hex_b256(ev.strategyHash));
    } else if topic0 == TremorMakerVault::StrategyDocked::SIGNATURE_HASH {
        let ev = log
            .log_decode::<TremorMakerVault::StrategyDocked>()
            .context("decode StrategyDocked")?
            .inner
            .data;
        row.kind = "strategy_docked".into();
        row.reference = Some(hex_b256(ev.strategyHash));
    } else {
        return Ok(());
    }

    state.db.insert_vault_event(&row).await?;
    state
        .db
        .apply_vault_totals(
            &vault,
            deposited_delta.as_deref(),
            withdrawn_delta.as_deref(),
            row.balance.as_deref(),
            row.locked.as_deref(),
            meta.timestamp,
        )
        .await?;
    tracing::debug!(vault = %vault, kind = %row.kind, "vault event");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_are_inclusive_and_capped() {
        assert_eq!(
            block_chunks(100, 5000, 2000),
            vec![(100, 2099), (2100, 4099), (4100, 5000)]
        );
        assert_eq!(block_chunks(10, 10, 2000), vec![(10, 10)]);
        assert_eq!(block_chunks(0, 1999, 2000), vec![(0, 1999)]);
        assert_eq!(block_chunks(0, 2000, 2000), vec![(0, 1999), (2000, 2000)]);
        assert!(block_chunks(50, 40, 2000).is_empty());
        assert!(block_chunks(1, 5, 0).is_empty());
        for (a, b) in block_chunks(7, 100_000, CHUNK_BLOCKS) {
            assert!(b >= a && b - a < CHUNK_BLOCKS);
        }
        assert_eq!(
            block_chunks(u64::MAX - 1, u64::MAX, 5),
            vec![(u64::MAX - 1, u64::MAX)]
        );
    }

    #[test]
    fn an_order_hash_maps_to_a_series_and_one_of_three_legs() {
        let mut m = OrderMap::default();
        let (i0, e0, s0) = (
            B256::repeat_byte(0x11),
            B256::repeat_byte(0x12),
            B256::repeat_byte(0x13),
        );
        let (i1, e1, s1) = (
            B256::repeat_byte(0x21),
            B256::repeat_byte(0x22),
            B256::repeat_byte(0x23),
        );
        m.insert_series(1, i0, e0, s0);
        m.insert_series(7, i1, e1, s1);
        assert_eq!(m.lookup(&i0), Some((1, Leg::Issue)));
        assert_eq!(m.lookup(&e0), Some((1, Leg::Exit)));
        assert_eq!(m.lookup(&s0), Some((1, Leg::Settle)));
        assert_eq!(m.lookup(&s1), Some((7, Leg::Settle)));
        assert_eq!(m.lookup(&B256::repeat_byte(0x99)), None);
        assert_eq!(m.series_count(), 2);
    }

    /// After a restart the order map is rebuilt from sqlite, not from a re-scan.
    #[test]
    fn the_order_map_rebuilds_from_stored_rows() {
        let i0 = B256::repeat_byte(0x11);
        let e0 = B256::repeat_byte(0x12);
        let s0 = B256::repeat_byte(0x13);
        let rows = vec![
            (format!("{i0:#x}"), 3i64, "issue".to_string()),
            (format!("{e0:#x}"), 3, "exit".to_string()),
            (format!("{s0:#x}"), 3, "settle".to_string()),
            ("not a hash".to_string(), 4, "issue".to_string()),
            (
                format!("{:#x}", B256::repeat_byte(0x44)),
                5,
                "bogus".to_string(),
            ),
        ];
        let m = OrderMap::from_rows(&rows);
        assert_eq!(m.lookup(&i0), Some((3, Leg::Issue)));
        assert_eq!(m.lookup(&e0), Some((3, Leg::Exit)));
        assert_eq!(m.lookup(&s0), Some((3, Leg::Settle)));
        assert_eq!(
            m.series_count(),
            1,
            "unparseable rows must not create series"
        );
    }

    /// The quote side of a fill is `amountIn` for ISSUE and `amountOut` for the two burn legs. Getting
    /// this backwards would report an exit as if the holder had paid for it.
    #[test]
    fn the_quote_side_depends_on_the_leg() {
        assert!(Leg::Issue.quote_is_amount_in());
        assert!(!Leg::Exit.quote_is_amount_in());
        assert!(!Leg::Settle.quote_is_amount_in());
    }

    #[test]
    fn leg_names_round_trip() {
        for leg in [Leg::Issue, Leg::Exit, Leg::Settle] {
            assert_eq!(Leg::parse(leg.as_str()), Some(leg));
        }
        assert_eq!(Leg::parse("premium"), None, "v1 leg names must not decode");
        assert_eq!(Leg::parse("settlement"), None);
    }

    #[test]
    fn price_per_unit_math() {
        // 1000 USDC (1e9) for 2 units (2e18) -> 500 USDC per unit = 5e8
        assert_eq!(
            price_per_unit(
                U256::from(1_000_000_000u64),
                U256::from(2_000_000_000_000_000_000u128)
            ),
            U256::from(500_000_000u64)
        );
        assert_eq!(price_per_unit(U256::from(5), U256::ZERO), U256::ZERO);
    }

    #[tokio::test]
    async fn real_chain_portfolio_indexer_integration() {
        use alloy::primitives::U256;
        use alloy::providers::{DynProvider, Provider, ProviderBuilder};
        use alloy::rpc::types::Filter;

        let rpc_url = match "http://127.0.0.1:8545".parse() {
            Ok(u) => u,
            Err(_) => return,
        };
        let provider: DynProvider = ProviderBuilder::new().connect_http(rpc_url).erased();

        // Fail honestly if Anvil RPC is unreachable
        provider
            .get_block_number()
            .await
            .expect("Anvil RPC must be reachable at http://127.0.0.1:8545 for real-chain indexer integration test");

        let manifest_path = "../contracts/deployments/31337.json";
        let manifest_bytes = std::fs::read(manifest_path).expect(
            "31337.json deployment manifest must exist for real-chain indexer integration test",
        );
        let manifest: crate::config::Manifest = serde_json::from_slice(&manifest_bytes)
            .expect("31337.json manifest must be valid JSON");
        assert_ne!(
            manifest.portfolio_market,
            Address::ZERO,
            "manifest.portfolio_market must be configured (non-zero)"
        );

        // 1. Query actual mined logs for portfolioMarket from the chain
        let filter = Filter::new()
            .address(manifest.portfolio_market)
            .from_block(manifest.deployment_block);
        let logs = provider
            .get_logs(&filter)
            .await
            .expect("get_logs for portfolio_market must succeed");
        assert!(
            logs.len() >= 8,
            "Expected at least 8 portfolio demo logs on chain, but found {}",
            logs.len()
        );

        // Fetch block timestamps dynamically from provider
        let mut block_timestamps: HashMap<u64, i64> = HashMap::new();
        for log in &logs {
            let b = log.block_number.unwrap_or_default();
            // `entry` rather than contains_key/insert: the fetch is awaited, so the closure-taking
            // `or_insert_with` helpers do not apply and the Vacant arm is the clippy-clean equivalent.
            if let std::collections::hash_map::Entry::Vacant(slot) = block_timestamps.entry(b) {
                let blk = provider
                    .get_block_by_number(b.into())
                    .await
                    .expect("get_block_by_number must succeed")
                    .expect("block must exist");
                slot.insert(blk.header.timestamp as i64);
            }
        }

        // 2. Set up fresh in-memory database with schema v3
        let db = crate::db::Db::connect_memory().await.unwrap();
        db.migrate(false).await.unwrap();

        // 3. Construct AppState with db and manifest
        let cfg = crate::config::Config {
            rpc_url: "http://127.0.0.1:8545".into(),
            deployment_json: manifest_path.into(),
            database_url: ":memory:".into(),
            port: 8787,
            bind_address: "127.0.0.1".parse().unwrap(),
            poll_ms: 1000,
            cors_origin: "*".into(),
        };
        let chainlink = crate::chainlink::Chainlink::new(
            crate::chainlink::RpcRoundSource::new(provider.clone()),
            db.clone(),
        );
        let lens = crate::lens::LensClient::new(manifest.lens, provider.clone());
        let indexer_handle = IndexerHandle::new(Some(31337));

        let app_state = AppState {
            cfg,
            manifest: manifest.clone(),
            provider: provider.clone(),
            db: db.clone(),
            chainlink,
            lens,
            indexer: indexer_handle,
            feed_decimals: 8,
            max_samples_per_checkpoint: 8,
        };

        // 4. Pass actual on-chain logs through the production decoder/indexer path.
        // Logs are processed in ascending block/transaction/log_index order (as returned by
        // get_logs). For each WorthlessBurned log, the indexed outstanding supply is captured
        // immediately before processing so the exact decrement can be verified without
        // saturating subtraction.
        let worthless_sig = crate::abi::TremorPortfolioMarket::WorthlessBurned::SIGNATURE_HASH;
        let mut vaults = HashSet::new();
        // get_logs returns logs in ascending (block, tx_index, log_index) order per the Ethereum
        // JSON-RPC spec; sort explicitly as a safety net against RPC non-compliance.
        let mut ordered_logs = logs.clone();
        ordered_logs.sort_by_key(|l| {
            (
                l.block_number.unwrap_or_default(),
                l.transaction_index.unwrap_or_default(),
                l.log_index.unwrap_or_default(),
            )
        });

        for log in &ordered_logs {
            let topic0 = match log.topics().first().copied() {
                Some(t) => t,
                None => continue,
            };
            let block = log.block_number.unwrap_or_default();
            let tx_hash = log
                .transaction_hash
                .map(|h| format!("{h:#x}"))
                .unwrap_or_default();
            let log_index = log.log_index.unwrap_or_default();
            let timestamp = *block_timestamps.get(&block).unwrap_or(&1000);
            let meta = LogMeta {
                tx_hash,
                log_index: log_index as i64,
                block: block as i64,
                timestamp,
            };

            if topic0 == worthless_sig {
                // Decode the mined event to know which group/side and how many units.
                let ev = log
                    .log_decode::<crate::abi::TremorPortfolioMarket::WorthlessBurned>()
                    .expect("decode WorthlessBurned during ordered ingestion")
                    .inner
                    .data;
                let gid = i64::try_from(u64::try_from(ev.groupId).expect("groupId fits u64"))
                    .expect("groupId fits i64");

                // Capture the indexed outstanding supply immediately before processing this log.
                let pre_burn_group = db
                    .portfolio_group_by_id(gid)
                    .await
                    .unwrap()
                    .unwrap_or_else(|| panic!("group {} must exist before WorthlessBurned", gid));
                let pre_burn_outstanding: U256 = if ev.high {
                    pre_burn_group
                        .high_outstanding
                        .parse()
                        .expect("high_outstanding is valid U256")
                } else {
                    pre_burn_group
                        .calm_outstanding
                        .parse()
                        .expect("calm_outstanding is valid U256")
                };

                assert!(
                    pre_burn_outstanding >= ev.units,
                    "pre-burn indexed supply ({}) must be >= burned units ({}) for group {} side {}",
                    pre_burn_outstanding,
                    ev.units,
                    gid,
                    if ev.high { "high" } else { "calm" }
                );
                let expected_post_burn = pre_burn_outstanding - ev.units; // exact subtraction, no saturating

                // Process the mined log through the production decoder/indexer path.
                process_portfolio_market_log(&app_state, &mut vaults, log, topic0, &meta)
                    .await
                    .unwrap();

                // Assert post-burn supply equals pre-burn minus burned units exactly.
                let post_burn_group = db
                    .portfolio_group_by_id(gid)
                    .await
                    .unwrap()
                    .unwrap_or_else(|| panic!("group {} must exist after WorthlessBurned", gid));
                let post_burn_outstanding: U256 = if ev.high {
                    post_burn_group
                        .high_outstanding
                        .parse()
                        .expect("high_outstanding is valid U256")
                } else {
                    post_burn_group
                        .calm_outstanding
                        .parse()
                        .expect("calm_outstanding is valid U256")
                };
                assert_eq!(
                    post_burn_outstanding, expected_post_burn,
                    "post-burn indexed supply must equal pre_burn - units exactly \
                     (pre={}, units={}, expected={}, got={}) — \
                     saturating subtraction would mask an underflow",
                    pre_burn_outstanding, ev.units, expected_post_burn, post_burn_outstanding
                );
            } else {
                process_portfolio_market_log(&app_state, &mut vaults, log, topic0, &meta)
                    .await
                    .unwrap();
            }
        }

        // 5. Verify persisted state and event coverage across lifecycle
        let group1 = db
            .portfolio_group_by_id(1)
            .await
            .unwrap()
            .expect("group 1 must exist");
        assert_eq!(group1.id, 1);
        let events1 = db.portfolio_events_for_group(1, 200).await.unwrap();
        assert!(!events1.is_empty(), "expected events for group 1");

        let event_types1: HashSet<&str> = events1.iter().map(|e| e.event_type.as_str()).collect();
        assert!(
            event_types1.contains("issued"),
            "expected issued event for group 1"
        );
        assert!(
            event_types1.contains("exited"),
            "expected exited event for group 1"
        );
        assert!(
            event_types1.contains("buffer_funded"),
            "expected buffer_funded event for group 1"
        );

        let group2 = db
            .portfolio_group_by_id(2)
            .await
            .unwrap()
            .expect("group 2 must exist");
        assert_eq!(group2.id, 2);
        assert_eq!(group2.finalized, 1, "group 2 must be finalized");
        let events2 = db.portfolio_events_for_group(2, 200).await.unwrap();
        let event_types2: HashSet<&str> = events2.iter().map(|e| e.event_type.as_str()).collect();
        assert!(
            event_types2.contains("finalized"),
            "expected finalized event for group 2"
        );
        assert!(
            event_types2.contains("settled"),
            "expected settled event for group 2"
        );

        let count_before_replay = db.portfolio_events_for_group(1, 200).await.unwrap().len();
        let count_before_replay2 = db.portfolio_events_for_group(2, 200).await.unwrap().len();

        // 6. Replay all logs to verify idempotence
        for log in &ordered_logs {
            let topic0 = match log.topics().first().copied() {
                Some(t) => t,
                None => continue,
            };
            let block = log.block_number.unwrap_or_default();
            let tx_hash = log
                .transaction_hash
                .map(|h| format!("{h:#x}"))
                .unwrap_or_default();
            let log_index = log.log_index.unwrap_or_default();
            let timestamp = *block_timestamps.get(&block).unwrap_or(&1000);
            let meta = LogMeta {
                tx_hash,
                log_index: log_index as i64,
                block: block as i64,
                timestamp,
            };
            process_portfolio_market_log(&app_state, &mut vaults, log, topic0, &meta)
                .await
                .unwrap();
        }
        let all_groups = db.portfolio_groups_all().await.unwrap();
        assert_eq!(
            all_groups.len(),
            2,
            "replaying logs must not duplicate group rows"
        );

        let count_after_replay = db.portfolio_events_for_group(1, 200).await.unwrap().len();
        let count_after_replay2 = db.portfolio_events_for_group(2, 200).await.unwrap().len();
        assert_eq!(
            count_after_replay, count_before_replay,
            "replaying must not duplicate events for group 1"
        );
        assert_eq!(
            count_after_replay2, count_before_replay2,
            "replaying must not duplicate events for group 2"
        );

        // Verify group balances remain exact after replay
        let group1_replayed = db.portfolio_group_by_id(1).await.unwrap().unwrap();

        assert_eq!(group1_replayed.high_outstanding, group1.high_outstanding);
        assert_eq!(group1_replayed.calm_outstanding, group1.calm_outstanding);
        assert_eq!(group1_replayed.reserve_locked, group1.reserve_locked);
        assert_eq!(group1_replayed.exit_buffer, group1.exit_buffer);

        // 7. Compare persisted state with live on-chain groupView
        let market =
            crate::abi::TremorPortfolioMarket::new(manifest.portfolio_market, provider.clone());
        let view1 = market.groupView(U256::from(1)).call().await.unwrap();
        assert_eq!(view1.highOutstanding.to_string(), group1.high_outstanding);
        assert_eq!(view1.calmOutstanding.to_string(), group1.calm_outstanding);
        assert_eq!(view1.reserveLocked.to_string(), group1.reserve_locked);
        assert_eq!(view1.exitBuffer.to_string(), group1.exit_buffer);

        let view2 = market.groupView(U256::from(2)).call().await.unwrap();
        assert_eq!(view2.finalized, group2.finalized == 1);
        assert_eq!(
            view2.finalVariance.to_string(),
            group2.final_variance.unwrap()
        );
        assert_eq!(view2.highPpu.to_string(), group2.high_ppu.unwrap());
        assert_eq!(view2.calmPpu.to_string(), group2.calm_ppu.unwrap());
        assert_eq!(view2.highOutstanding.to_string(), group2.high_outstanding);
        assert_eq!(view2.calmOutstanding.to_string(), group2.calm_outstanding);
        assert_eq!(view2.reserveLocked.to_string(), group2.reserve_locked);
        assert_eq!(view2.exitBuffer.to_string(), group2.exit_buffer);
        assert_eq!(group2.exit_buffer, "0", "finalized exitBuffer must be zero");

        // 8. Verify WorthlessBurned event row fields and confirm replay idempotence specifically
        // for the burn log. The exact pre→post decrement was already verified inline in step 4.
        // Chain-state reconciliation (DB == groupView) was verified in step 7 above.
        let burn_filter = Filter::new()
            .address(manifest.portfolio_market)
            .event_signature(worthless_sig)
            .from_block(manifest.deployment_block);
        let burn_logs = provider
            .get_logs(&burn_filter)
            .await
            .expect("get_logs for WorthlessBurned must succeed");
        assert!(
            !burn_logs.is_empty(),
            "Expected at least 1 mined WorthlessBurned event on chain, but found 0"
        );
        let mined_burn_log = &burn_logs[0];
        let burn_ev = mined_burn_log
            .log_decode::<crate::abi::TremorPortfolioMarket::WorthlessBurned>()
            .expect("decode mined WorthlessBurned")
            .inner
            .data;
        assert_eq!(
            burn_ev.groupId,
            U256::from(1),
            "Expected WorthlessBurned on group 1"
        );
        assert!(burn_ev.high, "Expected WorthlessBurned on high side");
        assert!(burn_ev.units > U256::ZERO, "Burned units must be positive");

        let burn_block = mined_burn_log.block_number.unwrap_or_default();
        let burn_tx_hash = mined_burn_log
            .transaction_hash
            .map(|h| format!("{h:#x}"))
            .unwrap_or_default();
        let burn_log_index = mined_burn_log.log_index.unwrap_or_default();
        let burn_timestamp = match block_timestamps.get(&burn_block) {
            Some(t) => *t,
            None => {
                let blk = provider
                    .get_block_by_number(burn_block.into())
                    .await
                    .expect("get_block_by_number for burn must succeed")
                    .expect("burn block must exist");
                blk.header.timestamp as i64
            }
        };
        let mined_burn_meta = LogMeta {
            tx_hash: burn_tx_hash,
            log_index: burn_log_index as i64,
            block: burn_block as i64,
            timestamp: burn_timestamp,
        };

        // Verify event row was indexed with correct fields during step 4.
        let g1_events = db.portfolio_events_for_group(1, 200).await.unwrap();
        let worthless_row = g1_events
            .iter()
            .find(|e| e.event_type == "worthless_burned")
            .expect("worthless_burned event must be recorded by step 4 ingestion");
        assert_eq!(
            worthless_row.units,
            burn_ev.units.to_string(),
            "indexed units match event"
        );
        assert_eq!(
            worthless_row.side.as_deref(),
            Some("high"),
            "indexed side is high"
        );
        let expected_actor = hex_addr(burn_ev.holder);
        assert_eq!(
            worthless_row.actor.as_deref(),
            Some(expected_actor.as_str()),
            "indexed actor matches holder"
        );

        // Replay the mined WorthlessBurned log: no duplicate event row, no duplicate deduction.
        let high_before_burn_replay: U256 = group1.high_outstanding.parse().unwrap();
        let count_before_burn_replay = g1_events.len();
        process_portfolio_market_log(
            &app_state,
            &mut vaults,
            mined_burn_log,
            worthless_sig,
            &mined_burn_meta,
        )
        .await
        .unwrap();
        let count_after_burn_replay = db.portfolio_events_for_group(1, 200).await.unwrap().len();
        assert_eq!(
            count_after_burn_replay, count_before_burn_replay,
            "replaying mined worthless burn must not add a duplicate event row"
        );
        let g1_post_burn_replay = db.portfolio_group_by_id(1).await.unwrap().unwrap();
        let high_after_burn_replay: U256 = g1_post_burn_replay.high_outstanding.parse().unwrap();
        assert_eq!(
            high_after_burn_replay, high_before_burn_replay,
            "replay must not duplicate the supply deduction: \
             high_outstanding must remain {} not {}",
            high_before_burn_replay, high_after_burn_replay
        );
        assert_eq!(
            g1_post_burn_replay.calm_outstanding, group1.calm_outstanding,
            "calm_outstanding unchanged after replay"
        );
        assert_eq!(
            g1_post_burn_replay.reserve_locked, group1.reserve_locked,
            "reserve_locked unchanged after replay"
        );
        assert_eq!(
            g1_post_burn_replay.exit_buffer, "0",
            "exit_buffer unchanged after replay"
        );
    }
}
