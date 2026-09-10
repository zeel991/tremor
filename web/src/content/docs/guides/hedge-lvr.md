Loss-versus-rebalancing is the cost a constant-product LP pays for being arbitraged as the price moves. It is proportional to realized variance, which is exactly what a Tremor receipt pays.

## The formula

For a constant-product position of value `V` over a horizon `T` (in years), with annualized vol `σ`:

```
E[LVR] ≈ V · σ² · T / 8
```

(Milionis, Moallemi, Roughgarden, Zhang). A receipt unit pays realized variance over its own fixed
window, capped at `capVariance`. The following is a coarse gross sizing estimate, not replication:

```
hedgeUnits = (V · T / 8) / unitNotional
```

Both `V · T / 8` and `unitNotional` are in USD, so the result is in receipt units. The Lens exposes the same calculation as `lvrHedgeUnits(id, poolValueUsdc, horizonSeconds)`, and the backend serves it at `GET /lvr`.

## In the app (`/hedge`)

1. Enter pool value and horizon in days.
2. Pick a vol source: trailing 1d / 7d / 30d realized (from the backend's Chainlink cache) or a custom vol.
3. Read **Expected LVR** and the hedge notional `V · T / 8`.
4. For every series with issuance open the table shows the market's quote volatility, the hedge units and the on-chain quote for that exact size as a share of the pool. **Buy** opens the series with `?units=` pre-filled.

The allocation card shows the vol used as a share of 100% and, for each live series, how much of the remaining inventory the hedge would take.

## Exact bigint math used by the UI

```
expectedLvr = poolUsdc · variance · horizonSec / (8 · 31_536_000 · 1e18)          USDC (6 dec)
units       = poolUsdc · horizonSec · 1e18 / (8 · 31_536_000 · unitNotional)     receipt units (18 dec)
```

## Caveats

- Payout is capped at `capVariance`; if `σ ≫ cap` the hedge under-pays.
- Cost uses the on-chain integral quote, including the price impact of your own size — a large hedge moves the market's forward variance, and you pay the integral, not the opening ask.
- The estimate is for a full-range constant-product position. Concentrated liquidity, fees, inventory,
  path timing and pool-specific arbitrage all change realized LP economics.
- Series window and hedge horizon must align; otherwise basis risk remains.
- Premium, the payout cap and available depth can dominate the gross estimate.
- Sold units are fully collateralized, so writer default is not on this list — but the cap still truncates the tail, and that truncation is exactly where an LVR shock hurts most.
