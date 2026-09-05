# Tremor backend (`tremor-api`)

Rust / axum read-model service for Tremor, the covered market for capped ETH realized-variance
receipts. It indexes the controller, the accumulator, the writer vaults, the official SwapVM router and
Aqua; caches Chainlink rounds; replicates the on-chain variance and pricing math off-chain for charts;
and serves JSON to the web app.

**It never holds keys and never sends transactions.** Checkpointing and finalization are permissionless
and are submitted from the web app with the user's own wallet, so there is no keeper here and no
server-side key to manage. Setting `CHECKPOINT_WORKER` or `CHECKPOINT_PRIVATE_KEY` is a startup error
rather than a no-op, so nobody is left believing automation is running when it is not.

Stack: Rust stable, axum 0.7, tokio, alloy 2.4 (`sol!` + HTTP provider + Multicall3), sqlx 0.8 (SQLite),
serde, tracing, tower-http (CORS, request tracing).

## Run

```bash
cd backend
source $HOME/.cargo/env
cargo build --release
RPC_URL=http://127.0.0.1:8545 DEPLOYMENT_JSON=../contracts/deployments/31337.json cargo run --release
# or: ./target/release/tremor-api
```

There is no placeholder-manifest mode. Startup verifies that every contract the manifest names has
code on the chain the RPC is serving, so a manifest of stub addresses fails rather than starting into a
state where half the endpoints work and the rest return 503 per request. To run against a public chain,
deploy there first and point `DEPLOYMENT_JSON` at the manifest `Deploy.s.sol` wrote.

`--reset-db` drops the indexed history and rebuilds it from the chain. It is the only way past a schema
change, and it is deliberately explicit: startup never destroys an indexed history on its own.

```bash
./target/release/tremor-api --reset-db
```

Startup fails closed. Before serving a request it checks that the RPC's chain id matches the manifest,
that every contract the manifest names has code on that chain, and that the controller agrees about its
own engine, accumulator and router. A misconfiguration is a startup error, not a per-request surprise.

Tests (RV reference vectors, the pricing replica against the Solidity's rounding, manifest versioning,
schema versioning, per-leg fill statistics, chunking, the three-leg orderHash map, phase-aware round
search against a fake two-/three-phase feed, coverage bookkeeping):

```bash
cargo test
cargo clippy --all-targets --all-features -- -D warnings
python3 tools/rv_check.py     # regenerates the RV reference vectors used in src/rv.rs
```

## Environment

| Var | Default | Meaning |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8545` | JSON-RPC endpoint (anvil fork, Base Sepolia, Base) |
| `DEPLOYMENT_JSON` | `../contracts/deployments/31337.json` | Manifest written by `Deploy.s.sol`. Must be `schemaVersion: 2`; a v1 manifest is rejected at startup. |
| `DATABASE_URL` | `sqlite://tremor.db` | SQLite file, created if missing (WAL mode) |
| `PORT` | `8787` | Listen port (binds `0.0.0.0`) |
| `POLL_MS` | `3000` | Indexer poll interval |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed origin(s), comma-separated, or `*` |
| `RUST_LOG` | `tremor_api=info,tower_http=info` | Structured log filter |

A `.env` file is read if present (see `.env.example`).

## Endpoints

All JSON, snake_case, unix seconds, big integers as decimal strings. Floats appear only as `*_float`
conveniences for axis scaling.

The Lens is authoritative for anything executable — the ask a buyer pays, the bid a holder hits, the
payout they redeem, the collateral that is locked. Anything this service computes itself is a replica
for charts and diagnostics and says so in a `source` field.

