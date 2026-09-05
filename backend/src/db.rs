//! SQLite persistence (sqlx, runtime queries). Migrations are plain SQL executed at startup.
//!
//! The schema is versioned, and a database written by the previous design is NOT silently upgraded or
//! dropped: startup fails with instructions instead. Resetting is an explicit operator action
//! (`tremor-api --reset-db`), because losing an indexed history should be something somebody chose.

use std::collections::HashMap;
use std::str::FromStr;

use alloy::primitives::{Address, U256};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

use crate::chainlink::Round;
use crate::util::{nonnegative_u64, sqlite_i64};

/// Bumped whenever a table's shape changes. v1 was the unsecured-writer design (seller-as-maker,
/// premium/settlement legs, no vaults, no checkpoints).
const SCHEMA_VERSION: i64 = 2;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS schema_meta (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cursor (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    last_block       INTEGER NOT NULL,
    last_block_hash  TEXT,
    deployment_block INTEGER NOT NULL,
    controller       TEXT NOT NULL,
    chain_id         INTEGER,
    updated_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vaults (
    address        TEXT PRIMARY KEY,
    writer         TEXT NOT NULL,
    quote_token    TEXT NOT NULL,
    created_block  INTEGER NOT NULL,
    created_tx     TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    deposited      TEXT NOT NULL DEFAULT '0',
    withdrawn      TEXT NOT NULL DEFAULT '0',
    last_balance   TEXT,
    last_locked    TEXT,
    last_event_at  INTEGER
);
CREATE INDEX IF NOT EXISTS vaults_writer ON vaults(writer);
CREATE TABLE IF NOT EXISTS series (
    id                    INTEGER PRIMARY KEY,
    writer                TEXT NOT NULL,
    vault                 TEXT NOT NULL,
    receipt               TEXT NOT NULL,
    issue_order_hash      TEXT NOT NULL,
    exit_order_hash       TEXT NOT NULL,
    settlement_order_hash TEXT NOT NULL,
    feed                  TEXT NOT NULL,
    quote_token           TEXT NOT NULL,
    start                 INTEGER NOT NULL,
    expiry                INTEGER NOT NULL,
    sale_end              INTEGER NOT NULL,
    sample_interval       INTEGER NOT NULL,
    unit_notional         TEXT NOT NULL,
    cap_variance          TEXT NOT NULL,
    anchor_variance       TEXT NOT NULL,
    impact_per_unit       TEXT NOT NULL,
    half_life             INTEGER NOT NULL,
    half_spread_bps       INTEGER NOT NULL,
    max_units             TEXT NOT NULL,
    created_block         INTEGER NOT NULL,
    created_tx            TEXT NOT NULL,
    created_at            INTEGER NOT NULL,
    issuance_stopped_at   INTEGER,
    closed_at             INTEGER
);
CREATE INDEX IF NOT EXISTS series_vault  ON series(vault);
CREATE INDEX IF NOT EXISTS series_writer ON series(writer);
CREATE TABLE IF NOT EXISTS orders (
    order_hash TEXT PRIMARY KEY,
    series_id  INTEGER NOT NULL,
    leg        TEXT NOT NULL,
    maker      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_series ON orders(series_id);
CREATE TABLE IF NOT EXISTS fills (
    tx_hash        TEXT NOT NULL,
    log_index      INTEGER NOT NULL,
    block          INTEGER NOT NULL,
    timestamp      INTEGER NOT NULL,
    series_id      INTEGER NOT NULL,
    leg            TEXT NOT NULL,
    order_hash     TEXT NOT NULL,
    maker_vault    TEXT NOT NULL,
    taker          TEXT NOT NULL,
    token_in       TEXT NOT NULL,
    token_out      TEXT NOT NULL,
    amount_in      TEXT NOT NULL,
    amount_out     TEXT NOT NULL,
    units          TEXT NOT NULL,
    quote_amount   TEXT NOT NULL,
    price_per_unit TEXT NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS fills_series ON fills(series_id, timestamp);
CREATE INDEX IF NOT EXISTS fills_taker  ON fills(taker, series_id);
CREATE TABLE IF NOT EXISTS checkpoints (
    tx_hash            TEXT NOT NULL,
    log_index          INTEGER NOT NULL,
    block              INTEGER NOT NULL,
    timestamp          INTEGER NOT NULL,
    series_id          INTEGER NOT NULL,
    from_sample        INTEGER NOT NULL,
    to_sample          INTEGER NOT NULL,
    processed_through   INTEGER NOT NULL,
    last_round_id      TEXT NOT NULL,
    sum_squared_returns TEXT NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS checkpoints_series ON checkpoints(series_id, processed_through);
CREATE TABLE IF NOT EXISTS finalizations (
    series_id           INTEGER PRIMARY KEY,
    tx_hash             TEXT NOT NULL,
    block               INTEGER NOT NULL,
    timestamp           INTEGER NOT NULL,
    final_variance      TEXT NOT NULL,
    capped_variance     TEXT NOT NULL,
    payout_per_unit     TEXT NOT NULL,
    outstanding_units   TEXT NOT NULL,
    released_collateral TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_events (
    tx_hash   TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    block     INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    vault     TEXT NOT NULL,
    kind      TEXT NOT NULL,
    actor     TEXT,
    amount    TEXT,
    balance   TEXT,
    locked    TEXT,
    reference TEXT,
    PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS vault_events_vault ON vault_events(vault, timestamp);
CREATE TABLE IF NOT EXISTS aqua_events (
    tx_hash       TEXT NOT NULL,
    log_index     INTEGER NOT NULL,
    block         INTEGER NOT NULL,
    timestamp     INTEGER NOT NULL,
    kind          TEXT NOT NULL,
    maker         TEXT NOT NULL,
    app           TEXT NOT NULL,
    strategy_hash TEXT NOT NULL,
    series_id     INTEGER,
    leg           TEXT,
    token         TEXT,
    amount        TEXT,
    strategy      TEXT,
    PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS aqua_events_series ON aqua_events(series_id, timestamp);
CREATE TABLE IF NOT EXISTS rounds (
    feed       TEXT NOT NULL,
    phase      INTEGER NOT NULL,
    agg_round  INTEGER NOT NULL,
    round_id   TEXT NOT NULL,
    answer     TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (feed, phase, agg_round)
);
CREATE INDEX IF NOT EXISTS rounds_time ON rounds(feed, phase, updated_at);
CREATE TABLE IF NOT EXISTS phases (
    feed       TEXT NOT NULL,
    phase      INTEGER NOT NULL,
    last_round INTEGER,
    PRIMARY KEY (feed, phase)
);
CREATE TABLE IF NOT EXISTS round_coverage (
    feed  TEXT NOT NULL,
    phase INTEGER NOT NULL,
    lo    INTEGER NOT NULL,
    hi    INTEGER NOT NULL
);
"#;

/// Chain-derived tables, in dependency-free order. Round caches are kept across a reset: they are a
/// cache of immutable feed history, not of Tremor state.
const CHAIN_TABLES: &[&str] = &[
    "fills",
    "checkpoints",
    "finalizations",
    "vault_events",
    "aqua_events",
    "orders",
    "series",
    "vaults",
    "cursor",
];

/// Every table a v1 database had that v2 replaces outright.
const V1_TABLES: &[&str] = &[
    "fills",
    "aqua_events",
    "series",
    "cursor",
    "rounds",
    "phases",
    "round_coverage",
];

fn addr_key(a: Address) -> String {
    format!("{a:#x}")
}

#[derive(Clone)]
pub struct Db {
    pool: SqlitePool,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct CursorRow {
    pub last_block: i64,
    pub last_block_hash: Option<String>,
    pub deployment_block: i64,
    pub controller: String,
    pub chain_id: Option<i64>,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct VaultRow {
    pub address: String,
    pub writer: String,
    pub quote_token: String,
    pub created_block: i64,
    pub created_tx: String,
    pub created_at: i64,
    pub deposited: String,
    pub withdrawn: String,
    pub last_balance: Option<String>,
    pub last_locked: Option<String>,
    pub last_event_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct SeriesRow {
    pub id: i64,
    pub writer: String,
    pub vault: String,
    pub receipt: String,
    pub issue_order_hash: String,
    pub exit_order_hash: String,
    pub settlement_order_hash: String,
    pub feed: String,
    pub quote_token: String,
    pub start: i64,
    pub expiry: i64,
    pub sale_end: i64,
    pub sample_interval: i64,
    pub unit_notional: String,
    pub cap_variance: String,
    pub anchor_variance: String,
    pub impact_per_unit: String,
    pub half_life: i64,
    pub half_spread_bps: i64,
    pub max_units: String,
    pub created_block: i64,
    pub created_tx: String,
    pub created_at: i64,
    pub issuance_stopped_at: Option<i64>,
    pub closed_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct FillRow {
    pub tx_hash: String,
    pub log_index: i64,
    pub block: i64,
    pub timestamp: i64,
    pub series_id: i64,
    /// `issue`, `exit` or `settle`.
    pub leg: String,
    pub order_hash: String,
    pub maker_vault: String,
    pub taker: String,
    pub token_in: String,
    pub token_out: String,
    pub amount_in: String,
    pub amount_out: String,
    pub units: String,
    pub quote_amount: String,
    pub price_per_unit: String,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct CheckpointRow {
    pub tx_hash: String,
    pub log_index: i64,
    pub block: i64,
    pub timestamp: i64,
    pub series_id: i64,
    pub from_sample: i64,
    pub to_sample: i64,
    pub processed_through: i64,
    pub last_round_id: String,
    pub sum_squared_returns: String,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct FinalizationRow {
    pub series_id: i64,
    pub tx_hash: String,
    pub block: i64,
    pub timestamp: i64,
    pub final_variance: String,
    pub capped_variance: String,
    pub payout_per_unit: String,
    pub outstanding_units: String,
    pub released_collateral: String,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct VaultEventRow {
    pub tx_hash: String,
    pub log_index: i64,
    pub block: i64,
    pub timestamp: i64,
    pub vault: String,
    pub kind: String,
    pub actor: Option<String>,
    pub amount: Option<String>,
    pub balance: Option<String>,
    pub locked: Option<String>,
    pub reference: Option<String>,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct AquaEventRow {
    pub tx_hash: String,
    pub log_index: i64,
    pub block: i64,
    pub timestamp: i64,
    pub kind: String,
    pub maker: String,
    pub app: String,
    pub strategy_hash: String,
    pub series_id: Option<i64>,
    pub leg: Option<String>,
    pub token: Option<String>,
    pub amount: Option<String>,
    pub strategy: Option<String>,
}

/// Per-series volume, separated by leg. Issuance money flows into the vault; exit and settlement flow
/// out of it, so summing them together would be meaningless.
#[derive(Clone, Debug, Default)]
pub struct FillStats {
    pub count: u64,
    pub issue_count: u64,
    pub exit_count: u64,
    pub settle_count: u64,
    pub premium_quote: U256,
    pub exit_quote: U256,
    pub settlement_quote: U256,
    pub units_issued: U256,
    pub units_exited: U256,
    pub units_settled: U256,
    pub last_fill_at: Option<u64>,
}

impl Db {
    pub async fn connect(url: &str) -> Result<Self> {
        let opts = SqliteConnectOptions::from_str(url)
            .with_context(|| format!("invalid DATABASE_URL {url}"))?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(std::time::Duration::from_secs(10));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(opts)
            .await
            .context("opening sqlite")?;
        Ok(Self { pool })
    }

    /// Private in-memory database (tests).
    pub async fn connect_memory() -> Result<Self> {
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")?;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .idle_timeout(None)
            .max_lifetime(None)
            .connect_with(opts)
            .await?;
        let db = Self { pool };
        db.migrate(true).await?;
        Ok(db)
    }

    /// Creates or verifies the schema.
    ///
    /// `allow_reset` corresponds to `tremor-api --reset-db`. Without it, a database written by an older
    /// schema is a hard startup failure: the alternative is either serving v1 rows through v2 field
    /// names or destroying an operator's history without being asked.
    pub async fn migrate(&self, allow_reset: bool) -> Result<()> {
        sqlx::query("CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)")
            .execute(&self.pool)
            .await
            .context("creating schema version table")?;
        let existing: Option<i64> =
            sqlx::query_scalar("SELECT version FROM schema_meta WHERE id = 1")
                .fetch_optional(&self.pool)
                .await?;

        match existing {
            Some(v) if v > SCHEMA_VERSION => {
                bail!("database schema v{v} is newer than this binary (v{SCHEMA_VERSION})")
            }
            Some(v) if v < SCHEMA_VERSION => {
                if !allow_reset {
                    bail!(
                        "database schema is v{v} and this binary needs v{SCHEMA_VERSION}. \
                         The covered-market design replaced the series, fills and cursor tables outright, \
                         so there is nothing to migrate in place. Re-run with `--reset-db` to drop the \
                         indexed history and rebuild it from the chain, or point DATABASE_URL at a new file."
                    );
                }
                tracing::warn!(
                    from = v,
                    to = SCHEMA_VERSION,
                    "resetting the database schema"
                );
                for table in V1_TABLES {
                    sqlx::query(&format!("DROP TABLE IF EXISTS {table}"))
                        .execute(&self.pool)
                        .await
                        .with_context(|| format!("dropping v1 table {table}"))?;
                }
            }
            _ => {}
        }

        sqlx::raw_sql(SCHEMA)
            .execute(&self.pool)
            .await
            .context("running migrations")?;
        sqlx::query("INSERT INTO schema_meta (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version")
            .bind(SCHEMA_VERSION)
            .execute(&self.pool)
            .await?;
        // Zeroed transmissions (updatedAt == 0) mean "no such round" and must never be served from cache.
        sqlx::query("DELETE FROM rounds WHERE updated_at = 0")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn schema_version(&self) -> Result<Option<i64>> {
        Ok(
            sqlx::query_scalar("SELECT version FROM schema_meta WHERE id = 1")
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    // ---- cursor -------------------------------------------------------------------------

    pub async fn cursor(&self) -> Result<Option<CursorRow>> {
        Ok(sqlx::query_as::<_, CursorRow>(
            "SELECT last_block, last_block_hash, deployment_block, controller, chain_id FROM cursor WHERE id = 1",
        )
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn set_cursor(
        &self,
        last_block: u64,
        last_block_hash: Option<String>,
        deployment_block: u64,
        controller: Address,
        chain_id: Option<u64>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO cursor (id, last_block, last_block_hash, deployment_block, controller, chain_id, updated_at)
             VALUES (1, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET last_block = excluded.last_block, last_block_hash = excluded.last_block_hash,
               deployment_block = excluded.deployment_block, controller = excluded.controller, chain_id = excluded.chain_id,
               updated_at = excluded.updated_at",
        )
        .bind(sqlite_i64(last_block, "last_block")?)
        .bind(last_block_hash)
        .bind(sqlite_i64(deployment_block, "deployment_block")?)
        .bind(addr_key(controller))
        .bind(chain_id.map(|c| sqlite_i64(c, "chain_id")).transpose()?)
        .bind(sqlite_i64(crate::util::now_unix(), "updated_at")?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Drops everything derived from the chain, keeping the immutable feed-history cache.
    pub async fn reset_chain_state(&self) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for table in CHAIN_TABLES {
            sqlx::query(&format!("DELETE FROM {table}"))
                .execute(&mut *tx)
                .await
                .with_context(|| format!("clearing {table}"))?;
        }
        tx.commit().await?;
        Ok(())
    }

    // ---- vaults -------------------------------------------------------------------------

    pub async fn insert_vault(&self, v: &VaultRow) -> Result<()> {
        sqlx::query(
            "INSERT INTO vaults (address, writer, quote_token, created_block, created_tx, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(address) DO UPDATE SET writer = excluded.writer, quote_token = excluded.quote_token",
        )
        .bind(&v.address)
        .bind(&v.writer)
        .bind(&v.quote_token)
        .bind(v.created_block)
        .bind(&v.created_tx)
        .bind(v.created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Folds a vault event into the running totals the writer page shows.
    pub async fn apply_vault_totals(
        &self,
        vault: &str,
        deposited_delta: Option<&str>,
        withdrawn_delta: Option<&str>,
        balance: Option<&str>,
        locked: Option<&str>,
        at: i64,
    ) -> Result<()> {
        let existing = self.vault_get(vault).await?;
        let mut deposited = existing
            .as_ref()
            .and_then(|v| U256::from_str(&v.deposited).ok())
            .unwrap_or(U256::ZERO);
        let mut withdrawn = existing
            .as_ref()
            .and_then(|v| U256::from_str(&v.withdrawn).ok())
            .unwrap_or(U256::ZERO);
        if let Some(d) = deposited_delta.and_then(|d| U256::from_str(d).ok()) {
            deposited = deposited.saturating_add(d);
        }
        if let Some(w) = withdrawn_delta.and_then(|w| U256::from_str(w).ok()) {
            withdrawn = withdrawn.saturating_add(w);
        }
        sqlx::query(
            "UPDATE vaults SET deposited = ?, withdrawn = ?, last_balance = COALESCE(?, last_balance),
               last_locked = COALESCE(?, last_locked), last_event_at = ? WHERE address = ?",
        )
        .bind(deposited.to_string())
        .bind(withdrawn.to_string())
        .bind(balance)
        .bind(locked)
        .bind(at)
        .bind(vault)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn vault_get(&self, address: &str) -> Result<Option<VaultRow>> {
        Ok(
            sqlx::query_as::<_, VaultRow>("SELECT * FROM vaults WHERE address = ?")
                .bind(address.to_ascii_lowercase())
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    pub async fn vault_for_writer(&self, writer: &str) -> Result<Option<VaultRow>> {
        Ok(
            sqlx::query_as::<_, VaultRow>("SELECT * FROM vaults WHERE writer = ?")
                .bind(writer.to_ascii_lowercase())
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    pub async fn vaults_all(&self) -> Result<Vec<VaultRow>> {
        Ok(
            sqlx::query_as::<_, VaultRow>("SELECT * FROM vaults ORDER BY created_block, address")
                .fetch_all(&self.pool)
                .await?,
        )
    }

    // ---- series -------------------------------------------------------------------------

    pub async fn insert_series(&self, s: &SeriesRow) -> Result<()> {
        sqlx::query(
            "INSERT OR REPLACE INTO series (id, writer, vault, receipt, issue_order_hash, exit_order_hash,
               settlement_order_hash, feed, quote_token, start, expiry, sale_end, sample_interval, unit_notional,
               cap_variance, anchor_variance, impact_per_unit, half_life, half_spread_bps, max_units,
               created_block, created_tx, created_at, issuance_stopped_at, closed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(s.id)
        .bind(&s.writer)
        .bind(&s.vault)
        .bind(&s.receipt)
        .bind(&s.issue_order_hash)
        .bind(&s.exit_order_hash)
        .bind(&s.settlement_order_hash)
        .bind(&s.feed)
        .bind(&s.quote_token)
        .bind(s.start)
        .bind(s.expiry)
        .bind(s.sale_end)
        .bind(s.sample_interval)
        .bind(&s.unit_notional)
        .bind(&s.cap_variance)
        .bind(&s.anchor_variance)
        .bind(&s.impact_per_unit)
        .bind(s.half_life)
        .bind(s.half_spread_bps)
        .bind(&s.max_units)
        .bind(s.created_block)
        .bind(&s.created_tx)
        .bind(s.created_at)
        .bind(s.issuance_stopped_at)
        .bind(s.closed_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn mark_issuance_stopped(&self, series_id: i64, at: i64) -> Result<()> {
        sqlx::query("UPDATE series SET issuance_stopped_at = ? WHERE id = ?")
            .bind(at)
            .bind(series_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn mark_closed(&self, series_id: i64, at: i64) -> Result<()> {
        sqlx::query("UPDATE series SET closed_at = ? WHERE id = ?")
            .bind(at)
            .bind(series_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn series_all(&self) -> Result<Vec<SeriesRow>> {
        Ok(
            sqlx::query_as::<_, SeriesRow>("SELECT * FROM series ORDER BY id")
                .fetch_all(&self.pool)
                .await?,
        )
    }

    pub async fn series_page(&self, limit: u64, offset: u64) -> Result<Vec<SeriesRow>> {
        let limit = i64::try_from(limit).context("series page limit exceeds sqlite range")?;
        let offset = i64::try_from(offset).context("series page offset exceeds sqlite range")?;
        Ok(
            sqlx::query_as::<_, SeriesRow>("SELECT * FROM series ORDER BY id LIMIT ? OFFSET ?")
                .bind(limit)
                .bind(offset)
                .fetch_all(&self.pool)
                .await?,
        )
    }

    pub async fn series_get(&self, id: i64) -> Result<Option<SeriesRow>> {
        Ok(
            sqlx::query_as::<_, SeriesRow>("SELECT * FROM series WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    pub async fn series_for_vault(&self, vault: &str) -> Result<Vec<SeriesRow>> {
        Ok(
            sqlx::query_as::<_, SeriesRow>("SELECT * FROM series WHERE vault = ? ORDER BY id")
                .bind(vault.to_ascii_lowercase())
                .fetch_all(&self.pool)
                .await?,
        )
    }

    pub async fn series_count(&self) -> Result<u64> {
        let row = sqlx::query("SELECT COUNT(*) AS n FROM series")
            .fetch_one(&self.pool)
            .await?;
        nonnegative_u64(row.get::<i64, _>("n"), "series count")
    }

    // ---- orders -------------------------------------------------------------------------

    pub async fn insert_order(
        &self,
        order_hash: &str,
        series_id: i64,
        leg: &str,
        maker: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT OR REPLACE INTO orders (order_hash, series_id, leg, maker) VALUES (?, ?, ?, ?)",
        )
        .bind(order_hash)
        .bind(series_id)
        .bind(leg)
        .bind(maker)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// `(order_hash, series_id, leg)` for every registered order — rebuilds the indexer's order map.
    pub async fn orders_all(&self) -> Result<Vec<(String, i64, String)>> {
        let rows = sqlx::query("SELECT order_hash, series_id, leg FROM orders")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .iter()
            .map(|r| (r.get("order_hash"), r.get("series_id"), r.get("leg")))
            .collect())
    }

    pub async fn orders_for(&self, series_id: i64) -> Result<Vec<(String, String)>> {
        let rows =
            sqlx::query("SELECT order_hash, leg FROM orders WHERE series_id = ? ORDER BY leg")
                .bind(series_id)
                .fetch_all(&self.pool)
                .await?;
        Ok(rows
            .iter()
            .map(|r| (r.get("order_hash"), r.get("leg")))
            .collect())
    }

    // ---- fills --------------------------------------------------------------------------

    pub async fn insert_fill(&self, f: &FillRow) -> Result<()> {
        sqlx::query(
            "INSERT OR REPLACE INTO fills (tx_hash, log_index, block, timestamp, series_id, leg, order_hash,
               maker_vault, taker, token_in, token_out, amount_in, amount_out, units, quote_amount, price_per_unit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&f.tx_hash)
        .bind(f.log_index)
        .bind(f.block)
        .bind(f.timestamp)
        .bind(f.series_id)
        .bind(&f.leg)
        .bind(&f.order_hash)
        .bind(&f.maker_vault)
        .bind(&f.taker)
        .bind(&f.token_in)
        .bind(&f.token_out)
        .bind(&f.amount_in)
        .bind(&f.amount_out)
        .bind(&f.units)
        .bind(&f.quote_amount)
        .bind(&f.price_per_unit)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn fills_for(&self, series_id: i64) -> Result<Vec<FillRow>> {
        Ok(sqlx::query_as::<_, FillRow>(
            "SELECT * FROM fills WHERE series_id = ? ORDER BY timestamp, block, log_index",
        )
        .bind(series_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn fills_page(
        &self,
        series_id: i64,
        limit: u64,
        offset: u64,
    ) -> Result<Vec<FillRow>> {
        let limit = i64::try_from(limit).context("fills page limit exceeds sqlite range")?;
        let offset = i64::try_from(offset).context("fills page offset exceeds sqlite range")?;
        Ok(sqlx::query_as::<_, FillRow>(
            "SELECT * FROM fills WHERE series_id = ? ORDER BY timestamp, block, log_index LIMIT ? OFFSET ?",
        )
        .bind(series_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await?)
    }

    /// Every fill a given taker had in a series, which is what an indexed cost basis is derived from.
    pub async fn fills_for_taker(&self, series_id: i64, taker: &str) -> Result<Vec<FillRow>> {
        Ok(sqlx::query_as::<_, FillRow>(
            "SELECT * FROM fills WHERE series_id = ? AND taker = ? ORDER BY timestamp, block, log_index",
        )
        .bind(series_id)
        .bind(taker.to_ascii_lowercase())
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn fill_stats(&self, series_id: i64) -> Result<FillStats> {
        Ok(stats_from_fills(&self.fills_for(series_id).await?))
    }

    pub async fn fill_stats_all(&self) -> Result<HashMap<i64, FillStats>> {
        let fills =
            sqlx::query_as::<_, FillRow>("SELECT * FROM fills ORDER BY series_id, timestamp")
                .fetch_all(&self.pool)
                .await?;
        let mut by: HashMap<i64, Vec<FillRow>> = HashMap::new();
        for f in fills {
            by.entry(f.series_id).or_default().push(f);
        }
        Ok(by
            .into_iter()
            .map(|(k, v)| (k, stats_from_fills(&v)))
            .collect())
    }

    // ---- checkpoints and finalizations --------------------------------------------------

    pub async fn insert_checkpoint(&self, c: &CheckpointRow) -> Result<()> {
        sqlx::query(
            "INSERT OR REPLACE INTO checkpoints (tx_hash, log_index, block, timestamp, series_id, from_sample,
               to_sample, processed_through, last_round_id, sum_squared_returns)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&c.tx_hash)
        .bind(c.log_index)
        .bind(c.block)
        .bind(c.timestamp)
        .bind(c.series_id)
        .bind(c.from_sample)
        .bind(c.to_sample)
        .bind(c.processed_through)
        .bind(&c.last_round_id)
        .bind(&c.sum_squared_returns)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn checkpoints_for(&self, series_id: i64) -> Result<Vec<CheckpointRow>> {
        Ok(sqlx::query_as::<_, CheckpointRow>(
            "SELECT * FROM checkpoints WHERE series_id = ? ORDER BY processed_through, block, log_index",
        )
        .bind(series_id)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn insert_finalization(&self, f: &FinalizationRow) -> Result<()> {
        sqlx::query(
            "INSERT OR REPLACE INTO finalizations (series_id, tx_hash, block, timestamp, final_variance,
               capped_variance, payout_per_unit, outstanding_units, released_collateral)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(f.series_id)
        .bind(&f.tx_hash)
        .bind(f.block)
        .bind(f.timestamp)
        .bind(&f.final_variance)
        .bind(&f.capped_variance)
        .bind(&f.payout_per_unit)
        .bind(&f.outstanding_units)
        .bind(&f.released_collateral)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn finalization_for(&self, series_id: i64) -> Result<Option<FinalizationRow>> {
        Ok(
            sqlx::query_as::<_, FinalizationRow>("SELECT * FROM finalizations WHERE series_id = ?")
                .bind(series_id)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    // ---- vault and aqua events ----------------------------------------------------------

    pub async fn insert_vault_event(&self, e: &VaultEventRow) -> Result<()> {
        sqlx::query(
            "INSERT OR REPLACE INTO vault_events (tx_hash, log_index, block, timestamp, vault, kind, actor,
               amount, balance, locked, reference)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&e.tx_hash)
        .bind(e.log_index)
        .bind(e.block)
        .bind(e.timestamp)
        .bind(&e.vault)
        .bind(&e.kind)
        .bind(&e.actor)
        .bind(&e.amount)
        .bind(&e.balance)
        .bind(&e.locked)
        .bind(&e.reference)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn vault_events_for(&self, vault: &str, limit: u64) -> Result<Vec<VaultEventRow>> {
        let limit = i64::try_from(limit).context("vault event limit exceeds sqlite range")?;
        Ok(sqlx::query_as::<_, VaultEventRow>(
            "SELECT * FROM vault_events WHERE vault = ? ORDER BY timestamp DESC, block DESC, log_index DESC LIMIT ?",
        )
        .bind(vault.to_ascii_lowercase())
        .bind(limit)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn insert_aqua_event(&self, e: &AquaEventRow) -> Result<()> {
        sqlx::query(
            "INSERT OR REPLACE INTO aqua_events (tx_hash, log_index, block, timestamp, kind, maker, app, strategy_hash,
               series_id, leg, token, amount, strategy)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&e.tx_hash)
        .bind(e.log_index)
        .bind(e.block)
        .bind(e.timestamp)
        .bind(&e.kind)
        .bind(&e.maker)
        .bind(&e.app)
        .bind(&e.strategy_hash)
        .bind(e.series_id)
        .bind(&e.leg)
        .bind(&e.token)
        .bind(&e.amount)
        .bind(&e.strategy)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn aqua_events_for(&self, series_id: i64) -> Result<Vec<AquaEventRow>> {
        Ok(sqlx::query_as::<_, AquaEventRow>(
            "SELECT * FROM aqua_events WHERE series_id = ? ORDER BY timestamp, block, log_index",
        )
        .bind(series_id)
        .fetch_all(&self.pool)
        .await?)
    }

    // ---- chainlink rounds cache ---------------------------------------------------------

    pub async fn rounds_for_phase(&self, feed: Address, phase: u16) -> Result<Vec<Round>> {
        let rows = sqlx::query("SELECT agg_round, answer, started_at, updated_at FROM rounds WHERE feed = ? AND phase = ? AND updated_at != 0 ORDER BY agg_round")
            .bind(addr_key(feed))
            .bind(phase as i64)
            .fetch_all(&self.pool)
            .await?;
        rows.iter()
            .map(|r| {
                let answer = r
                    .get::<String, _>("answer")
                    .parse()
                    .context("invalid cached round answer")?;
                Ok(Round {
                    phase,
                    agg_round: nonnegative_u64(r.get("agg_round"), "aggregator round")?,
                    answer,
                    started_at: nonnegative_u64(r.get("started_at"), "round started_at")?,
                    updated_at: nonnegative_u64(r.get("updated_at"), "round updated_at")?,
                })
            })
            .collect()
    }

    pub async fn put_rounds(&self, feed: Address, rounds: &[Round]) -> Result<()> {
        if rounds.is_empty() {
            return Ok(());
        }
        let key = addr_key(feed);
        let mut tx = self.pool.begin().await?;
        for r in rounds {
            sqlx::query(
                "INSERT OR IGNORE INTO rounds (feed, phase, agg_round, round_id, answer, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&key)
            .bind(r.phase as i64)
            .bind(sqlite_i64(r.agg_round, "aggregator round")?)
            .bind(r.round_id().to_string())
            .bind(r.answer.to_string())
            .bind(sqlite_i64(r.started_at, "round started_at")?)
            .bind(sqlite_i64(r.updated_at, "round updated_at")?)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn phase_last(&self, feed: Address, phase: u16) -> Result<Option<u64>> {
        let row = sqlx::query("SELECT last_round FROM phases WHERE feed = ? AND phase = ?")
            .bind(addr_key(feed))
            .bind(phase as i64)
            .fetch_optional(&self.pool)
            .await?;
        row.and_then(|r| r.get::<Option<i64>, _>("last_round"))
            .map(|v| nonnegative_u64(v, "phase last round"))
            .transpose()
    }

    pub async fn set_phase_last(&self, feed: Address, phase: u16, last: u64) -> Result<()> {
        sqlx::query("INSERT OR REPLACE INTO phases (feed, phase, last_round) VALUES (?, ?, ?)")
            .bind(addr_key(feed))
            .bind(phase as i64)
            .bind(sqlite_i64(last, "phase last round")?)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn coverage(&self, feed: Address, phase: u16) -> Result<Vec<(u64, u64)>> {
        let rows = sqlx::query(
            "SELECT lo, hi FROM round_coverage WHERE feed = ? AND phase = ? ORDER BY lo",
        )
        .bind(addr_key(feed))
        .bind(phase as i64)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|r| {
                Ok((
                    nonnegative_u64(r.get("lo"), "coverage lo")?,
                    nonnegative_u64(r.get("hi"), "coverage hi")?,
                ))
            })
            .collect()
    }

    pub async fn replace_coverage(
        &self,
        feed: Address,
        phase: u16,
        cov: &[(u64, u64)],
    ) -> Result<()> {
        let key = addr_key(feed);
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM round_coverage WHERE feed = ? AND phase = ?")
            .bind(&key)
            .bind(phase as i64)
            .execute(&mut *tx)
            .await?;
        for (lo, hi) in cov {
            sqlx::query("INSERT INTO round_coverage (feed, phase, lo, hi) VALUES (?, ?, ?, ?)")
                .bind(&key)
                .bind(phase as i64)
                .bind(sqlite_i64(*lo, "coverage lo")?)
                .bind(sqlite_i64(*hi, "coverage hi")?)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}

fn stats_from_fills(fills: &[FillRow]) -> FillStats {
    let mut s = FillStats {
        count: fills.len() as u64,
        ..Default::default()
    };
    for f in fills {
        let quote = U256::from_str(&f.quote_amount).unwrap_or(U256::ZERO);
        let units = U256::from_str(&f.units).unwrap_or(U256::ZERO);
        match f.leg.as_str() {
            "issue" => {
                s.issue_count += 1;
                s.premium_quote = s.premium_quote.saturating_add(quote);
                s.units_issued = s.units_issued.saturating_add(units);
            }
            "exit" => {
                s.exit_count += 1;
                s.exit_quote = s.exit_quote.saturating_add(quote);
                s.units_exited = s.units_exited.saturating_add(units);
            }
            "settle" => {
                s.settle_count += 1;
                s.settlement_quote = s.settlement_quote.saturating_add(quote);
                s.units_settled = s.units_settled.saturating_add(units);
            }
            _ => {}
        }
        if let Ok(t) = nonnegative_u64(f.timestamp, "fill timestamp") {
            s.last_fill_at = Some(s.last_fill_at.map_or(t, |x| x.max(t)));
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fill(leg: &str, quote: &str, units: &str, log_index: i64) -> FillRow {
        FillRow {
            tx_hash: format!("0x{log_index:064x}"),
            log_index,
            block: 1,
            timestamp: 1_000 + log_index,
            series_id: 1,
            leg: leg.to_string(),
            order_hash: "0x00".into(),
            maker_vault: "0xvault".into(),
            taker: "0xtaker".into(),
            token_in: "0xin".into(),
            token_out: "0xout".into(),
            amount_in: "0".into(),
            amount_out: "0".into(),
            units: units.to_string(),
            quote_amount: quote.to_string(),
            price_per_unit: "0".into(),
        }
    }

    #[tokio::test]
    async fn schema_is_versioned_and_migration_is_idempotent() {
        let db = Db::connect_memory().await.unwrap();
        db.migrate(false).await.unwrap();
        assert_eq!(db.schema_version().await.unwrap(), Some(SCHEMA_VERSION));
    }

    #[tokio::test]
    async fn an_older_schema_needs_an_explicit_reset() {
        let db = Db::connect_memory().await.unwrap();
        sqlx::query("UPDATE schema_meta SET version = 1 WHERE id = 1")
            .execute(&db.pool)
            .await
            .unwrap();
        let err = db.migrate(false).await.unwrap_err().to_string();
        assert!(err.contains("--reset-db"), "unexpected error: {err}");
        // and with the explicit flag it rebuilds
        db.migrate(true).await.unwrap();
        assert_eq!(db.schema_version().await.unwrap(), Some(SCHEMA_VERSION));
    }

    #[tokio::test]
    async fn a_newer_schema_is_refused() {
        let db = Db::connect_memory().await.unwrap();
        sqlx::query("UPDATE schema_meta SET version = 99 WHERE id = 1")
            .execute(&db.pool)
            .await
            .unwrap();
        let err = db.migrate(true).await.unwrap_err().to_string();
        assert!(err.contains("newer than this binary"), "unexpected: {err}");
    }

    /// The three legs must be counted separately: issuance money comes in, exit and settlement money
    /// goes out, and adding them together would produce a number that means nothing.
    #[test]
    fn fill_stats_separate_the_three_legs() {
        let fills = vec![
            fill("issue", "1000000", "1000000000000000000", 0),
            fill("issue", "500000", "500000000000000000", 1),
            fill("exit", "300000", "400000000000000000", 2),
            fill("settle", "700000", "1100000000000000000", 3),
        ];
        let s = stats_from_fills(&fills);
        assert_eq!(s.count, 4);
        assert_eq!(s.issue_count, 2);
        assert_eq!(s.exit_count, 1);
        assert_eq!(s.settle_count, 1);
        assert_eq!(s.premium_quote, U256::from(1_500_000u64));
        assert_eq!(s.exit_quote, U256::from(300_000u64));
        assert_eq!(s.settlement_quote, U256::from(700_000u64));
        assert_eq!(s.units_issued, U256::from(1_500_000_000_000_000_000u128));
        assert_eq!(s.units_exited, U256::from(400_000_000_000_000_000u128));
        assert_eq!(s.units_settled, U256::from(1_100_000_000_000_000_000u128));
        assert_eq!(s.last_fill_at, Some(1_003));
    }

    #[tokio::test]
    async fn the_order_map_survives_a_restart() {
        let db = Db::connect_memory().await.unwrap();
        db.insert_order("0xaa", 1, "issue", "0xvault")
            .await
            .unwrap();
        db.insert_order("0xbb", 1, "exit", "0xvault").await.unwrap();
        db.insert_order("0xcc", 1, "settle", "0xvault")
            .await
            .unwrap();
        let mut rows = db.orders_all().await.unwrap();
        rows.sort();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], ("0xaa".to_string(), 1, "issue".to_string()));
        assert_eq!(db.orders_for(1).await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn resetting_chain_state_keeps_the_feed_cache() {
        let db = Db::connect_memory().await.unwrap();
        db.insert_order("0xaa", 1, "issue", "0xvault")
            .await
            .unwrap();
        db.set_phase_last(Address::ZERO, 3, 42).await.unwrap();
        db.reset_chain_state().await.unwrap();
        assert!(db.orders_all().await.unwrap().is_empty());
        assert_eq!(db.phase_last(Address::ZERO, 3).await.unwrap(), Some(42));
    }
}
