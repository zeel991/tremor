A series is fully described by one struct, passed to `VarianceSeriesFactory.createSeries(vault, params)` and baked into all three program byte strings.

```solidity
struct SeriesParams {
    address feed;           // Chainlink AggregatorV3 proxy (8 dec)
    address quoteToken;     // USDC
    uint40  start;          // observation window start T0
    uint40  expiry;         // window end T1 (> start); finalization allowed from here
    uint40  saleEnd;        // ISSUE leg deadline (<= expiry)
    uint32  sampleInterval; // seconds; (expiry-start) % sampleInterval == 0, >= 300
    uint128 unitNotional;   // USDC (6 dec) per unit per 1.0 (1e18) variance
    uint64  capVariance;    // WAD, max variance paid (1e18 = 100% vol)
    uint64  anchorVariance; // WAD, the market's resting forward variance
    uint64  impactPerUnit;  // WAD forward-variance move per 1e18 units of net inventory
    uint32  halfLife;       // seconds for the inventory skew to halve (0 = no decay)
    uint16  halfSpreadBps;  // half the bid/ask spread, in bps of projected variance
    uint128 maxUnits;       // receipt units minted to the vault (18 dec)
}
```

## Fields

| Field | Type | Meaning |
|---|---|---|
| `feed` | `address` | Chainlink `AggregatorV3` proxy for ETH/USD (8 decimals). Must equal the controller's configured feed. |
| `quoteToken` | `address` | USDC (6 decimals). Premiums are paid in it; exits and redemptions pay it out. Must equal the controller's configured token. |
| `start` | `uint40` | Observation window start `T₀`. Sample 0 is taken here. |
| `expiry` | `uint40` | Window end `T₁ > start`. The EXIT leg's deadline, and the earliest finalization. |
| `saleEnd` | `uint40` | ISSUE-leg `Deadline`. Production creation requires `now ≤ saleEnd ≤ expiry`. |
| `sampleInterval` | `uint32` | `Δ` in seconds. `(expiry − start) % Δ == 0` and `Δ ≥ 300`. `n = (expiry − start)/Δ` samples, `2 ≤ n ≤ 256`. |
| `unitNotional` | `uint128` | USDC (6 dec) paid per receipt unit per `1.0` (`1e18`) of variance. |
| `capVariance` | `uint64` | WAD, `0 < cap ≤ 4e18` (200% vol). The payout ceiling, and therefore the writer's per-unit liability. |
| `anchorVariance` | `uint64` | WAD, `0 < anchor ≤ cap`. Where the market's forward variance rests with no inventory sold. |
| `impactPerUnit` | `uint64` | WAD, `≤ cap`. How far the forward variance moves per `1e18` units of **net** inventory sold. |
| `halfLife` | `uint32` | Seconds for the inventory skew to halve. `0`, or `300 ≤ halfLife ≤ 30 days`. |
| `halfSpreadBps` | `uint16` | `10 ≤ s ≤ 2000`. Half the bid/ask spread as a fraction of projected variance. |
| `maxUnits` | `uint128` | Receipt units minted to the vault at creation (18 decimals; `1e18` = one unit). |

Creation additionally requires that the whole-inventory liability

```text
maxSeriesLiability = ceil(maxUnits · unitNotional · capVariance / 1e36)
```

is non-zero, fits `uint248`, and is available as free collateral in the writer's vault. See [Collateral and the vault](/docs/mechanics/collateral).

## Fixed-point conventions

- Variance and vol are WAD (`1e18`). `variance = 1e18` means 100% annualized vol (σ² = 1); vol = √variance.
- USDC has 6 decimals; receipts have 18, and `1e18` is one unit.
- Every executable number is computed in integers. There is no floating point anywhere in the pricing path — not in the contracts, not in the Lens, and not in the numbers the trade tickets show.
- Rounding always favours the maker, which is the writer's collateralized vault: buyers round up on what they pay and down on what they receive; liabilities round up.

## What `/write` derives for you

The write flow takes three decisions — **how long**, **how much collateral**, and **at what price** — and derives the other ten fields exactly, in integers:

| Derived | Rule |
|---|---|
| `start` | The next whole hour at least five minutes out, so the sampling grid lands on clean clock times |
| `expiry` | `start + days · 86,400` |
| `sampleInterval` | The finest grid on the ladder at or under 84 samples, the measured gas envelope for bounded checkpointing |
| `saleEnd` | `start` + a quarter of the window, snapped to the grid |
| `unitNotional` | 100 USDC — a protocol constant, so a "unit" means the same thing in every series |
| `capVariance` | A round vol at least 2× trailing realized and at least `√(2 · anchor)`, so buyers keep meaningful upside |
| `anchorVariance` | Trailing realized vol × the chosen stance (cheap / fair / rich), squared into variance |
| `impactPerUnit` | `min(lift · anchor, cap − anchor) / maxUnits`, so clearing the whole inventory is a bounded, stated move |
| `halfLife` | Three sampling steps, held between 1 h and 12 h |
| `halfSpreadBps` | 200 bps — a 4% round trip in variance terms |
| `maxUnits` | `collateral / maxPayoutPerUnit`, floored to 0.01 units so the reservation never exceeds what you deposited |

Every one of them is editable under **Advanced**, and every override runs back through the same derivation, so the audit table, the ticket and the transaction can never disagree about what ships.
