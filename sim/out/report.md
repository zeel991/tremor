# Tremor v2 — economic simulation

Ten scenarios against an integer replica of the deployed pricing library and the deployed vault accounting. The replica in `src/pricing.ts` is pinned to the same 60-digit reference vectors as the Solidity library (`npm run check`), so the numbers below are the contracts' arithmetic rather than an approximation of it.

**What acceptance means here.** Not profitability in every scenario — a short-variance position loses money when variance is high, and it should. Acceptance means the accounting is solvent at every step, the behaviour is explainable, and the writer's loss is exactly the short-variance exposure they sold and nothing else.

Seed `1` · generated 2026-09-10T22:26:01.292Z · 10 scenarios

## Solvency

Every invariant held in every scenario. Checked at each of the 86 sampling steps per scenario, and again after finalization, redemption and close:

- The vault's balance never fell below its locked collateral.
- A series' liability never exceeded the full-cap reservation for its outstanding units.
- Finalization released no more than had been locked.
- Every claim was extinguished, and no liability remained after redemption.
- With every series closed, all remaining capital was free — nothing was stranded.
- The vault's closing balance equalled deposits plus premiums minus payouts, to the base unit, in every scenario.

## Writer and buyer P&L

| Scenario | Realized vol | Ask at creation | Sold | Premium | Exit payouts | Redemptions | Writer P&L | Buyer P&L |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Low realized variance, well below the market's quote | 19.5% | 40.4% | 400.00 | 11,060.24 | 0.00 | 1,519.25 | **9,540.99** | −9,540.99 |
| Realized variance near the market's quote | 39.0% | 40.4% | 400.00 | 11,126.63 | 0.00 | 6,072.75 | **5,053.87** | −5,053.87 |
| High realized variance, at the cap | 107.0% | 40.4% | 400.00 | 11,716.02 | 0.00 | 39,999.99 | **−28,283.97** | 28,283.97 |
| Early volatility spike, then calm | 58.0% | 40.4% | 400.00 | 11,847.39 | 0.00 | 13,459.62 | **−1,612.23** | 1,612.23 |
| Calm, then a late spike | 67.4% | 40.4% | 400.00 | 11,050.56 | 0.00 | 18,174.58 | **−7,124.01** | 7,124.01 |
| Heavy issuance demand | 43.8% | 40.4% | 400.00 | 13,056.00 | 0.00 | 7,684.48 | **5,371.51** | −5,371.51 |
| Heavy early exits | 39.0% | 40.4% | 400.00 | 11,688.39 | 3,168.88 | 1.48 | **8,518.03** | −8,518.03 |
| Alternating issue and exit flow | 39.0% | 40.4% | 400.00 | 8,981.28 | 7,265.51 | 0.00 | **1,715.77** | −1,715.77 |
| The writer stops issuance mid-window | 48.7% | 40.4% | 400.00 | 11,725.17 | 6,343.20 | 651.82 | **4,730.13** | −4,730.13 |
| Three series sharing one vault | 39.0% | 40.4% | 400.00 | 11,380.20 | 0.00 | 6,072.75 | **5,307.44** | −5,307.44 |

Writer P&L is premium taken minus everything paid out on both burn legs. Buyer P&L is the aggregate of what every holder received minus what they paid. The two are exact mirrors by construction: there are no fees, no rebates and no third party in the flow.

## Settlement

| Scenario | Final variance | Final vol | Payout / unit | Exited | Redeemed | Unsold |
|---|---:|---:|---:|---:|---:|---:|
| Low realized variance, well below the market's quote | 0.0380 | 19.5% | 3.79 | 0.00 | 400.00 | 0.00 |
| Realized variance near the market's quote | 0.1518 | 39.0% | 15.18 | 0.00 | 400.00 | 0.00 |
| High realized variance, at the cap | 1.1454 | 107.0% | 100.00 | 0.00 | 400.00 | 0.00 |
| Early volatility spike, then calm | 0.3365 | 58.0% | 33.64 | 0.00 | 400.00 | 0.00 |
| Calm, then a late spike | 0.4544 | 67.4% | 45.43 | 0.00 | 400.00 | 0.00 |
| Heavy issuance demand | 0.1921 | 43.8% | 19.21 | 0.00 | 400.00 | 0.00 |
| Heavy early exits | 0.1518 | 39.0% | 15.18 | 399.90 | 0.10 | 0.00 |
| Alternating issue and exit flow | 0.1518 | 39.0% | 15.18 | 400.00 | 0.00 | 0.00 |
| The writer stops issuance mid-window | 0.2371 | 48.7% | 23.71 | 372.51 | 27.49 | 0.00 |
| Three series sharing one vault | 0.1518 | 39.0% | 15.18 | 0.00 | 400.00 | 0.00 |