| Route | What it returns |
| --- | --- |
| `GET /health` | readiness: chain id, head vs indexed block, indexer error, schema versions. 503 until the index is caught up and the manifest matches the chain. |
| `GET /config` | the deployment manifest, including the router's source commit and bytecode hash, plus feed/quote decimals and the accumulator's per-call sample ceiling. |
| `GET /vault/:address` | a writer's protected vault: balance, locked, free, Aqua allowance, the series it backs, and its event history. Accepts the vault address or the writer's. |
| `GET /portfolio/:address` | a holder's indexed position per series: units bought, exited, settled, indexed cost and entry price. `cost_basis_known` is false for receipts that arrived by plain transfer. |
| `GET /series?limit=&offset=` | every series with its Lens state and per-leg fill statistics. |
| `GET /series/:id` | one series plus fills, Aqua events, checkpoints, the finalization record and the three order hashes. |
| `GET /series/:id/fills?limit=&offset=` | fills, with `leg` in `issue \| exit \| settle`. |
| `GET /series/:id/market?from=&to=&points=` | the market chart: realized volatility, the market's own quote volatility, and the executable bid/ask band at each point, reconstructed from indexed fills and checkpoints. The `lens` field carries the same values read from the chain so any divergence is visible. |
| `GET /series/:id/variance` | the sampled Chainlink path, per-sample log returns, and the replica's realized variance, alongside the chain's checkpointed figures. |
| `GET /series/:id/checkpoints` | the bounded checkpoint history and the finalization record. |
| `GET /series/:id/quote?issue_usdc=&issue_units=&exit_units=&settle_units=` | executable quotes for all three legs, straight from the Lens, with the leg-open flags so a zero cannot be mistaken for a price. |
| `GET /series/:id/aqua` | the Aqua `Shipped`/`Docked`/`Pulled`/`Pushed` events for this series' three strategies. |
| `GET /variance/trailing?window=&interval=` | trailing realized variance and volatility on the configured feed. |
| `GET /feed/history?from=&to=&interval=` | sampled Chainlink prices with round ids. |
| `GET /lvr?pool_value_usd=&horizon_days=&window=` | a gross loss-versus-rebalancing sizing estimate and the units of each live series whose maximum payout matches it. Not a replicating hedge; the response carries that caveat. |

Oracle unavailability is distinct from zero variance: a window that predates the feed is a 400 with the
reason, an unreachable feed is a 503, and a genuinely flat path returns zero.

## How the indexer works

* Starts at `deploymentBlock` (or the saved `cursor`) and polls `eth_getLogs` every `POLL_MS` in
  ≤2000-block chunks with a single filter: addresses `[factory, router, aqua]`, topic0 ∈
  {`SeriesCreated`, `Swapped`, `Shipped`, `Docked`, `Pulled`, `Pushed`} (fragments from §3.1, verified
  against `contracts/lib/swap-vm` and `@1inch/aqua`).
* `SeriesCreated` → row in `series` (all `SeriesParams`, receipt, both order hashes, creation block/tx/time) and
  an in-memory `orderHash → (series_id, leg)` map (rebuilt from SQLite on restart).
* `Swapped` → `fills` if the `orderHash` is a known series order. `units` is the receipt side,
  `price_per_unit = usdc · 1e18 / units` (USDC 6-dec per whole unit).
* Aqua events are kept only when `app == router`; `strategyHash == orderHash` (§2.2 invariant) maps them
  to a series/leg → `aqua_events`.
* After each chunk the `cursor` row stores `last_block` + its block hash + the manifest's
  `deploymentBlock`/`factory`. On every tick a reset is detected when the head is below the cursor,
  the block hash at the cursor changed (anvil restarted / re-ran the demo), or the manifest changed;
  all derived tables (including the rounds cache) are truncated and indexing restarts from `deploymentBlock`.
* Block timestamps come from the log (`blockTimestamp`, when the node provides it) or one
  `eth_getBlockByNumber` per distinct block.

Tables: `schema_meta`, `series`, `fills`, `aqua_events`, `rounds`, `phases`, `round_coverage`, `cursor`
(schema in `src/db.rs`, executed at startup).

## Chainlink module (`src/chainlink.rs`)

Replicates `RealizedVariance.priceAt` (§3.3): proxy `roundId = phase << 64 | aggregatorRound`; for
phases `p, p-1, …` if round 1 of the phase has `updatedAt <= t`, binary-search that phase for the
largest round with `updatedAt <= t`; otherwise fall back to the previous phase; if none matches →
`WindowPredatesFeed` (HTTP 400). **A round "does not exist" when `getRoundData` reverts OR returns
`updatedAt == 0`** — the OCR aggregators behind the real Base ETH/USD proxy return zeroed data for
unknown ids ≤ 2^32 rather than reverting (verified by raw `eth_call`; `RealizedVariance.sol` handles it
the same way). The last round of a closed phase is found once by exponential probing + binary search
and cached.

Sampling a window (`t_i = start + i·Δ`) groups the sample times by serving phase, locates the boundary
rounds with the cached binary search, then dense-fetches every round in between through **Multicall3**
(`0xcA11…CA11`, 250 `getRoundData` per `eth_call`; sequential fallback when Multicall3 is not deployed,
e.g. a bare anvil with `MockAggregator`). Rounds and per-phase coverage intervals are persisted in SQLite
and mirrored in memory, so repeated/overlapping windows cost only `latestRoundData` + a few cached
lookups. Public RPC rate limits (`-32016 over rate limit` on mainnet.base.org) are retried with backoff.

