# Tremor contracts

This is the contract-level implementation guide. The cross-stack source of truth is
[`../ARCHITECTURE.md`](../ARCHITECTURE.md).

## What is deployed

| Contract | Responsibility |
|---|---|
| `AquaSwapVMRouter` | The **official** SwapVM router, deployed unmodified from the pinned `lib/swap-vm` submodule |
| `VarianceSeriesFactory` | The controller: validates and creates series, deploys vaults and receipts, ships all three strategies, owns every reservation |
| `TremorMarketEngine` | The `Extruction` target that prices ISSUE, EXIT and SETTLE, plus four `quote*` views |
| `TremorMakerVault` | One per writer, `CREATE2` at `keccak256(writer, quoteToken)`. No admin, no upgrade path, no rescue, no arbitrary call |
| `VarianceAccumulator` | Bounded permissionless checkpointing (`MAX_SAMPLES_PER_CALL = 32`) and permissionless finalization |
| `VarianceReceipt` | Per-series ERC-20 whose router-only `postTransferIn` hook burns each redeemed or exited unit |
| `TremorSeriesDeployer` | `CREATE2` deployer for vaults and receipts |
| `TremorLens` | Batched read model, live quotes, vault state, oracle progress, taker data |
| `TremorPrograms` | Stateless read model for the three orders, their programs and the ship plan |
| `RealizedVarianceOracle` | Bounded trailing realized variance for `VarianceSpread` and the LVR tools |

All constructor dependencies must contain code, and the Lens verifies that controller, engine,
accumulator, deployer and router agree about each other. Contracts are immutable and non-upgradeable.

## No custom opcodes

v1 shipped four opcodes in the unallocated `0xd0..0xef` bank, which meant Tremor had to deploy its own
router. v2 uses three stock instructions and puts all pricing behind the built-in `Extruction`:

```text
ISSUE   = Salt(id,1) · Deadline(saleEnd) · Extruction(engine, [1,1,id])
EXIT    = Salt(id,2) · Deadline(expiry)  · Extruction(engine, [1,2,id])   + postTransferIn → receipt
SETTLE  = Salt(id,3) ·                     Extruction(engine, [1,3,id])   + postTransferIn → receipt
```

| Opcode | Instruction | Args |
|---|---|---|
| `0x02` | `Salt` | `abi.encodePacked(uint64 seriesId, uint8 leg)` — the leg is part of the order identity |
| `0x20` | `Deadline` | `saleEnd` on ISSUE, `expiry` on EXIT. SETTLE has none, deliberately |
| `0x04` | `Extruction` | `target = TremorMarketEngine`, args `[version:1][mode:1][seriesId:8]` |

`test/RouterCompat.t.sol` is the evidence, and it ran before any production encoding depended on it. It
records what the canonical SwapVM address on Base actually is — a SwapVM router that hashes Aqua orders
identically to the pinned source but exposes a different swap ABI — and then proves `Extruction` and
maker hooks against the unmodified official source, which is what Tremor deploys.

`TremorOrderBuilder` is the only encoding path. The invariant is:

```text
router.hash(order) == keccak256(abi.encode(order)) == Aqua strategy hash
```

MakerTraits: maker is the writer's vault, receiver defaults to the maker (Aqua requires it),
`useAquaInsteadOfSignature` is set, tokens are sorted, and the two burn legs set `hasPostTransferInHook`
with the receipt as target. **Direction is enforced inside the engine by token address**, per leg, not by
the sorted-direction flag — which is why an ISSUE order cannot be swapped backwards into a free exit.

## The vault, and what a writer cannot do

Immutables: `OWNER`, `QUOTE_TOKEN`, `AQUA`, `ROUTER`, `CONTROLLER`. `forceApprove(AQUA, max)` runs in the
constructor and nowhere else; there is no setter at any privilege level.

| Open | Owner-only | Controller-only |
|---|---|---|
| `deposit` | `withdrawFree` (≤ `balance − locked`) | `increaseLocked`, `decreaseLocked`, `registerAndApproveReceipt`, `shipStrategy`, `dockStrategy` |

`_assertSolvent()` runs after every mutation. There is no rescue, `execute`, `delegatecall` or `receive`.

Consequently, and each tested in `test/Adversarial.t.sol`:

- withdrawing reserved collateral reverts `ExceedsFree`;
- the Aqua allowance cannot be reduced, because no function exists to reduce it;
- unsold inventory cannot be moved — it is the vault's, and only the controller can move or burn it;
- docking a burn leg while claims are outstanding reverts;
- a writer buying and redeeming their own receipts is a round trip, not a withdrawal, because
  `amountOut <= released`.

## Reservations

```text
maxLiability(u)   = ceil(u · unitNotional · capVariance / 1e36)     before finalization
finalLiability(u) = ceil(u · payoutPerUnit / 1e18)                  after finalization
```

Computed from the **aggregate** outstanding position, never per-unit times a count, so splitting a fill
cannot drift the reservation. A sale increases the reservation; a burn decreases it; nothing else moves it.

