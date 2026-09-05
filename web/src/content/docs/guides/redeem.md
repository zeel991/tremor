Redemption is the last thing that happens to a receipt: receipts in, USDC out, at the **final realized variance**. It needs nothing from the writer, and it has no deadline.

## Two things have to be true first

1. `now ≥ expiry`.
2. The window is **finalized** — every sample point stored, and `finalize` called.

Both are permissionless, and both are one click away in the **Oracle** tab. See [Update and finalize](/docs/guides/oracle).

## The payout

```text
payoutPerUnit = floor(unitNotional · min(finalVariance, capVariance) / 1e18)
amountOut     = floor(units · payoutPerUnit / 1e18)
```

`payoutPerUnit` is written once by `finalize` and never changes. Before finalization the ticket says "not yet fixed" rather than showing an estimate — there is no such thing as a redemption price before the variance is fixed.

## What happens on chain

| # | Step | Call |
|---|---|---|
| 1 | Approve receipts to the **router** | `receipt.approve(router, units)` — skipped if the allowance suffices |
| 2 | Swap | `router.swap(settlementOrder, units, takerData)` |

The router pulls your receipts, Aqua pushes USDC out of the writer's vault, and the receipt's `postTransferIn` hook burns the units and releases the writer's reservation. Supply falls exactly with redemption, so a receipt can never be paid twice.

Measured on a Base fork against real Chainlink history, one redemption after finalization costs **296,021 gas**.

## No deadline, on purpose

The SETTLE program carries no `Deadline` instruction. A holder who redeems years later still redeems: the payout is fixed, the collateral is reserved, and the strategy cannot be docked while a single receipt is outstanding.

## When the payout is zero

If a window finalizes at zero realized variance, `payoutPerUnit` is zero — and SwapVM refuses any swap with a zero output, so the SETTLE leg cannot pay you at all. That is not a stuck position:

```text
factory.burnWorthless(id, units)
```

burns your receipts and releases the writer's reservation. The app detects the state and switches the ticket's button from **Redeem** to **Burn** on its own.

## Why a redemption can be refused

| Ticket says | Reason |
|---|---|
| Locked until expiry | The window is still live. Exit instead if you want out now |
| Finalize the variance first | Expired but not finalized. The Oracle tab does it |
| No receipts held | This wallet holds none |
| Exceeds your balance | You asked to redeem more than you hold |
| Series closed | Nothing outstanding; the series is wound up |

## After the fill

The position leaves `/portfolio`. The fill appears in the series' **Fills** table tagged `settle`, and the writer's `locked` drops by the liability your burn released.
