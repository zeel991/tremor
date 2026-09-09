# Tremor — a two-sided variance market on 1inch Aqua

**One line.** Tremor lets anyone trade capped ETH realized variance on 1inch Aqua. A writer funds a
maker vault; the vault ships three SwapVM strategies through canonical Aqua on the **unmodified official
`AquaSwapVMRouter`**; buyers pay an executable ask for receipt tokens, holders can sell them back at an
executable bid before expiry, and after expiry every receipt redeems for USDC at the realized variance
computed **on chain from the Chainlink feed's own round history**. Every unit sold is fully
collateralized, and the writer cannot take that collateral back while the receipt exists. The same
realized-variance primitive prices a vol-adaptive spread for an Aqua AMM, so an LP can size an
LVR hedge (LVR ∝ σ²) with the instrument that pays σ².

This file is the single source of truth shared by every build (contracts, backend, subgraph, web, sim).
If something here conflicts with code, fix the code or update this file — never silently diverge.

---

## 0. Decisions (fixed)

| Area | Decision |
|---|---|
| Repo | Monorepo: `contracts/` (Foundry), `backend/` (Rust, axum), `subgraph/` (The Graph), `web/` (Next.js 16), `sim/` (TypeScript), `docs/` |
| Chains | Dev/demo: **anvil fork of Base mainnet**, `--chain-id 31337`, canonical Aqua `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`, real USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 dec), real Chainlink ETH/USD `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` (8 dec). Public: **Base Sepolia (84532)** with our own Aqua deployment, MockUSDC, Chainlink ETH/USD `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` |
| Solidity | 0.8.30, via-IR, **optimizer 200 runs** — size-tuned, because the controller embeds its children's creation code and therefore has to fit EIP-3860's 49,152-byte initcode limit. Libraries: `contracts/lib/swap-vm` (1inch; carries `@1inch/aqua`, `@openzeppelin`, `@1inch/solidity-utils`, `forge-std` in its node_modules), `contracts/lib/solady` (`FixedPointMathLib.lnWad/expWad/sqrt`) |
| Router | The **official `AquaSwapVMRouter`**, deployed unmodified from the pinned `lib/swap-vm` submodule. No custom opcodes, no fork. The manifest pins `routerSourceCommit` and `routerBytecodeHash` |
| Programs | `Salt` (0x02), `Deadline` (0x20), `Extruction` (0x04) only. All Tremor pricing lives behind the `Extruction` target, `TremorMarketEngine`; both burn legs additionally carry a `postTransferIn` maker hook on the receipt |
| Fixed point | Variance and vol in WAD (1e18). `variance = 1e18` means 100% annualized vol (σ² = 1). USDC 6 dec. Receipts 18 dec, `1e18` = one unit. Integer-only arithmetic in every executable path |
| Backend | Rust stable, axum, tokio, alloy (provider + `sol!`), sqlx + SQLite, serde, tracing, tower-http CORS. Port 8787. Read-only: no keys, no transactions |
| Web | Next.js 16 (App Router, TS strict), Tailwind v4, wagmi v3 + viem v2 + @tanstack/react-query, injected connector only, recharts, `next/font/google`. Port 3000 |
| Config | `contracts/deployments/<chainId>.json` (**schema version 2**) written by `Deploy.s.sol`; copied to `web/src/config/deployment.json` and read by the backend via `DEPLOYMENT_JSON` |
| Authority | The Lens and the on-chain quotes are executable authority. The backend and the frontend are replicas, pinned to `contracts/test/vectors/pricing_vectors.json` |

Product name in UI: **Tremor**. Tagline: *Trade ETH's tremor, not its direction.*

---

## 1. Financial definitions

All times are unix seconds. `Δ` = `sampleInterval`. `n = (expiry − start) / Δ`, which must divide exactly.

### 1.1 Realized variance

**Sample prices.** `tᵢ = start + i·Δ`, `i = 0..n`. `Pᵢ` = the `answer` of the **latest Chainlink round with
`updatedAt ≤ tᵢ`**, scaled from 8 to 18 decimals. Rounds are found through the proxy with phase-prefixed
ids; see §3.3.

