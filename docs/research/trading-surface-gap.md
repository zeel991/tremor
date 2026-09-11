# The trading-surface gap — why Tremor reads as a betting market

Written 2026-09-12, after Group 2's lifecycle completed on Base Sepolia. **No code changed as a result of
this note.** It records a diagnosis and two open decisions so they are not lost.

---

## The observation

> "This feels more like betting variance rather than trading variance... What I need is a proper trading
> platform where variance is treated like it's its own unique chart which goes high and low, and a HIGH
> chart and a CALM chart which go high and low accordingly. You can see your potential payout if you exit
> right now."

The instinct is correct. It is worth separating two claims that get conflated, because only one of them
is actually true.

## What is genuinely true: the venue is a fixed-odds book

The deployed v3 portfolio market prices from **four constants**:

```solidity
struct GroupParams { …  uint128 askHigh; uint128 bidHigh; uint128 askCalm; uint128 bidCalm; }
```

and `_priceIssue` does nothing but read one of them:

```solidity
uint256 ask = high ? g.params.askHigh : g.params.askCalm;
```

No inventory skew, no price impact, no decay. Group 2's HIGH ask was 300,000 before a 100-unit fill and
300,000 after it. One dealer, fixed quotes, take it or leave it.

`marketQuote` confirms it from the other direction — it reports `impactPerUnit: 0, halfLife: 0` for
portfolio groups.

**There is no price discovery in v3, and nothing should ever be written that implies otherwise.** The UI
already says "fixed bid/ask quotes set by the writer, not a fair-value volatility model" and that wording
should stay.

Worth noting the contrast: the **v2 single-series engine does have real dynamic pricing** —
`VariancePricing.sol` implements inventory skew with half-life decay (`decaySkew`) and integral pricing
across fill size, so splitting a fill cannot beat one fill. v3 deliberately dropped all of it to make the
two-sided `max(h,c)` reserve provable. Market microstructure was traded for a capital-efficiency proof.

## What is not true: that the instrument is a bet

Three properties separate it from a wager:

1. **The payoff is a real statistic of ETH's price path** — realized variance — not an arbitrary event.
   It is the payoff of a capped variance swap, an instrument institutions actually trade.
2. **Settlement comes from Chainlink's own round history.** The writer does not determine the outcome,
   cannot dispute it, and submits no price.
3. **It is fully collateralized.** A bookmaker can refuse to pay. This vault cannot — the backing was
   locked at the moment of sale and is released only by a burn.

**Real instrument, primitive venue.** That is the accurate framing.

## Why the chart looks dead — the actual defect

`web/src/components/pairs/PairMarketChart.tsx` (432 lines, untracked) already implements three views —
prices, realized volatility, payoff curves — and builds a HIGH/CALM trajectory.

It looks static because of what feeds it: **on-chain checkpoints, and Group 2 had exactly two.** A chart
with two points is a straight line. The concept is fine; there is no data in it.

### The thing that genuinely moves

HIGH and CALM have a continuously-moving intrinsic value *during* the window. As variance accumulates,
`x = min(RV_so_far / cap, 1)` rises; HIGH gains value and CALM loses it, on **every Chainlink round**, not
only when somebody pays gas to checkpoint.

The backend can already compute this and does not expose it:

- `backend/src/rv.rs` has `realized_variance(prices, span_seconds)`
- `backend/src/chainlink.rs` caches raw rounds; `/feed/history` serves them densely today
- `/series/:id/variance` exists for **v2 series**
- **there is no `/pairs/:id/variance`** — that is the gap

`/pairs/:id` currently returns only `{checkpoints, events, group, onchain}`.

## Proposed work (NOT started)

1. **`/pairs/:id/variance`** — dense variance path computed from cached feed rounds. Same arithmetic
   `RealizedVariance.sol` runs at finalization, evaluated ahead of the on-chain checkpoint. Mirrors the
   existing v2 endpoint, so it is a port, not a new design.
2. **Live HIGH/CALM value lines** driven by it, plotted against the writer's flat ask/bid — which is
   exactly how a fixed-strike instrument is normally displayed.
3. **"Exit now for $X" and P&L vs entry.** The exit figure already exists and is *executable*, not an
   estimate: `router.quote` on the EXIT leg runs the identical arithmetic as the swap.

Estimated 4–6 hours. **No contract changes. No redeployment. No risk to the Group 1 / Group 2 evidence.**

## Two honest limits

**Price discovery is not reachable before the deadline.** The quote is four constants in deployed
bytecode. Changing it means new contracts, a new deployment, and discarding the mined Group 1 and Group 2
evidence — which is the substance of the submission.

**A short window cannot carry a rich chart either.** Chainlink ETH/USD on Base Sepolia prints roughly
every 6 minutes (measured gaps 78–856 s, mean ≈360 s). Group 2's 30-minute window contained perhaps 5–8
price points. Denser than two checkpoints; still thin.

The clean fix for that is **one long-dated group** — 7 days would sit behind ~1,700 feed rounds and give a
genuinely alive chart. It would never settle before the deadline, and does not need to: Groups 1 and 2 are
the settled evidence, and a long-dated group would be the live trading surface. Cost is one `createGroup`
transaction and no deposit (the vault holds 149,957,300 free).

## Open decisions

1. Build the variance endpoint and live value chart? (~4–6 h, competes with hosting and the demo video)
2. Create one long-dated group as the live chart surface? (one transaction, requires explicit approval)

Deferred by the release owner on 2026-09-12: *"we can think about the next update later."*

## If none of this is built

Nothing in the submission becomes false. The current documentation already describes the quotes accurately
and never claims price discovery. The risk is presentational: a 1inch judge may read the surface as a
betting slip and undervalue the collateral mechanism and the shared reserve, which are the genuinely novel
parts. Lean the pitch on those.