## Capital

| Scenario | Collateral | Peak locked | Mean utilization | Released at finalization | Checkpoint calls | Largest batch | Clamped fills |
|---|---:|---:|---:|---:|---:|---:|---:|
| Low realized variance, well below the market's quote | 40,000.00 | 40,000.00 | 76.1% | 38,480.74 | 23 | 32 | 1 |
| Realized variance near the market's quote | 40,000.00 | 40,000.00 | 76.0% | 33,927.24 | 23 | 32 | 1 |
| High realized variance, at the cap | 40,000.00 | 40,000.00 | 75.1% | 0.00 | 23 | 32 | 1 |
| Early volatility spike, then calm | 40,000.00 | 40,000.00 | 74.9% | 26,540.37 | 23 | 32 | 1 |
| Calm, then a late spike | 40,000.00 | 40,000.00 | 76.2% | 21,825.41 | 23 | 32 | 1 |
| Heavy issuance demand | 40,000.00 | 40,000.00 | 74.5% | 32,315.51 | 23 | 32 | 1 |
| Heavy early exits | 40,000.00 | 40,000.00 | 11.0% | 8.28 | 25 | 32 | 1 |
| Alternating issue and exit flow | 40,000.00 | 22,899.99 | 5.3% | 0.00 | 84 | 1 | 1 |
| The writer stops issuance mid-window | 40,000.00 | 40,000.00 | 31.7% | 2,096.94 | 20 | 6 | 1 |
| Three series sharing one vault | 40,000.00 | 53,792.19 | 96.3% | 33,927.24 | 35 | 32 | 1 |

Utilization is the fraction of the vault's balance that was reserved, averaged over the window. It runs high wherever the inventory sold, because a unit is reserved at the **cap** until finalization — the cap is the only bound that is knowable while the window is open. A writer quoting 40% vol against a 100% cap therefore locks roughly six times the premium they collected, and gets the surplus back the moment the variance is fixed: the 'released at finalization' column is that refund, paid before any holder redeems.

Checkpoint calls are counted lazily — the simulation checkpoints when somebody wants to trade or to finalize, never on a schedule, because nobody is paid to do it. 'Largest batch' is the most samples any single call had to store, and it never exceeds the accumulator's own 32-sample bound.

## Bid/ask path and the projection

| Scenario | Bid/ask range per unit | Opening projection | Closing projection | Realized |
|---|---:|---:|---:|---:|
| Low realized variance, well below the market's quote | 3.72 – 35.45 | 50.1% | 19.5% | 19.5% |
| Realized variance near the market's quote | 14.87 – 35.66 | 50.1% | 39.0% | 39.0% |
| High realized variance, at the cap | 24.64 – 100.00 | 50.1% | 107.0% | 107.0% |
| Early volatility spike, then calm | 24.64 – 45.47 | 50.1% | 58.0% | 58.0% |
| Calm, then a late spike | 12.25 – 46.34 | 50.1% | 67.4% | 67.4% |
| Heavy issuance demand | 16.17 – 48.95 | 69.3% | 43.8% | 43.8% |
| Heavy early exits | 2.94 – 39.65 | 53.5% | 39.0% | 39.0% |
| Alternating issue and exit flow | 11.51 – 27.74 | 50.1% | 39.0% | 39.0% |
| The writer stops issuance mid-window | 12.86 – 39.83 | 53.5% | 48.7% | 48.7% |
| Three series sharing one vault | 14.87 – 37.85 | 51.3% | 39.0% | 39.0% |

The projection blends what has been measured with what the market forecasts for the rest of the window, so it converges on the realized number as the window closes. That convergence is the mechanism that stops a late buyer from pricing off variance that has already printed — and it is why the closing projection and the realized column agree.

## LVR hedge and residual basis

For a 1,000,000 USDC constant-product position over each scenario's window: `hedgeUnits = (V·T/8)/unitNotional`, bought at the opening ask.