```
rᵢ  = lnWad(Pᵢ · 1e18 / Pᵢ₋₁)                 i = 1..n   (signed WAD)
RV  = Σ rᵢ² · 31_536_000 / (expiry − start)   (WAD; rᵢ² is rᵢ·rᵢ/1e18)
```

The accumulator stores `Σ rᵢ²` incrementally as samples are checkpointed and annualizes the partial sum
over `processedThrough − start` for the live "realized so far" figure. `finalVariance` is stored
**uncapped**; the cap applies to the payout, not to the measurement.

### 1.2 Payoff

```
payoutPerUnit = floor(unitNotional · min(finalVariance, capVariance) / 1e18)     quote base units
proceeds(u)   = floor(u · payoutPerUnit / 1e18)
maxPayoutPerUnit = floor(unitNotional · capVariance / 1e18)
```

### 1.3 Liability

```
maxLiability(u)   = ceil(u · unitNotional · capVariance / 1e36)     before finalization
finalLiability(u) = ceil(u · payoutPerUnit / 1e18)                  after finalization
```

Both are computed from the **aggregate** outstanding position, never as a rounded per-unit figure times a
count, so splitting one fill into many cannot drift the reservation by a base unit.

### 1.4 The two-sided quote

```
decayedSkew = skew · 2^(−(now − lastTs)/halfLife)          halfLife = 0 → no decay
forward     = clamp(anchorVariance + decayedSkew, 0, cap)
elapsed     = processedThrough − start        remaining = expiry − processedThrough
projected   = (realizedSoFar · elapsed + forward · remaining) / (elapsed + remaining)
askVariance = min(ceil(projected · (1 + s)),  cap)         s = halfSpreadBps / 10_000
bidVariance = min(floor(projected · (1 − s)), cap)
```

`projected` is deliberately unclamped: it is a measurement. Selling `u` units raises the stored skew by
`impactPerUnit · u / 1e18`; exiting lowers it by the same amount.

### 1.5 Integral fill pricing

The skew reaches the quote through the projection weight `remaining/duration` and the spread multiplier,
both affine, so the marginal price is affine in `u` with slope

```
askSlope = ceil(impactPerUnit · remaining · (BPS + s) / (duration · BPS))
bidSlope = floor(impactPerUnit · remaining · (BPS − s) / (duration · BPS))
```

and a fill is the integral of that marginal price, which is what makes splitting a fill pointless:

```
premium(u)  = ceil( unitNotional · (askVariance·u + ceil(askSlope·u²/2e18)) / 1e36 )
proceeds(u) = floor( unitNotional · (bidVariance·u − floor(bidSlope·u²/2e18)) / 1e36 )
```

**Exact-in** inverts the premium integral in a cancellation-free form, with `X = amountIn · 1e36 / unitNotional`:

```
u = 2X / (askVariance + ceil√(askVariance² + 2·askSlope·X/1e18))
```

which degenerates to `X / askVariance` at zero slope. The root rounds up, so a taker never receives more
units than the exact real-valued solution.

### 1.6 Clamps

An ISSUE fill is `min(` units affordable, inventory still shipped, `unitsToCap`, `unitsToCollateral` `)`:

```
unitsToCap        = (cap − askVariance) · 1e18 / askSlope
unitsToCollateral = floor((locked + free) · 1e36 / (unitNotional · cap)) − outstanding
```

An EXIT fill is clamped by outstanding units and by `unitsToZeroBid = bidVariance · 1e18 / bidSlope`; its
proceeds are additionally clamped by the collateral the burn releases and by the leg's Aqua balance.

### 1.7 Rounding

Maker-favouring throughout, where the maker is the writer's collateralized vault:

| Direction | Rounds |
|---|---|
| ISSUE exact-in | units **down** |
| ISSUE exact-out | premium **up** |
| EXIT exact-in | proceeds **down** |
| SETTLE exact-in | proceeds **down** |
| Any liability | **up** |

`contracts/test/vectors/pricing_vectors.json` — 60 cases generated at 60 decimal digits by
`contracts/tools/reference/pricing_reference.py` — pins every formula in §1 for the Solidity library, the
TypeScript frontend replica (`web/src/lib/series.test.ts`) and the simulation replica (`sim/src/check.ts`).