Controller callbacks:

| Callback | Caller | Effect |
|---|---|---|
| `onIssue` | engine | Reserve at the cap, record the premium, raise the skew |
| `onExit` | engine | Lower the skew |
| `onBurn` | the series' receipt | **The only place a liability decreases.** Validates the leg from the order hash, requires `amountOut <= released` |
| `onFinalize` | accumulator | Fix `finalVariance` / `payoutPerUnit`, reprice from the cap, release the surplus |

That last one matters economically: a series finalizing at 30% vol against a 100% cap returns ~91% of the
reservation immediately, before any holder redeems.

## One real balance behind two burn legs

EXIT and SETTLE are each shipped with `maxSeriesLiability` of the quote token as an Aqua **virtual**
balance, against the vault's single **real** balance. Safe because a unit leaves through exactly one of
them — both burn the receipt — and because every payout is bounded by the liability that burn releases.

## Series rules

`_validate` enforces:

```text
feed == FEED, quoteToken == QUOTE_TOKEN
expiry > start, sampleInterval >= 300, (expiry − start) % sampleInterval == 0, 2 <= samples <= 256
now <= saleEnd, start <= saleEnd, saleEnd <= expiry
unitNotional > 0
0 < capVariance <= 4e18            (200% vol)
0 < anchorVariance <= capVariance
impactPerUnit <= capVariance
10 <= halfSpreadBps <= 2000
halfLife == 0 or 300 <= halfLife <= 30 days
maxUnits > 0, 0 < maxSeriesLiability <= type(uint248).max
```

Creation additionally requires `maxSeriesLiability` of free collateral in the vault, ships all three
strategies asserting Aqua returned each pinned hash, and seeds the opening sample when
`start <= block.timestamp` so the market can quote in the same block.

`createBackdatedDemoSeries` relaxes only `saleEnd <= expiry` and reverts unless `block.chainid == 31337`.
It exists to demonstrate settlement against historical Chainlink data on a fork.

## Pricing and settlement

Every formula is in `libs/VariancePricing.sol` as integer-only pure math, and every one is pinned by
`test/vectors/pricing_vectors.json` — 60 cases at 60 decimal digits from
`tools/reference/pricing_reference.py`. See `../ARCHITECTURE.md` §1 for the formulas.

Rounding is maker-favouring throughout: ISSUE exact-in floors units, ISSUE exact-out ceils the premium,
EXIT and SETTLE floor proceeds, and every liability ceils.

The engine runs identical arithmetic for `quote` and `swap`; only a swap writes state, guarded on
`isStaticContext`. Both ISSUE and EXIT additionally require the market to be **current** — every passed
sample point stored — because the projection blends realized variance with the forward variance.

Realized variance is accumulated incrementally by `VarianceAccumulator` with a resumable phase-aware
cursor, then annualized at finalization. `finalVariance` is stored uncapped; the cap applies to the
payout. A series that finalizes at zero has `payoutPerUnit == 0`, which SwapVM cannot pay, so
`burnWorthless` releases those reservations instead.

`VarianceSpread` consumes only a present, fresh oracle cache; missing or stale data reverts rather than
quietly applying the base spread.

## Portfolio markets (v3, `src/portfolio/`)

A separate, versioned deployment alongside the series stack — nothing above is redirected to it.
`TremorPortfolioMarket` is both the controller and the `Extruction` target for one **risk group**: two
complementary capped claims, HIGH and CALM, on the same finalized observation. With
`x = min(finalVariance / capVariance, 1)` and payout scale `S` (quote base units per 1e18 units):

```text
HIGH pays  floor(S * x / 1e18)        per 1e18 units
CALM pays  S - floor(S * x / 1e18)    (exact integer complement, so highPpu + calmPpu == S)

reserve(h, c) = ceil(max(h, c) * S / 1e18)     while live
              = floor(h*hp/1e18) + floor(c*cp/1e18)   after finalization
```

Six stock `Salt`/`Deadline`/`Extruction` programs per group (ISSUE/EXIT/SETTLE × side), encoded only by
`PortfolioOrderBuilder` with args version 2, shipped through the same `TremorMakerVault` and burned
through the same router-only `VarianceReceipt` hook. The accumulator is reused unchanged; one
finalization fixes both payouts and releases the cap surplus plus any unspent exit buffer.

What is deliberately different from the series stack:

- **Selling the smaller side reserves nothing.** 100 HIGH + 100 CALM lock $100, not $200; issuance is
  clamped to `reserve + freeQuote` capacity instead of requiring the full cap at creation.
