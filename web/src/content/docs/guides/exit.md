Exit is the other side of the market: receipts in, USDC out, at the **executable bid**, any time before expiry. The receipts are burned, and the writer's collateral for them is released in the same transaction.

This is what makes a Tremor receipt a position rather than a lottery ticket. You do not have to hold to expiry to find out whether you were right.

## In the app (`/series/[id]`)

Choose the **Exit** tab in the trade rail. Type the units you want to sell. The ticket shows:

- the executable bid per unit,
- the proceeds for that exact size, quoted on chain,
- your P&L against your indexed entry price, when this wallet has indexed buys,
- the slippage tolerance,
- and an explicit note that the receipts are burned.

When the size you asked for cannot fully fill, the ticket says how much will and quotes that.

## What happens on chain

| # | Step | Call |
|---|---|---|
| 1 | Approve receipts to the **router** | `receipt.approve(router, units)` — skipped if the allowance suffices |
| 2 | Swap | `router.swap(exitOrder, units, takerData)` |

The router pulls your receipts, Aqua pushes USDC out of the writer's vault to you, and the receipt's `postTransferIn` hook burns the units and calls `onBurn`, which releases the reservation. All of it in one transaction; none of it if any part fails.

## The price

Exit is priced by the market, not by the payoff. It is the integral of the **falling** bid across your size:

```text
proceeds(u) = floor( unitNotional · (bidVariance·u − floor(bidSlope·u²/2e18)) / 1e36 )
```

So a large exit gets a worse average than the top-of-book bid, for the same reason a large buy pays more than the opening ask. Splitting the sale does not help: the arithmetic is the integral either way, and where the rounding differs it differs against the splitter.

## Depth

An exit is clamped by four things:

```text
units     <= units actually outstanding
units     <= units to zero bid          bidVariance / bidSlope
amountOut <= collateral this burn releases
amountOut <= the leg's Aqua balance
```

The third clamp is the one that keeps the shared balance safe: a payout can never exceed the obligation that disappears with the burn. See [Collateral and the vault](/docs/mechanics/collateral#one-reserve-two-burn-paths).

## Why an exit can be refused

| Ticket says | Reason |
|---|---|
| Window has not started | `now < start` |
| Exit unavailable | `now ≥ expiry`, the series is finalized, or the EXIT leg has been docked |
| Update the market first | Sample points have passed without being stored |
| No receipts held | This wallet holds none |
| Exceeds your balance | You asked to sell more than you hold |

After expiry there is no exit. What there is instead is [redemption](/docs/guides/redeem), at the realized variance, with no deadline at all.

## After the fill

The market's skew falls by `impactPerUnit · units`, so the ask the next buyer sees comes down too. Your indexed P&L appears on `/portfolio`, and the fill shows up in the series' **Fills** table tagged `exit`.