---

## 2. Contracts (`contracts/`)

### 2.1 What is deployed

| Contract | Responsibility |
|---|---|
| `AquaSwapVMRouter` | The official router, unmodified. Runs every Tremor program |
| `VarianceSeriesFactory` | **The controller.** Validates and creates series, deploys vaults and receipts, ships all three strategies, owns every reservation, and is the single place a liability changes |
| `TremorMarketEngine` | The `Extruction` target. Prices ISSUE, EXIT and SETTLE, and exposes the four `quote*` views |
| `TremorMakerVault` | One per writer, `CREATE2` at `keccak256(writer, quoteToken)`. Five immutables, no admin, no upgrade path, no rescue, no arbitrary call |
| `VarianceAccumulator` | Bounded permissionless checkpointing (`MAX_SAMPLES_PER_CALL = 32`) and permissionless finalization |
| `VarianceReceipt` | Per-series ERC-20 (18 dec, `tVAR-ETH-<yymmdd>`). Its router-only `postTransferIn` hook burns every unit that leaves through a burn leg and calls `onBurn` |
| `TremorSeriesDeployer` | `CREATE2` deployer for vaults and receipts, so a vault address is a pure function of its writer |
| `TremorLens` | Batched read model: `SeriesState`, `VaultState`, `MarketQuote`, `OracleProgress`, `LegStatus`, taker data, LVR sizing |
| `TremorPrograms` | Stateless read model for the three orders, their programs and the Aqua ship plan |
| `RealizedVarianceOracle` | Trailing realized variance for `VarianceSpread` and the LVR tools |

Every constructor dependency must contain code, and the Lens verifies at construction that the
controller, engine, accumulator, deployer and router agree about each other. All contracts are immutable
and non-upgradeable.

### 2.2 The three programs

```
ISSUE   Salt(id,1) · Deadline(saleEnd) · Extruction(engine, [1,1,id])     USDC → receipts
EXIT    Salt(id,2) · Deadline(expiry)  · Extruction(engine, [1,2,id])     receipts → USDC   + burn hook
SETTLE  Salt(id,3) ·                     Extruction(engine, [1,3,id])     receipts → USDC   + burn hook
```

`Salt` is `abi.encodePacked(uint64 seriesId, uint8 leg)`, so the leg is part of the order identity.
Engine args are `[version:1][mode:1][seriesId:8]`. SETTLE deliberately carries no deadline.

`TremorOrderBuilder` is the **only** encoding path, and the invariant it guarantees is

```
router.hash(order) == keccak256(abi.encode(order)) == aqua strategyHash
```

for all three legs. MakerTraits: maker is the vault, receiver defaults to the maker,
`useAquaInsteadOfSignature` is set, tokens are sorted, and `hasPostTransferInHook` is set on the two burn
legs with the receipt as the target. Direction is enforced **inside the engine by token address**, per
leg, not by the sorted-direction flag.

Ship amounts: ISSUE carries `maxUnits` of receipts; EXIT and SETTLE each carry `maxSeriesLiability` of the
quote token as an Aqua **virtual** balance against the vault's one real balance.

### 2.3 The vault

Immutables: `OWNER`, `QUOTE_TOKEN`, `AQUA`, `ROUTER`, `CONTROLLER`. `forceApprove(AQUA, max)` happens in
the constructor and nowhere else — there is no setter at any privilege level.

| Open | Owner-only | Controller-only |
|---|---|---|
| `deposit` | `withdrawFree` (≤ `balance − locked`) | `increaseLocked`, `decreaseLocked`, `registerAndApproveReceipt`, `shipStrategy`, `dockStrategy` |

`_assertSolvent()` (`balance >= locked`) runs after every mutation. There is no rescue, no `execute`, no
`delegatecall` and no `receive`.

### 2.4 The controller's callbacks

| Callback | Caller | What it does |
|---|---|---|
| `onIssue` | engine | Reserves collateral at the cap from the new aggregate position, records the premium, raises the skew |
| `onExit` | engine | Lowers the skew |
| `onBurn` | the series' receipt | **The only place a liability decreases.** Validates the leg from the order hash and requires `amountOut <= released` |
| `onFinalize` | accumulator | Fixes `finalVariance` and `payoutPerUnit`, reprices the liability from the cap to `finalLiability`, releases the difference |

