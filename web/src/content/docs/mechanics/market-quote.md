Every market quotes **two executable prices**: an ask a buyer pays and a bid a holder can sell into before expiry. Both come from one number — the variance the market currently projects for the whole window — with a spread around it and the cap over it.

Nothing here is implied volatility. There is no option surface anywhere in Tremor; the quote is one market's price, and the app labels it *market quote volatility* for exactly that reason.

## Inventory skew

The market keeps one signed number per series: `skew`, the accumulated price impact of net inventory sold. Buying raises it, exiting lowers it, and it decays back toward zero on the series' half-life.

```text
decayedSkew = skew · 2^(−(now − lastTs) / halfLife)         (halfLife = 0 → never decays)
forward     = clamp(anchorVariance + decayedSkew, 0, capVariance)
```

Integer division truncates toward zero, so decay can only ever shrink the magnitude — it can never flip the sign or amplify.

## Projection

The forward variance only applies to the part of the window that has not happened yet. What has happened is measured, not quoted:

```text
elapsed   = checkpointedThrough − start
remaining = expiry − checkpointedThrough
projected = (realizedSoFar · elapsed + forward · remaining) / (elapsed + remaining)
```

Before the window opens the projection is exactly the forward variance; at expiry it is exactly the realized variance. This is why a market's quote converges on what actually happened rather than staying at the writer's opinion.

`projected` is deliberately **not** clamped to the cap. It is a measurement, and clamping belongs to the price.

## The band

```text
askVariance = min(ceil(projected · (1 + s)), cap)
bidVariance = min(floor(projected · (1 − s)), cap)          s = halfSpreadBps / 10,000
```

Per-unit prices are `floor(unitNotional · variance / 1e18)`. The clamp to the cap matters: without it a market could quote an ask above what the receipt can ever pay, and the engine would have to refuse a fill it had just advertised.

## Integral fill pricing

Selling `u` units raises the skew by `impactPerUnit · u / 1e18`, which reaches the ask through the projection weight `remaining / duration` and the ask multiplier `(1 + s)`. Both are affine, so the marginal ask is affine in `u` with slope

```text
askSlope = ceil(impactPerUnit · remaining · (1 + s) / duration)
bidSlope = floor(impactPerUnit · remaining · (1 − s) / duration)
```

and a fill is priced by the **integral** of that marginal price, not by the opening quote:

```text
premium(u)  = ceil( unitNotional · (askVariance·u + ceil(askSlope·u²/2e18)) / 1e36 )
proceeds(u) = floor( unitNotional · (bidVariance·u − floor(bidSlope·u²/2e18)) / 1e36 )
```

This is what makes splitting a fill pointless. Buying `u₁` then `u₂` costs the same as buying `u₁ + u₂` in one go, up to the two ceilings — and where the ceilings differ, they differ *against* the splitter.

### Exact-in

Given `amountIn` USDC, with `X = amountIn · 1e36 / unitNotional`, the engine inverts the integral in a cancellation-free form:

```text
u = 2X / (askVariance + ceil√(askVariance² + 2·askSlope·X/1e18))
```

which degenerates to `X / askVariance` when the slope is zero. The root rounds **up**, so a taker never receives more units than the exact real-valued solution.

## Clamps

An ISSUE fill is the minimum of four limits, and a partial fill re-prices the amount that actually filled:

| Clamp | Why |
|---|---|
| Inventory still shipped on the ISSUE leg | You cannot sell what was not minted |
| `units to cap` | The marginal ask may not cross the cap |
| `units to collateral` | The vault's free collateral has to cover the new reservation at the cap |
| The buyer's `amountIn` | Exact-in |

An EXIT fill is clamped by the units actually outstanding, by the point where the falling bid would reach zero, by the collateral the burn releases, and by the leg's Aqua balance.

## Quote and swap agree

The engine runs identical arithmetic in both directions. The only difference is that a swap writes state — the new skew, the new reservation — and a quote does not, guarded on SwapVM's `isStaticContext`. So `quote` and `swap` cannot disagree within a block, and the number in the ticket is the number you sign for.

## Where the numbers come from

The Lens exposes the whole quote in one call: `marketVariance`, `projectedVariance`, `realizedVarianceSoFar`, `bidVariance`, `askVariance`, `bidPerUnit`, `askPerUnit`, `maxPayoutPerUnit`. The series page's chart plots realized volatility against market-quote volatility with the executable band behind them; the historical path is reconstructed by the backend from indexed fills and checkpoints, and the live point always comes from the chain.

`web/src/lib/series.test.ts` checks the frontend's replica of these formulas against the same 60-digit reference vectors the Solidity library is tested with, so a figure on a screen and a fill in a block agree to the last base unit.
