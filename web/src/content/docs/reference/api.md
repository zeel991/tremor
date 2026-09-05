The Rust backend (`tremor-api`, axum, port `8787`) indexes controller / router / Aqua / vault events, caches Chainlink rounds, replicates realized variance and the market quote off-chain, and serves JSON. **It holds no keys and sends no transactions** — setting `CHECKPOINT_PRIVATE_KEY` is a deliberate startup error, not an opt-in.

The Lens is the executable authority. This API is a replica: when the two disagree, the chain is right and this is stale. Every endpoint that can carry a live Lens read also carries the raw value so a divergence is visible rather than hidden.

Amounts and variances that may exceed 2⁵³ (WAD variances, token amounts, round ids) are decimal **strings**; convenience floats carry a `_float` or `Vol` suffix. Field names are camelCase for contract-derived data and snake_case for a few operational fields, exactly as listed below. Errors are `{ "error": "..." }` with `400` (bad params, window predates feed), `404`, `502` (RPC or Lens failure), `500`. CORS is enabled for `CORS_ORIGIN`.

## Endpoints

| Path | Returns |
|---|---|
| `GET /health` | Readiness. `503` on chain mismatch, indexer error, stale tick or excessive lag |
| `GET /config` | The deployment manifest (schema version 2) plus `feed_decimals`, `quote_decimals`, `max_samples_per_checkpoint` |
| `GET /series?limit=&offset=` | Paginated summaries, max 100. Lens reads chunked, plus per-leg fill statistics |
| `GET /series/:id` | One summary plus `fills`, `checkpoints`, `finalization` and `aquaEvents` |
| `GET /series/:id/fills` | Fills across all three legs, newest first |
| `GET /series/:id/market` | The reconstructed market path for the chart, plus the live Lens quote |
| `GET /series/:id/variance` | The sampled prices, the log returns and realized variance so far |
| `GET /series/:id/checkpoints` | Every `Checkpointed` event and the finalization, if any |
| `GET /series/:id/quote?issue_usdc=&issue_units=&exit_units=&settle_units=` | Live Lens quotes for all four directions |
| `GET /series/:id/aqua` | Aqua `shipped/docked/pulled/pushed` events for the series' three strategies |
| `GET /vault/:address` | A writer's vault: live state, the series it backs, and its deposit/withdraw/lock history. Accepts the vault **or** the writer address |
| `GET /portfolio/:address` | A holder's indexed positions, with cost basis where it is knowable |
| `GET /variance/trailing?window=1d\|7d\|30d&interval=&to=` | Trailing realized variance for the manifest feed, max 256 samples |
| `GET /feed/history?from=&to=&interval=` | Raw feed samples, max 256 points |
| `GET /lvr?pool_value_usd=&horizon_days=&window=` | `V·σ²·T/8` and the hedge units per open series |

## Series fields

The series projection is a flat mirror of the Lens' `SeriesState`: `writer`, `vault`, `receipt`, `params`, the three order hashes, `status`, the six leg booleans, the eight quote fields (`marketVariance`, `projectedVariance`, `realizedVarianceSoFar`, `bidVariance`, `askVariance`, `bidPerUnit`, `askPerUnit`, `maxPayoutPerUnit`), `unitsOutstanding`, `unitsAvailable`, `lockedLiability`, `finalVariance`, `payoutPerUnit`, the five oracle fields, `fullyCollateralized` and `vaultState`.

**Every Lens-owned field is nullable.** When the Lens is unreachable the backend serves a DB-derived summary with `null` where a live read would have gone and a `lensError` string saying why, so the UI can show an em dash instead of a zero that looks like a real number.

Indexer-only extras: `fillsCount`, `issueCount`, `exitCount`, `settleCount`, `premiumQuote`, `exitQuote`, `settlementQuote`, `unitsIssued`, `unitsExited`, `unitsSettled`, `lastFillAt`.

## Fills

```json
{ "txHash": "0x…", "block": 50776125, "timestamp": 1788341882, "seriesId": 1,
  "leg": "issue", "orderHash": "0x…", "makerVault": "0x…", "taker": "0x…",
  "amountIn": "612000000", "amountOut": "20000000000000000000",
  "units": "20000000000000000000", "quoteAmount": "612000000", "pricePerUnit": "30600000" }
```

`leg` is one of `issue`, `exit`, `settle`, resolved from the order hash. `units` is always the receipt side and `quoteAmount` always the USDC side, whichever direction the leg runs, so a client never has to swap them per leg.

## Market points