Writer-facing: `createVault` (idempotent), `createSeries`, `stopIssuance`, `closeSeries`. Holder-facing:
`burnWorthless`. `createBackdatedDemoSeries` exists and reverts off chain 31337.

### 2.5 Validation bounds (`_validate`)

```
feed == FEED, quoteToken == QUOTE_TOKEN
expiry > start, sampleInterval >= 300, (expiry − start) % sampleInterval == 0
2 <= samples <= 256
now <= saleEnd, start <= saleEnd, saleEnd <= expiry     (the last relaxed only for the demo path)
unitNotional > 0
0 < capVariance <= 4e18                                 (200% vol)
0 < anchorVariance <= capVariance
impactPerUnit <= capVariance
10 <= halfSpreadBps <= 2000
halfLife == 0 or 300 <= halfLife <= 30 days
maxUnits > 0, and 0 < maxSeriesLiability <= type(uint248).max
```

Creation also requires that `maxSeriesLiability` is available as free collateral in the writer's vault,
and it seeds the opening sample when `start <= block.timestamp` so the market can quote immediately.

### 2.6 Size budget

The controller embeds its children's creation code, so **EIP-3860** (49,152 initcode) binds before
EIP-170 (24,576 runtime):

| Contract | Runtime | Initcode |
|---|---:|---:|
| AquaSwapVMRouter | 20,052 | 21,540 |
| VarianceSeriesFactory | 17,892 | **46,484** (2,668 spare) |
| TremorLens | 15,184 | 16,364 |
| TremorSeriesDeployer | 11,236 | 11,574 |
| TremorMarketEngine | 8,612 | 8,868 |
| TremorPrograms | 7,607 | 8,057 |
| VarianceAccumulator | 6,858 | 7,163 |
| RealizedVarianceOracle | 5,562 | 5,781 |
| TremorMakerVault | 3,652 | 4,408 |
| VarianceReceipt | 2,981 | 5,218 |

This is why the read models are separate contracts and why `optimizer_runs` is 200.

---

## 2A. Portfolio markets (v3, `contracts/src/portfolio/`) — binding addendum

A separate, versioned deployment beside the series stack (nothing in §2 is redirected). One **risk
group** backs two complementary capped claims on the same finalized observation:

```text
x         = min(finalRealizedVariance / capVariance, 1)                      (WAD)
HIGH pays   floor(S * x / 1e18)   quote units per 1e18 claim units
CALM pays   S - floor(S * x / 1e18)          (exact integer complement; highPpu + calmPpu == S)

reserve(h, c) = ceil(max(h, c) * S / 1e18)                                   while live
              = floor(h*highPpu/1e18) + floor(c*calmPpu/1e18)                after finalization
```

Grouping rule: claims share backing ONLY with identical feed, window, sampling, cap semantics, quote
token and finalization result — enforced by construction, because both sides of a group are created,
priced and finalized by the same `TremorPortfolioMarket` group record.

Programs: six per group, all stock instructions on the same official router —
`Salt(groupId, mode) · [Deadline] · Extruction(market, [version=2, mode, groupId])`, modes
1..6 = ISSUE/EXIT/SETTLE × HIGH/CALM; EXIT and SETTLE carry the side receipt's `postTransferIn` hook.
`PortfolioOrderBuilder` is the only encoding path. Args version 2 is disjoint from the series engine's
version 1.

Rules that differ from §2 and are binding:

- Issuance is capacity-clamped against `reserve + vault.freeQuote()`; no full-cap funding requirement at
  creation. Selling the smaller side reserves nothing further.
- Burning the smaller-or-equal side releases zero reserve, so an EXIT pays only from
  (reserve released by that burn) + the group's `exitBuffer`. The buffer is locked collateral funded by
  `allocateExitBuffer` (writer-only, from free vault collateral) or `fundExitBuffer` (permissionless,
  transfers the caller's own tokens). Exits never draw on free balance read mid-fill: the buffer is
  debited and re-checked inside the burn hook, so interleaved fills fail closed. Unspent buffer is
  writer-withdrawable — an exit quote may become unavailable while settlement backing stays locked, and
  every surface that shows an exit quote must say so.
- Pricing is the writer's fixed executable bid/ask per side (`askHigh/bidHigh/askCalm/bidCalm`,
  bid ≤ ask ≤ S), disclosed as the writer's quotes, never as fair value. Solvency is independent of them.