| Scenario | Hedge units | Cost | Expected LVR | Hedge payout | Residual |
|---|---:|---:|---:|---:|---:|
| Low realized variance, well below the market's quote | 23.97 | 92.87 | 91.05 | 91.05 | −92.87 |
| Realized variance near the market's quote | 23.97 | 371.22 | 363.94 | 363.94 | −371.22 |
| High realized variance, at the cap | 23.97 | 2,397.26 | 2,745.71 | 2,397.26 | −2,745.71 |
| Early volatility spike, then calm | 23.97 | 822.78 | 806.65 | 806.65 | −822.78 |
| Calm, then a late spike | 23.97 | 1,111.01 | 1,089.23 | 1,089.23 | −1,111.01 |
| Heavy issuance demand | 23.97 | 469.75 | 460.54 | 460.54 | −469.75 |
| Heavy early exits | 23.97 | 371.22 | 363.94 | 363.94 | −371.22 |
| Alternating issue and exit flow | 23.97 | 371.22 | 363.94 | 363.94 | −371.22 |
| The writer stops issuance mid-window | 23.97 | 579.84 | 568.47 | 568.47 | −579.84 |
| Three series sharing one vault | 23.97 | 371.22 | 363.94 | 363.94 | −371.22 |

Residual is payout minus cost minus expected LVR. Two things are visible in it, and only the second is informative:

1. **Below the cap the payout tracks the expected LVR to within rounding.** That is an identity, not a discovery: the sizing rule solves `units · unitNotional · σ² = V · σ² · T / 8`, so the same σ² appears on both sides and cancels. The residual there is essentially minus the premium — the LP's real cost is the premium and nothing else.
2. **At the cap the identity breaks, and it breaks in the wrong direction.** 1 of 10 scenarios truncated: the payoff stops rising exactly where the LVR bill is largest, so the LP is left with the premium *and* the excess. That asymmetry is the honest shape of this instrument as a hedge, and it is why the app sizes and prices it rather than calling it one.

## Scenario notes

### Low realized variance, well below the market's quote

The writer's best case: they sold variance at 40% and it printed 20%.

- 1 fills were clamped and re-priced rather than reverted.

### Realized variance near the market's quote

The break-even neighbourhood: the writer keeps roughly the spread and the impact.

- 1 fills were clamped and re-priced rather than reverted.

### High realized variance, at the cap

The writer's worst case, and the proof that it is bounded by the cap and nothing worse.

- Realized variance finished above the cap (1.1454 vs 1.0000), so the payout is truncated and the hedge under-pays by exactly the excess.
- 1 fills were clamped and re-priced rather than reverted.

### Early volatility spike, then calm

Shows the projection converging downward as calm samples accumulate, and what that does to the bid.

- 1 fills were clamped and re-priced rather than reverted.

### Calm, then a late spike

The case the sale window exists for: the spike lands after issuance has closed.

- 1 fills were clamped and re-priced rather than reverted.

### Heavy issuance demand

Demand large enough to hit the inventory and collateral clamps, to show fills clamping instead of failing.

- 1 fills were clamped and re-priced rather than reverted.

### Heavy early exits

Everything bought in the first day is sold back in the second: the reserve has to survive it.

- 1 fills were clamped and re-priced rather than reverted.

### Alternating issue and exit flow

Round-tripping against the market repeatedly, to show the spread accrues and the skew does not drift.

- 1 fills were clamped and re-priced rather than reverted.

### The writer stops issuance mid-window

Proof that stopping sales leaves the exit and the redemption completely untouched.

- 1 fills were clamped and re-priced rather than reverted.

### Three series sharing one vault

Capital is reserved writer-wide, so a second and third market compete for the same free collateral.

- 1 fills were clamped and re-priced rather than reverted.

## What this does not model

- **Gas.** Checkpoint counts are reported, but their cost is measured on a Base fork instead (`contracts/test/ForkE2E.t.sol`), because that is the only place the real Chainlink round search can be timed.
- **The decay function.** `decaySkew` is the one formula the replica cannot compute bit-exactly, because the contract uses Solady's `expWad`. `npm run check` measures the divergence against the reference vectors rather than assuming it away.
- **Adversarial writers.** Every attack a writer might attempt is tested against the real contracts in `contracts/test/Adversarial.t.sol` and demonstrated on a fork in `contracts/script/demo.sh` stage C. A simulation cannot prove a revert; only the contract can.
- **Feed pathology.** Paths are generated on the series' own grid, so a sample never lands on a missing round. Real feeds repeat rounds, which biases realized variance downward — the reason for the 30-minute floor on the sampling grid.