- **Burning the smaller side releases nothing**, so exits pay only from (reserve actually released by
  that burn) + the group's `exitBuffer`. The buffer is collateral explicitly locked for buybacks:
  `allocateExitBuffer` (writer-only, earmarks free vault collateral) or `fundExitBuffer` (permissionless,
  transfers the caller's own tokens in). Exits never touch free balance read mid-fill — free headroom
  could be double-spent by a taker callback interleaving a second fill; the buffer is debited and
  re-checked inside the burn hook, so a raced exit fails closed. Unspent buffer is writer-withdrawable,
  which means an exit quote can become unavailable before execution while settlement backing stays locked.
- **Pricing is the writer's fixed executable bid/ask per side**, disclosed as such — not a fair-value
  volatility model. Solvency never depends on the quotes (`PortfolioEconomics.t.sol` includes the
  mispriced-writer case: the loss lands on writer capital, never holder backing).
- The engine path requires `msg.sender == ROUTER` (as the series engine now also does).

Suites: `PortfolioGate` (the seven feasibility criteria, end to end), `PortfolioAdversarial` (a real
reentrant taker driving nested fills through router callbacks, both transfer orders), `PortfolioEconomics`
(round trips, complete-set pricing), `PortfolioInvariants` (stateful campaign + non-vacuity),
`PortfolioForkE2E` (Base fork, real USDC and Chainlink history). Evidence taxonomy and the deployed-v2
impact note live in `../docs/research/portfolio-gate-report.md`.

## Size budget

The controller embeds its children's creation code, so **EIP-3860** (49,152 initcode) binds before
EIP-170 (24,576 runtime). `VarianceSeriesFactory` is 17,892 runtime and **46,484 initcode — 2,668 spare**.
That is why `optimizer_runs = 200`, and why the read models live in `TremorLens` and `TremorPrograms`
rather than on the controller. `ShipRoundTrip` guards both limits.

## Commands

```bash
forge fmt --check
forge build --sizes
forge test                                                   # 171 tests, 14 suites
BASE_RPC_URL=https://mainnet.base.org forge test --match-contract ForkE2E -vv
BASE_RPC_URL=https://mainnet.base.org forge test --match-contract RouterCompat -vv
```

`./script/export-abi.sh` refreshes both `../web/src/abi` and `../backend/abi`. **Do it after every
redeploy**: a stale ABI decodes the live Lens struct into the wrong fields with no error anywhere.

## Test matrix (171 tests)

| Suite | Tests | Coverage |
|---|---:|---|
| `RouterCompat` | 2 | The official-router gate: what the canonical address is, and `Extruction` + maker hooks on the pinned source |
| `ShipRoundTrip` | 9 | Hash identity across all three legs, receipt naming, immutable strategies, EIP-170 and EIP-3860 |
| `SeriesCreation` | 13 | Every validation bound, vault requirements, the demo path's chain gate, the seeded opening sample |
| `MakerVault` | 17 | Deterministic address, immutables, free/locked accounting, every path a writer might try |
| `VarianceAccumulator` | 16 | Bounded batches, idempotent no-ops, cursor resumption, finalization preconditions |
| `MarketPricing` | 22 | The 60 reference vectors plus decay, projection, band clamping and split-fill additivity |
| `IssueLeg` | 22 | Integral pricing, exact-in/out, all four clamps, partial fills, reservation deltas |
| `ExitLeg` | 17 | Bid integral, zero-bid clamp, released-liability clamp, burn and reservation release |
| `SettlementLeg` | 17 | Final payout, cap, exact-in only, burns, the worthless path |
| `RealizedVariance` | 9 | High-precision vectors, phase crossing, invalid answers, windows and decimals |
| `Lifecycle` | 1 | One end-to-end pass: issue → exit → checkpoint → finalize → redeem → close |
| `Adversarial` | 22 | Every writer attack, forged orders, cross-series reservations, replay, self-settlement, wiring |
| `Invariants` | 2 | 9 stateful invariants under a handler (one campaign), plus a scripted test proving the handler reaches every state |
| `ForkE2E` | 2 | Canonical Aqua, Base USDC and real ETH/USD history on a local fork |

The non-vacuity test in `Invariants` exists because an earlier version of the suite passed while never
successfully issuing a single unit. An invariant suite that cannot reach the interesting states proves
nothing, so the ability to reach them is itself asserted.

## Measured gas (Base fork, real Chainlink ETH/USD)

| Operation | Gas |
|---|---:|
| One bounded checkpoint, 8 samples of real history | 513,002 |
| A 61-sample window, all 8 bounded calls | 4,104,019 |
| `finalize` | 159,192 |
| Redemption after finalization | 296,021 |
| One bounded checkpoint on a live forward window | 192,773 |
| Buy through the official router | 234,481 |
| Exit through the official router | 241,866 |

Total window gas is slightly higher than v1's monolithic settlement. What changed is who pays and whether
the transaction fits: no single caller carries the whole window, and every call has a hard upper bound.

## Deliberate trust boundary

**A sold unit is fully collateralized, and that is enforced rather than asserted.** What the protocol
still does not claim: it is not an order book (one maker per series — the writer's vault), not a
conventional variance swap (capped, transferable, prepaid), not a fair-value oracle (the bid and ask are
one market's executable quote), and not a perfect LVR hedge (the cap truncates exactly where the bill is
largest). Liveness depends on somebody calling the permissionless, bounded checkpoint and finalize —
cheap, splittable, and wanted by everyone who wants anything from the series.