- The market's `extruction` requires `msg.sender == ROUTER` (the series engine now does too).
- The invariant, re-asserted by every transition and by the vault itself:
  `vault balance >= vault.lockedQuote == Σ groups (reserve + exitBuffer)`, and per group
  `reserve >= maximum aggregate payout of outstanding claims` (proof in `PortfolioMath.sol`; pinned to
  225 exact-rational vectors in `test/vectors/portfolio_vectors.json`).

The manifest carries `portfolioMarket` and `portfolioAccumulator` from schema version 3.

## 3. Shared technical details

### 3.1 ABI

Web and backend read the Lens and the controller through **exported JSON ABIs**
(`contracts/script/export-abi.sh` → `web/src/abi/`, `backend/abi/`), not hand-written fragments, because
the Lens' `SeriesState` is a nested struct. Human-readable fragments for everything else are listed in
`web/src/content/docs/reference/abi.md`, which is generated from the same contracts and kept in step.

> A stale exported ABI decodes the live struct into the wrong fields with no error anywhere. Re-export
> after every redeploy; `make demo` does both.

The Lens groups its state into `LegStatus`, `MarketQuote`, `OracleProgress` and `VaultState`
sub-structs rather than one flat tuple, because alloy's `sol!` macro cannot decode a 35-element tuple.

### 3.2 Taker data

Takers call `router.swap(order, amount, takerData)`. `takerData` is built by
`TremorLens.buildTakerData(taker, isExactIn, isAToB, threshold, deadline, allowPartialFill)`, mirroring
`TakerTraitsLib.build` with `useTransferFromAndAquaPush = true`. `isAToB` comes from
`lens.legDirection(id, leg)`.

`allowPartialFill` is what makes the engine's clamps reachable: with it off, `TakerTraits` requires
`takerAmount == amountIn` and any clamped fill reverts. With it on, the threshold becomes a limit **rate**
that TakerTraits pro-rates by the fraction filled — so quote the threshold against the taker amount you
send, not against the clamped result.

**Takers approve the ROUTER.** The vault's approvals to Aqua are made by code the writer does not control.

### 3.3 Chainlink round search (phase-aware)

Proxy `roundId = (phaseId << 64) | aggregatorRoundId`. For `priceAt(t)`:

1. `p = proxy.phaseId()`; `latest = proxy.latestRoundData()`; `hi = latest.roundId & 0xFFFFFFFFFFFFFFFF`.
2. Loop over phases `p, p−1, …`: read `first = getRoundData(p<<64 | 1)`. If `first.updatedAt <= t`,
   binary-search `lo = 1..hi` for the largest round with `updatedAt <= t` and return its answer. For
   phases below the current one, find `hi` by exponential probing then bisection. Otherwise `p -= 1`; at
   `p == 0` revert `WindowPredatesFeed`.
3. Every call is a `staticcall`. A round **does not exist** when `getRoundData` reverts **or** returns
   `updatedAt == 0` — live Base OCR aggregators return zeros where FluxAggregators revert, and both are
   handled and tested.

The accumulator keeps a resumable cursor (`curPhase`, `curHi`, `scale`, last round) so sample 0 is a full
search and every later sample gallops forward from the previous round, across bounded calls and across
phase boundaries. On Base, 7-day windows currently cross the phase 2 → 3 boundary.

### 3.4 Deployment manifest (`deployments/<chainId>.json`, schema version 3)

```json
{ "schemaVersion": 2, "chainId": 31337,
  "aqua": "0x…", "weth": "0x…", "usdc": "0x…", "feed": "0x…",
  "router": "0x…", "routerSourceCommit": "…", "routerBytecodeHash": "0x…",
  "seriesFactory": "0x…", "marketEngine": "0x…", "accumulator": "0x…",
  "seriesDeployer": "0x…", "programs": "0x…", "lens": "0x…", "oracle": "0x…",
  "deploymentBlock": 51021223, "writer": "0x…", "buyer": "0x…" }
```

