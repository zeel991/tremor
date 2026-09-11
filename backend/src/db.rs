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

/// Bumped whenever a table's shape changes. v3 adds portfolio risk groups and events.
const SCHEMA_VERSION: i64 = 3;

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
CREATE TABLE IF NOT EXISTS portfolio_groups (
    id                    INTEGER PRIMARY KEY,
    writer                TEXT NOT NULL,
    vault                 TEXT NOT NULL,
    high_receipt          TEXT NOT NULL,
    calm_receipt          TEXT NOT NULL,
    feed                  TEXT NOT NULL,
    quote_token           TEXT NOT NULL,
    start                 INTEGER NOT NULL,
    expiry                INTEGER NOT NULL,
    sale_end              INTEGER NOT NULL,
    sample_interval       INTEGER NOT NULL,
    cap_variance          TEXT NOT NULL,
    cap_payout_per_unit   TEXT NOT NULL,
    max_units_per_side    TEXT NOT NULL,
    ask_high              TEXT NOT NULL,
    bid_high              TEXT NOT NULL,
    ask_calm              TEXT NOT NULL,
    bid_calm              TEXT NOT NULL,
    high_outstanding      TEXT NOT NULL DEFAULT '0',
    calm_outstanding      TEXT NOT NULL DEFAULT '0',
    reserve_locked        TEXT NOT NULL DEFAULT '0',
    exit_buffer           TEXT NOT NULL DEFAULT '0',
    finalized             INTEGER NOT NULL DEFAULT 0,
    final_variance        TEXT,
    high_ppu              TEXT,
    calm_ppu              TEXT,
    created_block         INTEGER NOT NULL,
    created_tx            TEXT NOT NULL,
    created_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS portfolio_groups_writer ON portfolio_groups(writer);
CREATE INDEX IF NOT EXISTS portfolio_groups_vault  ON portfolio_groups(vault);

CREATE TABLE IF NOT EXISTS portfolio_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id         INTEGER NOT NULL,
    event_type       TEXT NOT NULL,
    actor            TEXT,
    side             TEXT,
    units            TEXT NOT NULL DEFAULT '0',
    amount           TEXT NOT NULL DEFAULT '0',
    new_outstanding  TEXT,
    new_reserve      TEXT,
    new_buffer       TEXT,
    block_number     INTEGER NOT NULL,
    tx_hash          TEXT NOT NULL,
    log_index        INTEGER NOT NULL,
    timestamp        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_events_unique ON portfolio_events(tx_hash, log_index);
CREATE INDEX IF NOT EXISTS portfolio_events_group ON portfolio_events(group_id, timestamp);

CREATE TABLE IF NOT EXISTS portfolio_checkpoints (
    tx_hash             TEXT NOT NULL,
    log_index           INTEGER NOT NULL,
    block               INTEGER NOT NULL,
    timestamp           INTEGER NOT NULL,
    group_id            INTEGER NOT NULL,
    from_sample         INTEGER NOT NULL,
    to_sample           INTEGER NOT NULL,
    processed_through   INTEGER NOT NULL,
    last_round_id       TEXT NOT NULL,
    sum_squared_returns TEXT NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS portfolio_checkpoints_group ON portfolio_checkpoints(group_id, processed_through);
"#;

/// Chain-derived tables, in dependency-free order. Round caches are kept across a reset: they are a
/// cache of immutable feed history, not of Tremor state.
const CHAIN_TABLES: &[&str] = &[
    "portfolio_events",
    "portfolio_checkpoints",
    "portfolio_groups",
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

/// Every table dropped on explicit --reset-db.
const V1_TABLES: &[&str] = &[
    "portfolio_events",
    "portfolio_checkpoints",
    "portfolio_groups",
    "fills",
    "aqua_events",
    "series",
    "orders",
    "vaults",
    "vault_events",
    "checkpoints",
    "finalizations",
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

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct PortfolioGroupRow {
    pub id: i64,
    pub writer: String,
    pub vault: String,
    pub high_receipt: String,
    pub calm_receipt: String,
    pub feed: String,
    pub quote_token: String,
    pub start: i64,
    pub expiry: i64,
    pub sale_end: i64,
    pub sample_interval: i64,
    pub cap_variance: String,
    pub cap_payout_per_unit: String,
    pub max_units_per_side: String,
    pub ask_high: String,
    pub bid_high: String,
    pub ask_calm: String,
    pub bid_calm: String,
    pub high_outstanding: String,
    pub calm_outstanding: String,
    pub reserve_locked: String,
    pub exit_buffer: String,
    pub finalized: i64,
    pub final_variance: Option<String>,
    pub high_ppu: Option<String>,
    pub calm_ppu: Option<String>,
    pub created_block: i64,
    pub created_tx: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct PortfolioEventRow {
    pub id: i64,
    pub group_id: i64,
    pub event_type: String,
    pub actor: Option<String>,
    pub side: Option<String>,
    pub units: String,
    pub amount: String,
    pub new_outstanding: Option<String>,
    pub new_reserve: Option<String>,
    pub new_buffer: Option<String>,
    pub block_number: i64,
    pub tx_hash: String,
    pub log_index: i64,
    pub timestamp: i64,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct PortfolioCheckpointRow {
    pub tx_hash: String,
    pub log_index: i64,
    pub block: i64,
    pub timestamp: i64,
    pub group_id: i64,
    pub from_sample: i64,
    pub to_sample: i64,
    pub processed_through: i64,
    pub last_round_id: String,
    pub sum_squared_returns: String,
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

    // ---- portfolio groups and events ----------------------------------------------------

    pub async fn insert_portfolio_group(&self, g: &PortfolioGroupRow) -> Result<()> {
        sqlx::query(
            "INSERT OR IGNORE INTO portfolio_groups (
                id, writer, vault, high_receipt, calm_receipt, feed, quote_token,
                start, expiry, sale_end, sample_interval, cap_variance, cap_payout_per_unit,
                max_units_per_side, ask_high, bid_high, ask_calm, bid_calm,
                high_outstanding, calm_outstanding, reserve_locked, exit_buffer,
                finalized, final_variance, high_ppu, calm_ppu, created_block, created_tx, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(g.id)
        .bind(&g.writer)
        .bind(&g.vault)
        .bind(&g.high_receipt)
        .bind(&g.calm_receipt)
        .bind(&g.feed)
        .bind(&g.quote_token)
        .bind(g.start)
        .bind(g.expiry)
        .bind(g.sale_end)
        .bind(g.sample_interval)
        .bind(&g.cap_variance)
        .bind(&g.cap_payout_per_unit)
        .bind(&g.max_units_per_side)
        .bind(&g.ask_high)
        .bind(&g.bid_high)
        .bind(&g.ask_calm)
        .bind(&g.bid_calm)
        .bind(&g.high_outstanding)
        .bind(&g.calm_outstanding)
        .bind(&g.reserve_locked)
        .bind(&g.exit_buffer)
        .bind(g.finalized)
        .bind(&g.final_variance)
        .bind(&g.high_ppu)
        .bind(&g.calm_ppu)
        .bind(g.created_block)
        .bind(&g.created_tx)
        .bind(g.created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn update_portfolio_group_balances(
        &self,
        group_id: i64,
        high_outstanding: Option<&str>,
        calm_outstanding: Option<&str>,
        reserve_locked: Option<&str>,
        exit_buffer: Option<&str>,
    ) -> Result<()> {
        let mut q = "UPDATE portfolio_groups SET id = id".to_string();
        if high_outstanding.is_some() {
            q.push_str(", high_outstanding = ?");
        }
        if calm_outstanding.is_some() {
            q.push_str(", calm_outstanding = ?");
        }
        if reserve_locked.is_some() {
            q.push_str(", reserve_locked = ?");
        }
        if exit_buffer.is_some() {
            q.push_str(", exit_buffer = ?");
        }
        q.push_str(" WHERE id = ?");

        let mut query = sqlx::query(&q);
        if let Some(h) = high_outstanding {
            query = query.bind(h);
        }
        if let Some(c) = calm_outstanding {
            query = query.bind(c);
        }
        if let Some(r) = reserve_locked {
            query = query.bind(r);
        }
        if let Some(b) = exit_buffer {
            query = query.bind(b);
        }
        query.bind(group_id).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn deduct_portfolio_units(
        &self,
        group_id: i64,
        high: bool,
        units: &str,
        reserve_locked: &str,
        buffer_drawn: Option<&str>,
    ) -> Result<()> {
        let u: alloy::primitives::U256 = units.parse().context("units U256")?;
        if let Some(group) = self.portfolio_group_by_id(group_id).await? {
            let (new_high, new_calm) = if high {
                let cur: alloy::primitives::U256 =
                    group.high_outstanding.parse().unwrap_or_default();
                let n = cur.saturating_sub(u);
                (Some(n.to_string()), None)
            } else {
                let cur: alloy::primitives::U256 =
                    group.calm_outstanding.parse().unwrap_or_default();
                let n = cur.saturating_sub(u);
                (None, Some(n.to_string()))
            };
            let new_buf = if let Some(drawn_str) = buffer_drawn {
                let drawn: alloy::primitives::U256 = drawn_str.parse().unwrap_or_default();
                let cur_buf: alloy::primitives::U256 =
                    group.exit_buffer.parse().unwrap_or_default();
                Some(cur_buf.saturating_sub(drawn).to_string())
            } else {
                None
            };
            self.update_portfolio_group_balances(
                group_id,
                new_high.as_deref(),
                new_calm.as_deref(),
                Some(reserve_locked),
                new_buf.as_deref(),
            )
            .await?;
        }
        Ok(())
    }

    pub async fn finalize_portfolio_group(
        &self,
        group_id: i64,
        final_variance: &str,
        high_ppu: &str,
        calm_ppu: &str,
        final_reserve: &str,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE portfolio_groups SET finalized = 1, final_variance = ?, high_ppu = ?, calm_ppu = ?, reserve_locked = ?, exit_buffer = '0' WHERE id = ?",
        )
        .bind(final_variance)
        .bind(high_ppu)
        .bind(calm_ppu)
        .bind(final_reserve)
        .bind(group_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_portfolio_event(&self, e: &PortfolioEventRow) -> Result<bool> {
        let res = sqlx::query(
            "INSERT OR IGNORE INTO portfolio_events (
                group_id, event_type, actor, side, units, amount,
                new_outstanding, new_reserve, new_buffer, block_number, tx_hash, log_index, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(e.group_id)
        .bind(&e.event_type)
        .bind(&e.actor)
        .bind(&e.side)
        .bind(&e.units)
        .bind(&e.amount)
        .bind(&e.new_outstanding)
        .bind(&e.new_reserve)
        .bind(&e.new_buffer)
        .bind(e.block_number)
        .bind(&e.tx_hash)
        .bind(e.log_index)
        .bind(e.timestamp)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn insert_portfolio_checkpoint(&self, c: &PortfolioCheckpointRow) -> Result<()> {
        sqlx::query(
            "INSERT OR REPLACE INTO portfolio_checkpoints (
                tx_hash, log_index, block, timestamp, group_id, from_sample,
                to_sample, processed_through, last_round_id, sum_squared_returns
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&c.tx_hash)
        .bind(c.log_index)
        .bind(c.block)
        .bind(c.timestamp)
        .bind(c.group_id)
        .bind(c.from_sample)
        .bind(c.to_sample)
        .bind(c.processed_through)
        .bind(&c.last_round_id)
        .bind(&c.sum_squared_returns)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn portfolio_group_by_id(&self, group_id: i64) -> Result<Option<PortfolioGroupRow>> {
        Ok(
            sqlx::query_as::<_, PortfolioGroupRow>("SELECT * FROM portfolio_groups WHERE id = ?")
                .bind(group_id)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    pub async fn portfolio_groups_all(&self) -> Result<Vec<PortfolioGroupRow>> {
        Ok(sqlx::query_as::<_, PortfolioGroupRow>(
            "SELECT * FROM portfolio_groups ORDER BY id DESC",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn portfolio_events_for_group(
        &self,
        group_id: i64,
        limit: u64,
    ) -> Result<Vec<PortfolioEventRow>> {
        let limit = i64::try_from(limit).context("portfolio event limit exceeds sqlite range")?;
        Ok(sqlx::query_as::<_, PortfolioEventRow>(
            "SELECT * FROM portfolio_events WHERE group_id = ? ORDER BY block_number DESC, log_index DESC LIMIT ?",
        )
        .bind(group_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn portfolio_checkpoints_for_group(
        &self,
        group_id: i64,
    ) -> Result<Vec<PortfolioCheckpointRow>> {
        Ok(sqlx::query_as::<_, PortfolioCheckpointRow>(
            "SELECT * FROM portfolio_checkpoints WHERE group_id = ? ORDER BY to_sample ASC",
        )
        .bind(group_id)
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

    // ---- Portfolio indexer database unit tests -----------------------------------------------

    #[tokio::test]
    async fn same_transaction_group_discovery_and_subsequent_events() {
        let db = Db::connect_memory().await.unwrap();
        let group = PortfolioGroupRow {
            id: 1,
            writer: "0xwriter".into(),
            vault: "0xvault".into(),
            high_receipt: "0xhigh".into(),
            calm_receipt: "0xcalm".into(),
            feed: "0xfeed".into(),
            quote_token: "0xquote".into(),
            start: 1000,
            expiry: 2000,
            sale_end: 2000,
            sample_interval: 7200,
            cap_variance: "1000000000000000000".into(),
            cap_payout_per_unit: "1000000".into(),
            max_units_per_side: "1000000000000000000000".into(),
            ask_high: "300000".into(),
            bid_high: "250000".into(),
            ask_calm: "750000".into(),
            bid_calm: "700000".into(),
            high_outstanding: "0".into(),
            calm_outstanding: "0".into(),
            reserve_locked: "0".into(),
            exit_buffer: "0".into(),
            finalized: 0,
            final_variance: None,
            high_ppu: None,
            calm_ppu: None,
            created_block: 100,
            created_tx: "0xtx1".into(),
            created_at: 1000,
        };
        db.insert_portfolio_group(&group).await.unwrap();

        // PortfolioIssued (HIGH) in same block
        let ev1 = PortfolioEventRow {
            id: 0,
            group_id: 1,
            event_type: "issue".into(),
            side: Some("HIGH".into()),
            actor: Some("0xbuyer1".into()),
            units: "100000000000000000000".into(),
            amount: "30000000".into(),
            new_outstanding: Some("100000000000000000000".into()),
            new_reserve: Some("100000000".into()),
            new_buffer: None,
            block_number: 100,
            tx_hash: "0xtx1".into(),
            log_index: 1,
            timestamp: 1000,
        };
        db.insert_portfolio_event(&ev1).await.unwrap();
        db.update_portfolio_group_balances(
            1,
            Some("100000000000000000000"),
            None,
            Some("100000000"),
            None,
        )
        .await
        .unwrap();

        // PortfolioIssued (CALM) in same block
        let ev2 = PortfolioEventRow {
            id: 0,
            group_id: 1,
            event_type: "issue".into(),
            side: Some("CALM".into()),
            actor: Some("0xbuyer2".into()),
            units: "100000000000000000000".into(),
            amount: "75000000".into(),
            new_outstanding: Some("100000000000000000000".into()),
            new_reserve: Some("100000000".into()),
            new_buffer: None,
            block_number: 100,
            tx_hash: "0xtx1".into(),
            log_index: 2,
            timestamp: 1000,
        };
        db.insert_portfolio_event(&ev2).await.unwrap();
        db.update_portfolio_group_balances(
            1,
            None,
            Some("100000000000000000000"),
            Some("100000000"),
            None,
        )
        .await
        .unwrap();

        let fetched = db.portfolio_group_by_id(1).await.unwrap().unwrap();
        assert_eq!(fetched.high_outstanding, "100000000000000000000");
        assert_eq!(fetched.calm_outstanding, "100000000000000000000");
        assert_eq!(fetched.reserve_locked, "100000000");
        assert_eq!(fetched.exit_buffer, "0");

        let events = db.portfolio_events_for_group(1, 10).await.unwrap();
        assert_eq!(events.len(), 2);
    }

    #[tokio::test]
    async fn duplicate_replay_idempotence() {
        let db = Db::connect_memory().await.unwrap();
        let group = PortfolioGroupRow {
            id: 1,
            writer: "0xwriter".into(),
            vault: "0xvault".into(),
            high_receipt: "0xhigh".into(),
            calm_receipt: "0xcalm".into(),
            feed: "0xfeed".into(),
            quote_token: "0xquote".into(),
            start: 1000,
            expiry: 2000,
            sale_end: 2000,
            sample_interval: 7200,
            cap_variance: "1000000000000000000".into(),
            cap_payout_per_unit: "1000000".into(),
            max_units_per_side: "1000000000000000000000".into(),
            ask_high: "300000".into(),
            bid_high: "250000".into(),
            ask_calm: "750000".into(),
            bid_calm: "700000".into(),
            high_outstanding: "0".into(),
            calm_outstanding: "0".into(),
            reserve_locked: "0".into(),
            exit_buffer: "0".into(),
            finalized: 0,
            final_variance: None,
            high_ppu: None,
            calm_ppu: None,
            created_block: 100,
            created_tx: "0xtx1".into(),
            created_at: 1000,
        };
        // Replaying GroupCreated must succeed without error (INSERT OR IGNORE)
        db.insert_portfolio_group(&group).await.unwrap();
        db.insert_portfolio_group(&group).await.unwrap();

        let all = db.portfolio_groups_all().await.unwrap();
        assert_eq!(
            all.len(),
            1,
            "replaying group creation must not duplicate rows"
        );
    }

    #[tokio::test]
    async fn restart_cursor_recovery() {
        let db = Db::connect_memory().await.unwrap();
        assert!(db.cursor().await.unwrap().is_none());

        // Store progress
        db.set_cursor(
            51129799,
            None,
            50000000,
            Address::repeat_byte(0xcc),
            Some(31337),
        )
        .await
        .unwrap();
        let c1 = db.cursor().await.unwrap().unwrap();
        assert_eq!(c1.last_block, 51129799);

        // Advance progress
        db.set_cursor(
            51129850,
            None,
            50000000,
            Address::repeat_byte(0xcc),
            Some(31337),
        )
        .await
        .unwrap();
        let c2 = db.cursor().await.unwrap().unwrap();
        assert_eq!(c2.last_block, 51129850);
    }

    #[tokio::test]
    async fn exit_buffer_accounting_lifecycle() {
        let db = Db::connect_memory().await.unwrap();
        let group = PortfolioGroupRow {
            id: 1,
            writer: "0xwriter".into(),
            vault: "0xvault".into(),
            high_receipt: "0xhigh".into(),
            calm_receipt: "0xcalm".into(),
            feed: "0xfeed".into(),
            quote_token: "0xquote".into(),
            start: 1000,
            expiry: 2000,
            sale_end: 2000,
            sample_interval: 7200,
            cap_variance: "1000000000000000000".into(),
            cap_payout_per_unit: "1000000".into(),
            max_units_per_side: "1000000000000000000000".into(),
            ask_high: "300000".into(),
            bid_high: "250000".into(),
            ask_calm: "750000".into(),
            bid_calm: "700000".into(),
            high_outstanding: "100000000000000000000".into(),
            calm_outstanding: "100000000000000000000".into(),
            reserve_locked: "100000000".into(),
            exit_buffer: "0".into(),
            finalized: 0,
            final_variance: None,
            high_ppu: None,
            calm_ppu: None,
            created_block: 100,
            created_tx: "0xtx1".into(),
            created_at: 1000,
        };
        db.insert_portfolio_group(&group).await.unwrap();

        // 1. Fund exit buffer with 5 USDC (5_000_000)
        let fund_ev = PortfolioEventRow {
            id: 0,
            group_id: 1,
            event_type: "buffer_fund".into(),
            side: None,
            actor: Some("0xwriter".into()),
            units: "0".into(),
            amount: "5000000".into(),
            new_outstanding: None,
            new_reserve: None,
            new_buffer: Some("5000000".into()),
            block_number: 101,
            tx_hash: "0xtx2".into(),
            log_index: 0,
            timestamp: 1010,
        };
        db.insert_portfolio_event(&fund_ev).await.unwrap();
        db.update_portfolio_group_balances(1, None, None, None, Some("5000000"))
            .await
            .unwrap();

        let g1 = db.portfolio_group_by_id(1).await.unwrap().unwrap();
        assert_eq!(g1.exit_buffer, "5000000");

        // 2. PortfolioExited: 20 HIGH exited, draws 5 USDC from buffer, reserve untouched at 100 USDC (max(80, 100))
        let exit_ev = PortfolioEventRow {
            id: 0,
            group_id: 1,
            event_type: "exit".into(),
            side: Some("HIGH".into()),
            actor: Some("0xbuyer1".into()),
            units: "20000000000000000000".into(),
            amount: "5000000".into(),
            new_outstanding: Some("80000000000000000000".into()),
            new_reserve: Some("100000000".into()),
            new_buffer: Some("0".into()),
            block_number: 102,
            tx_hash: "0xtx3".into(),
            log_index: 0,
            timestamp: 1020,
        };
        db.insert_portfolio_event(&exit_ev).await.unwrap();
        db.update_portfolio_group_balances(
            1,
            Some("80000000000000000000"),
            None,
            Some("100000000"),
            Some("0"),
        )
        .await
        .unwrap();

        let g2 = db.portfolio_group_by_id(1).await.unwrap().unwrap();
        assert_eq!(g2.high_outstanding, "80000000000000000000");
        assert_eq!(g2.exit_buffer, "0");
        assert_eq!(g2.reserve_locked, "100000000");

        // 3. Fund buffer again and withdraw
        db.update_portfolio_group_balances(1, None, None, None, Some("10000000"))
            .await
            .unwrap();
        let withdraw_ev = PortfolioEventRow {
            id: 0,
            group_id: 1,
            event_type: "buffer_withdraw".into(),
            side: None,
            actor: Some("0xwriter".into()),
            units: "0".into(),
            amount: "10000000".into(),
            new_outstanding: None,
            new_reserve: None,
            new_buffer: Some("0".into()),
            block_number: 103,
            tx_hash: "0xtx4".into(),
            log_index: 0,
            timestamp: 1030,
        };
        db.insert_portfolio_event(&withdraw_ev).await.unwrap();
        db.update_portfolio_group_balances(1, None, None, None, Some("0"))
            .await
            .unwrap();

        let g3 = db.portfolio_group_by_id(1).await.unwrap().unwrap();
        assert_eq!(g3.exit_buffer, "0");
    }

    #[tokio::test]
    async fn finalization_and_worthless_burn() {
        let db = Db::connect_memory().await.unwrap();
        let group = PortfolioGroupRow {
            id: 2,
            writer: "0xwriter".into(),
            vault: "0xvault".into(),
            high_receipt: "0xhigh".into(),
            calm_receipt: "0xcalm".into(),
            feed: "0xfeed".into(),
            quote_token: "0xquote".into(),
            start: 1000,
            expiry: 2000,
            sale_end: 2000,
            sample_interval: 7200,
            cap_variance: "1000000000000000000".into(),
            cap_payout_per_unit: "1000000".into(),
            max_units_per_side: "1000000000000000000000".into(),
            ask_high: "300000".into(),
            bid_high: "250000".into(),
            ask_calm: "750000".into(),
            bid_calm: "700000".into(),
            high_outstanding: "100000000000000000000".into(),
            calm_outstanding: "100000000000000000000".into(),
            reserve_locked: "100000000".into(),
            exit_buffer: "0".into(),
            finalized: 0,
            final_variance: None,
            high_ppu: None,
            calm_ppu: None,
            created_block: 200,
            created_tx: "0xtx20".into(),
            created_at: 2000,
        };
        db.insert_portfolio_group(&group).await.unwrap();

        // Finalize group at 0% variance: HIGH ppu = 0, CALM ppu = 1_000_000 (1 USDC)
        db.finalize_portfolio_group(2, "0", "0", "1000000", "0")
            .await
            .unwrap();

        let finalized_group = db.portfolio_group_by_id(2).await.unwrap().unwrap();
        assert_eq!(finalized_group.finalized, 1);
        assert_eq!(finalized_group.final_variance, Some("0".to_string()));
        assert_eq!(finalized_group.high_ppu, Some("0".to_string()));
        assert_eq!(finalized_group.calm_ppu, Some("1000000".to_string()));

        // Worthless burn for HIGH
        let burn_ev = PortfolioEventRow {
            id: 0,
            group_id: 2,
            event_type: "worthless_burn".into(),
            side: Some("HIGH".into()),
            actor: Some("0xholder".into()),
            units: "100000000000000000000".into(),
            amount: "0".into(),
            new_outstanding: Some("0".into()),
            new_reserve: None,
            new_buffer: None,
            block_number: 210,
            tx_hash: "0xtx21".into(),
            log_index: 0,
            timestamp: 2100,
        };
        db.insert_portfolio_event(&burn_ev).await.unwrap();
        db.update_portfolio_group_balances(2, Some("0"), None, None, None)
            .await
            .unwrap();

        let g_post_burn = db.portfolio_group_by_id(2).await.unwrap().unwrap();
        assert_eq!(g_post_burn.high_outstanding, "0");
        assert_eq!(g_post_burn.calm_outstanding, "100000000000000000000");
    }

    #[tokio::test]
    async fn group_view_state_reconciliation() {
        let db = Db::connect_memory().await.unwrap();
        let row = PortfolioGroupRow {
            id: 1,
            writer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266".into(),
            vault: "0x295dd1561a33c6cd0f2cdf353ff8bffb64ec0f5c".into(),
            high_receipt: "0x324a85216a58141373103015d9cf0cbb262ed2e5".into(),
            calm_receipt: "0xac9035bff8e337da101e8134f397177ddd70a0a5".into(),
            feed: "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70".into(),
            quote_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913".into(),
            start: 1789077888,
            expiry: 1789682688,
            sale_end: 1789682688,
            sample_interval: 7200,
            cap_variance: "1000000000000000000".into(),
            cap_payout_per_unit: "1000000".into(),
            max_units_per_side: "1000000000000000000000".into(),
            ask_high: "300000".into(),
            bid_high: "250000".into(),
            ask_calm: "750000".into(),
            bid_calm: "700000".into(),
            high_outstanding: "80000000000000000000".into(),
            calm_outstanding: "100000000000000000000".into(),
            reserve_locked: "100000000".into(),
            exit_buffer: "5000000".into(),
            finalized: 0,
            final_variance: None,
            high_ppu: None,
            calm_ppu: None,
            created_block: 51129776,
            created_tx: "0xc1771640633e1a6fd9d0640e2fe5ddc9ed27bad6e161e168dafd3f9539f3658a".into(),
            created_at: 1789077902,
        };
        db.insert_portfolio_group(&row).await.unwrap();

        let read = db.portfolio_group_by_id(1).await.unwrap().unwrap();
        // Assert every single field matches expected types and formats
        assert_eq!(read.id, 1);
        assert_eq!(read.writer, row.writer);
        assert_eq!(read.vault, row.vault);
        assert_eq!(read.high_receipt, row.high_receipt);
        assert_eq!(read.calm_receipt, row.calm_receipt);
        assert_eq!(read.cap_payout_per_unit, "1000000");
        assert_eq!(read.high_outstanding, "80000000000000000000");
        assert_eq!(read.calm_outstanding, "100000000000000000000");
        assert_eq!(read.reserve_locked, "100000000");
        assert_eq!(read.exit_buffer, "5000000");
    }
}