RV math (`src/rv.rs`): `r_i = ln(P_i/P_{i-1})`, `RV = Σ r_i² · 31 536 000 / (end − start)` in f64;
WAD strings are `round(rv·1e18)`. The settlement cap is **not** applied off-chain.

Implied variance (`src/implied.rs`): per premium order `excess(t) = excess_last · 2^(−(t−lastTs)/halfLife)`,
`K(t) = base + excess(t)`, and after each fill `excess += bumpPerUnit · u / 1e18` (fills replayed in
block order from the indexed `Swapped` events; `halfLife = 0` → no decay).

LVR (`/lvr`): `σ² =` trailing RV, `E[LVR] ≈ V · σ² · T / 8`, `hedgeUnits = (V · T / 8) / unitNotional`
for every series whose expiry is in the future (units as 18-dec WAD strings, plus floats).

## Refreshing ABIs

The Lens bindings come from `abi/TremorLens.json` when that file exists (`build.rs` sets
`cfg(lens_abi_json)`); otherwise from the hand-written `sol!` block in `src/abi.rs` that mirrors
ARCHITECTURE §2.2. After changing `TremorLens.sol`:

```bash
cd contracts && forge build
cd ../backend && tools/refresh_abi.sh            # copies contracts/out/TremorLens.sol/TremorLens.json → abi/TremorLens.json (abi array only)
cargo build                                       # bindings regenerate automatically
TREMOR_LENS_FROM_SOL=1 cargo build                # force the §2.2 sol! definitions instead
```

The Rust code accesses Lens fields by name (`state.params.unitNotional`, `state.coverage.ratioBps`, …), so
a renamed/removed field fails at compile time rather than at runtime. Factory/Router/Aqua/Chainlink
fragments are small and kept as `sol!` text; a unit test asserts their event signatures/topic hashes
match the §3.1 fragments (`SeriesCreated` with the struct param hashes identically to the tuple form).

## Layout

| File | Responsibility |
| --- | --- |
| `src/abi.rs` | Contract bindings. Lens bindings come from `abi/TremorLens.json` via `build.rs`, so the read model cannot drift from the deployed contract without the build noticing. A test pins every event signature the indexer filters on. |
| `src/config.rs` | Environment and the versioned deployment manifest. |
| `src/db.rs` | SQLite schema v2 and every query. Tables: `vaults`, `series`, `orders`, `fills`, `checkpoints`, `finalizations`, `vault_events`, `aqua_events`, `rounds`, `phases`, `round_coverage`, `cursor`, `schema_meta`. |
| `src/indexer.rs` | The polling indexer, the three-leg order map and the vault discovery pass. |
| `src/lens.rs` | Lens reads and their snake_case projections. |
| `src/market.rs` | The pricing replica: skew decay, forward and projected variance, the bid/ask pair, and the chart path. A replica, never an authority. |
| `src/rv.rs` | The realized-variance replica. |
| `src/chainlink.rs` | Phase-aware round cache and sampling, mirroring `RealizedVariance.sol`. |
| `src/api.rs` | The HTTP surface. |

## Operational safety

The process binds to `127.0.0.1` by default. Startup fails closed if RPC, chain identity, manifest or
feed decimals cannot be verified. The public oracle routes accept only the manifest feed and at most
256 samples. Request concurrency is bounded and handlers time out after 30 seconds. An indexer chunk is
committed only when every matching log is processed; malformed logs never get skipped by cursor advance.

## Known gaps

* `/series*` needs the Tremor contracts; against a chain without them it returns `[]`/404 (the indexer
  still runs and just sees no `SeriesCreated`).
* Cold Chainlink windows on the public Base RPC are slow (tens of seconds; the endpoint throttles at ~10
  calls/burst and batches to 10). Warm requests are a few seconds; run against a local anvil fork or a
  paid RPC for snappy charts.
* `now` for sampling is `max(latest block timestamp, wall clock)`: on anvil the last block can lag; if
  the chain time was warped forward it is followed.
* Off-chain RV uses f64 (≈1e-15 relative) — the on-chain WAD result is the settlement truth; the
  `/series/:id/variance` response includes `lens_realized_variance_so_far` for side-by-side display.