The backend rejects any other `schemaVersion`, and any zero address, at startup. Writer vaults and
receipts are deliberately absent: a vault address is `CREATE2` from the writer, and
`lens.writerVault(writer)` returns it whether or not it exists yet.

---

## 4. Backend (`backend/`) — Rust, axum, port 8787

Indexes events, caches Chainlink rounds, replicates realized variance and the market quote for charts,
and serves read models. **It holds no keys and sends no transactions** — `CHECKPOINT_WORKER` /
`CHECKPOINT_PRIVATE_KEY` are a deliberate startup error, because checkpointing and finalization are
permissionless and belong in the user's own wallet.

Env: `RPC_URL`, `DEPLOYMENT_JSON`, `DATABASE_URL` (`sqlite://tremor.db`), `BIND_ADDRESS`, `PORT` (8787),
`POLL_MS` (3000), `CORS_ORIGIN`. Startup fails closed on RPC, manifest, chain, schema, feed, code-presence
or cross-link errors. `--reset-db` recreates the schema, which a redeploy requires.

**Indexer.** From `deploymentBlock` (or the saved cursor), poll `eth_getLogs` in bounded chunks. Each
chunk is scanned in **two passes** — the fixed addresses first (controller, router, Aqua, accumulator),
which is what discovers new vaults and receipts, then the discovered vaults — so a vault created and
funded in the same chunk still indexes correctly. `SeriesCreated` builds an
`orderHash → (seriesId, leg)` map for all three legs, rebuilt from SQLite on restart; a `Swapped` becomes
a fill only when its order hash is a known Tremor leg; Aqua events are kept only when `app == router`.
Any undecodable or unprocessable log fails the chunk, so the cursor never advances past lost data. A
reset is detected from a head below the cursor, a changed block hash at the cursor, or a changed manifest.

Schema version 2, tables: `schema_meta`, `cursor`, `vaults`, `series`, `orders`, `fills`, `checkpoints`,
`finalizations`, `vault_events`, `aqua_events`, `rounds`, `phases`, `round_coverage`.

**Endpoints** (JSON; amounts and variances as decimal strings; timestamps unix seconds):

```
GET /health                       readiness; 503 on chain mismatch, indexer error, stale tick or lag
GET /config                       the manifest + feed_decimals, quote_decimals, max_samples_per_checkpoint
GET /series?limit=&offset=        paginated summaries, max 100, plus per-leg fill statistics
GET /series/:id                   one summary + fills, checkpoints, finalization, aqua events
GET /series/:id/fills             fills across all three legs
GET /series/:id/market            the reconstructed market path for the chart + the live Lens quote
GET /series/:id/variance          sampled prices, log returns, realized variance so far
GET /series/:id/checkpoints       every Checkpointed event and the finalization
GET /series/:id/quote?issue_usdc=&issue_units=&exit_units=&settle_units=
GET /series/:id/aqua              Aqua shipped/docked/pulled/pushed for the three strategies
GET /vault/:address               live vault state, the series it backs, deposit/withdraw history
GET /portfolio/:address           indexed positions, with cost basis where it is knowable
GET /variance/trailing?window=&interval=&to=
GET /feed/history?from=&to=&interval=
GET /lvr?pool_value_usd=&horizon_days=&window=
```

Every Lens-owned field in a series response is **nullable**: when the Lens is unreachable the backend
serves a DB-derived summary with `null` and a `lensError`, so the UI shows an em dash rather than a zero
that looks like a real number. `costBasisKnown` is false for a wallet with no indexed buys, and
`indexedEntryPerUnit` is `null` rather than invented.

---

## 5. Web (`web/`) — Next.js, port 3000

