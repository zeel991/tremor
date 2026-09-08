Realized variance is computed on-chain from the Chainlink feed's round history — by `VarianceAccumulator` as the window is checkpointed and finalized, by `RealizedVarianceOracle` for trailing windows, and by the Lens for the live "realized so far" figure that the market's projection blends in.

## Sampling grid

All times are unix seconds, `Δ = sampleInterval`, `n = (expiry − start) / Δ` (must divide exactly).

```
tᵢ = start + i·Δ,   i = 0..n
Pᵢ = answer of the latest Chainlink round with updatedAt ≤ tᵢ   (scaled from 8 to 18 decimals)
```

## Annualized realized variance (WAD)

```
rᵢ  = lnWad(Pᵢ · 1e18 / Pᵢ₋₁)            i = 1..n   (signed WAD)
RV  = Σ rᵢ² · 31_536_000 / (expiry − start)   (WAD; rᵢ² computed as rᵢ·rᵢ/1e18)
RVc = min(RV, capVariance)
```

`RV = 1e18` is 100% annualized vol. The cap is applied to the **payout**, not to the measurement: `finalVariance` is stored uncapped and the app shows what actually happened even when it finished above the cap.

The accumulator stores `sumSquaredReturns` incrementally as samples are checkpointed, and `realizedSoFar` annualizes that partial sum over `checkpointedThrough − start`. Both the Lens' live figure and the market's projection read it from there rather than recomputing the window, which is why a market has to be current before it can quote. See [Checkpoints and finalization](/docs/mechanics/checkpoints).

## Phase-aware Chainlink round search

A proxy round id is `(phaseId << 64) | aggregatorRoundId`. `priceAt(t)`:

1. `p = proxy.phaseId()`; `latest = proxy.latestRoundData()`; `hi = latest.roundId & 0xFFFFFFFFFFFFFFFF` for phase `p`.
2. Loop over phases `p, p−1, …`: read `first = getRoundData(p<<64 | 1)`. If `first.updatedAt ≤ t`, binary-search `lo = 1..hi` for the largest round with `updatedAt ≤ t` and return its answer. For phases below the current one, `hi` is found by exponential probing until the round does not exist, then bisection. Otherwise `p −= 1`; if `p == 0` revert `WindowPredatesFeed`.
3. All calls are `staticcall`s.

A round **does not exist** when `getRoundData` reverts **or returns `updatedAt == 0`** — verified live on Base: the OCR aggregators behind ETH/USD return zeros for unknown rounds instead of reverting (FluxAggregators revert `No data present`). Both are handled and tested.

The highest phase whose first round is `≤ tᵢ` wins, then the largest round in that phase with `updatedAt ≤ tᵢ`. Sample 0 is a full search; each next sample gallops forward from the previous round — the same result as a per-sample binary search with fewer calls. Cost is `O(log rounds)` per sample.

Errors: `WindowPredatesFeed` if no round `≤ start`; `InvalidAnswer` for `answer ≤ 0`; feeds with more than 18 decimals are rejected.

## Why phases matter

On Base mainnet (checked 2026-09-02) ETH/USD is in **phase 3**, whose round 1 has `updatedAt = 1787757083`; phase 2 round 1 = `1773930645`, phase 1 round 1 = `1691045273`. Seven-day windows therefore cross the phase 2 → 3 boundary; the backend's 7d trailing window reports `phases_used: [2, 3]`. The fork test and demo use 5-day windows inside phase 3; phase crossings are covered by unit vectors (overlap and gap variants, three phases). The accumulator's cursor stores the phase it is in, so a window that crosses a boundary resumes correctly across bounded calls.

## Off-chain replica

The backend (`src/chainlink.rs`) replicates the same search, dense-fetches rounds through Multicall3 and caches them in SQLite. It computes `rᵢ = ln(Pᵢ/Pᵢ₋₁)` and `RV = Σ rᵢ² · 31 536 000 / (end − start)` in `f64`; WAD strings are `round(rv·1e18)`. The cap is **not** applied off-chain. Reference vectors in `contracts/test/vectors/rv_vectors.json` come from a Python `Decimal(80)` implementation; Solidity agrees within `1e-9` relative (actual `≤ 1e-14`).
