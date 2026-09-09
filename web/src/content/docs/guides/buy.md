Buying is one swap against the ISSUE leg: USDC in, receipt units out, at the market's **executable ask**.

## In the app (`/series/[id]`)

The dark rail holds the ticket. Type an amount in the top half — **USDC in** (exact-in) or, after pressing the swap button, **units out** (exact-out). The bottom half shows the other side from a live on-chain quote. The rows below show units, premium, average price per unit, break-even vol, the max payout at the cap, and the locked-backing confirmation for the fill. Pick a slippage tolerance and press **Buy**.

The hedge calculator links here with `?units=` pre-filled.

## What happens on chain

| # | Step | Call |
|---|---|---|
| 1 | Approve USDC to the **router** | `usdc.approve(router, premium)` — skipped if the allowance suffices |
| 2 | Swap | `router.swap(issueOrder, amount, takerData)` |

- `issueOrder = programs.order(id, Leg.ISSUE)`.
- `takerData` is built from the Lens with `isAToB = lens.legDirection(id, Leg.ISSUE)`; the threshold is the quote ± slippage (minimum units out for exact-in, maximum USDC in for exact-out).
- The ticket sets `allowPartialFill = true` and sizes the order to what can actually fill. Asking for more fills the remainder instead of reverting: the ticket says so up front and quotes the premium for the fill you actually get.
- The router pulls USDC from you, Aqua pushes it into the writer's vault, and Aqua pulls receipts out of the vault to you.

## Quotes

```text
exact-in:  engine.quoteIssueExactIn(id, usdcIn)    → (units, usdcUsed, ...)
exact-out: engine.quoteIssueExactOut(id, units)    → (usdcIn, ...)
```

Both run the same clamps and the same integral arithmetic as the fill itself. Break-even vol in the ticket is `√(premium / (units · unitNotional))` — the realized vol at which your redemption returns exactly what you paid.

## Why a buy can be refused

| Ticket says | Reason |
|---|---|
| Sale closed | `now > saleEnd`, or the series is past expiry — the ISSUE leg's `Deadline` |
| Update the market first | Sample points have passed without being stored. Anyone can fix it from the **Oracle** tab |
| Sold out | No inventory left on the ISSUE leg |
| Issuance closed | The writer stopped new sales. Exit and redemption still work |
| Vault does not back this series | One of the three collateral conditions does not hold right now |
| Only N units left | The request is larger than the clamps allow; the ticket quotes the partial fill instead of reverting |
| Insufficient USDC | Your balance is below the premium |

Two of the clamps deserve naming, because they are the market refusing to sell something it could not back: the marginal ask may not cross the cap, and the vault must have free collateral to reserve for the new unit at the cap. A fill that would exceed either is clamped down, not sold and hoped for.

## After the fill

Your receipts appear on `/portfolio` with an indexed entry price, the current executable exit bid and — once the series finalizes — the fixed redemption value. The market's skew rises by `impactPerUnit · units`, so the next buyer pays a little more and the bid you can exit into moves up too; both decay back toward the anchor on the half-life.

Your position is now backed by collateral the writer cannot withdraw. See [Collateral and the vault](/docs/mechanics/collateral).