Env: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_CHAIN_ID`, optional
`NEXT_PUBLIC_SUBGRAPH_URL`. Addresses from `src/config/deployment.json`.

Reads: lists, history and charts from the backend; **every executable number from the chain**, re-quoted
immediately before a transaction is built. Writes, all from the user's injected wallet:

```
CREATE_VAULT   DEPOSIT   WITHDRAW_FREE   CREATE_SERIES   STOP_ISSUANCE   CLOSE_SERIES
BUY   EXIT   REDEEM   BURN_WORTHLESS   CHECKPOINT   FINALIZE
```

Every flow simulates, waits for wallet confirmation, waits for the receipt, exposes an explicit failure
state and invalidates the affected queries. The create flow's persisted checkpoint is keyed by account,
chain, vault and the exact parameters, and its key is versioned (`tremor:v2:…`) so a v1 checkpoint cannot
resume against v2 addresses.

Routes:

- `/` landing: hero, trailing realized-vol tiles (1d/7d/30d), open markets, how it works, LVR hook.
- `/markets`: series, status, expiry, realized vol, market vol, bid, ask, available units, locked backing.
  Filters: Upcoming, Live, Finalizing, Finalized, Closed, Issuance open.
- `/series/[id]`: compact market header → realized-versus-market volatility chart → wallet position
  summary → dark trade rail (Buy / Exit / Redeem / Oracle, lifecycle-aware) → one-line locked-collateral
  state → plain settlement explanation → collapsed advanced details (programs, fills, Aqua events,
  checkpoints, immutable parameters). Payoff and oracle-price charts are secondary tabs.
- `/write`: three decisions, thirteen derived parameters under Advanced, a ticket showing the opening
  bid/ask, premium if sold out, break-even vol, max payout per unit, collateral reserved and worst case.
- `/portfolio`: receipts held (units, indexed entry, exit bid, payout per unit, value, action), the maker
  vault (balance / reserved / free / allowance, deposit and withdraw-free), and series written with
  per-series reservations. Writer controls are Deposit, Withdraw free, Stop issuance and Close — **not**
  docking or approvals.
- `/hedge`: LVR sizing and executable cost per open market.
- `/docs`: the GitBook-style section, content in `src/content/docs/**` + `nav.ts`.

The chart's primary view is annualized volatility over time: a solid realized line, a dashed market-quote
line, the executable bid/ask band behind them, and markers for start, the current checkpoint, sale end and
expiry. Positions are valued at the **executable bid** while live and at the **fixed payout** once
finalized, never blended. Design system: `DESIGN.md` — follow it exactly.

---

## 6. Dev flow

```bash
make dev                     # fork + deploy + seed + API + web, skipping satisfied steps
scripts/dev.sh --fresh       # re-fork and redeploy from scratch
scripts/dev.sh --no-seed     # deploy without the demo lifecycle
```

Or one piece at a time:

```bash
make anvil          # anvil --fork-url $BASE_RPC_URL --chain-id 31337 --auto-impersonate --port 8545
make test           # forge test                (ForkE2E and RouterCompat need BASE_RPC_URL)
make demo           # demo.sh + sync-deployment.sh + export-abi.sh
make backend        # cargo run --release       (--reset-db after a redeploy)
make web            # npm run dev -- --port 3000
cd sim && npm run check && npm run sim
```

Public testnet: `forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --account <keystore>`,
then `sync-deployment.sh 84532` and point web and backend at Base Sepolia.

## 7. Judge-facing story

**One maker, three programs, zero custom opcodes.** `TremorMarketEngine` sits behind the stock
`Extruction` and prices all three legs from one projection, so Tremor runs on the official
`AquaSwapVMRouter` instead of a fork of it — and `RouterCompat.t.sol` proves it against both the router
deployed at the canonical SwapVM address and the pinned official source.

**A receipt is a claim on money that cannot leave.** The vault reserves a sold unit's capped payout and
releases it only when the receipt burns. A writer cannot withdraw it, cannot revoke the Aqua allowance,
cannot move unsold inventory, and cannot dock a burn leg while claims exist. The demo attempts all four
on a Base fork and shows them reverting.

**Two burn legs, one balance, and the invariant that makes it safe.** `amountOut <= released`: every
payout is bounded by the obligation that disappears in the same transaction.

**Nobody pays for everyone else.** The observation window is walked forward in bounded permissionless
checkpoints instead of inside the first redemption, and finalization reprices the liability from the cap
so the writer's surplus comes back the moment the variance is known.

**Quote equals swap, because history does not change** — and because the engine runs identical arithmetic
in both directions, writing state only outside a static context.