```json
{ "t": 1788341882, "processedThrough": 1788340000,
  "realizedVariance": "…", "realizedVol": 0.42, "marketVariance": "…", "marketVol": 0.51,
  "projectedVariance": "…", "projectedVol": 0.48, "bidVariance": "…", "askVariance": "…",
  "bidPerUnit": "24500000", "askPerUnit": "25500000", "checkpointsFresh": true }
```

This is a **replica**, reconstructed from indexed fills and checkpoints, because no contract stores the historical path. The same response carries the Lens' live quote so the two can be compared directly. `checkpointsFresh` records whether the market could have quoted at that moment at all.

## Positions

```json
{ "seriesId": 1, "receipt": "0x…", "expiry": 1788950400,
  "unitsBought": "…", "unitsExited": "…", "unitsSettled": "…",
  "indexedUnits": "…", "indexedCost": "…", "indexedEntryPerUnit": "30600000",
  "exitProceeds": "…", "settlementProceeds": "…", "costBasisKnown": true, "fills": 2 }
```

`costBasisKnown` is `false` when this address has no indexed buys — a receipt that arrived by plain ERC-20 transfer has no entry price, and the API returns `null` rather than inventing one. The app shows an em dash and says why.

## Vault detail

```json
{ "requested": "0x…", "vault": "0x…", "exists": true,
  "state": { "vault": "0x…", "owner": "0x…", "balance": "…", "locked": "…", "free": "…",
             "aquaAllowance": "…", "allowanceSufficient": true },
  "indexed": { "writer": "0x…", "deposited": "…", "withdrawn": "…", "createdAt": 1788300000 },
  "series": [ { "id": 1, "receipt": "0x…", "expiry": 1788950400, "issuanceStoppedAt": null, "closedAt": null } ],
  "events": [ { "txHash": "0x…", "timestamp": 1788300000, "kind": "deposit", "actor": "0x…",
                "amount": "…", "balance": "…", "locked": "…" } ] }
```

The Lens knows a writer's vault address before it exists, because the address is a pure function of the deployer's — which is what lets the writer page show it up front.

## Health

```json
{ "ok": true, "chain_id": 31337, "head_block": 50776125, "indexed_block": 50776125,
  "series_indexed": 2, "vaults_indexed": 1, "schema_version": 2, "manifest_schema_version": 2,
  "indexer_error": null, "last_tick_at": 1788341882, "resets": 0, "lag_blocks": 0 }
```

Both schema versions are reported. A manifest written by a v1 deployment is **rejected at startup**, not tolerated.

## How the indexer works

- Starts at `deploymentBlock` (or the saved cursor) and polls `eth_getLogs` in bounded chunks. Any undecodable or unprocessable log fails the chunk, so the cursor never advances past lost data.
- Each chunk is scanned in **two passes**: first the fixed addresses (controller, router, Aqua, accumulator), which is what discovers new vaults and receipts, then the discovered vaults. That ordering is why a vault created and funded in the same chunk is still indexed correctly.
- `SeriesCreated` builds an `orderHash → (seriesId, leg)` map for all three legs, rebuilt from SQLite on restart. `Swapped` becomes a fill only when its order hash is a known Tremor leg. Aqua events are kept only when `app == router`.
- After each chunk the cursor stores the last block, its hash and the manifest's `deploymentBlock` / controller address. A reset is detected when the head falls below the cursor, the block hash at the cursor changes (anvil restarted, demo re-run) or the manifest changes; derived tables are truncated and indexing restarts.

Tables: `schema_meta`, `cursor`, `vaults`, `series`, `orders`, `fills`, `checkpoints`, `finalizations`, `vault_events`, `aqua_events`, `rounds`, `phases`, `round_coverage`. Schema version 2; `--reset-db` recreates it.

## Chainlink module

Replicates the contracts' phase-aware `priceAt` — a round does not exist when `getRoundData` reverts **or** returns `updatedAt == 0`, and both happen on Base depending on the aggregator generation. Sampling a window groups sample times by serving phase, locates boundary rounds with a cached binary search, then dense-fetches every round in between through **Multicall3** (`0xcA11…CA11`, 250 `getRoundData` per `eth_call`, with a sequential fallback where Multicall3 is not deployed). Rounds and per-phase coverage intervals are persisted. Public RPC rate limits are retried with backoff.

## Known gaps

- `/series*` needs the Tremor contracts. Against a chain without them it returns `[]` / `404`.
- Cold Chainlink windows on the public Base RPC are slow — tens of seconds; warm requests a few seconds. Use a local fork or a paid RPC for snappy charts.
- `now` for sampling is `max(latest block timestamp, wall clock)`, which is what keeps the chart's live point aligned with an idle anvil fork rather than drifting ahead of it.
- Off-chain realized variance is computed in `f64`. The on-chain WAD result is the settlement truth, and it is returned alongside for side-by-side display.
