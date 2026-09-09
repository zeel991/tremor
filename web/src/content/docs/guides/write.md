Writing a series means opening a **two-sided market** in a capped variance receipt: you fund a vault, the controller mints the inventory into it and ships all three strategies, and the market quotes both a bid and an ask from then on. Your collateral sits in your own vault, and the part backing sold units cannot be withdrawn until those receipts are burned.

## Three decisions

`/write` asks for three things and derives the other ten parameters exactly:

1. **How long** — the observation window, in whole days.
2. **How much** — USDC to put behind the market. Inventory is `collateral / maxPayoutPerUnit`, floored to 0.01 units.
3. **At what price** — a stance on ETH's trailing realized volatility (cheap / fair / rich), or a custom vol.

The ticket shows the executable bid and ask the market will open at, the premium if the whole inventory sells, the break-even vol, the max payout per unit, the collateral that would be reserved at full sell-out, and the worst case. Everything is editable under **Advanced**, where all thirteen `SeriesParams` fields appear with the literal that ships in each.

## Before you start

- USDC in your wallet, or free collateral already in your vault, at least `ceil(maxUnits · unitNotional · capVariance / 1e36)`.
- A window that starts after the feed's first round. The wizard's ladders keep the sample count and the sampling grid inside the controller's bounds by construction.

## What the transaction does

| # | Step | Call |
|---|---|---|
| 1 | Maker vault | `factory.createVault()` — idempotent, skipped if you already have one |
| 2 | Approve USDC | `usdc.approve(vault, topUp)` — only the shortfall over free vault collateral |
| 3 | Fund the vault | `vault.deposit(topUp)` |
| 4 | Create and ship | `factory.createSeries(vault, params)` |

Step 4 does everything else in **one transaction**: deploys the `VarianceReceipt`, mints `maxUnits` into the vault, builds the three orders, pins their hashes, and ships ISSUE, EXIT and SETTLE to Aqua — asserting that Aqua returned each pinned hash. If any of that fails, none of it happened.

Progress is checkpointed in local storage, keyed to your account, the chain, the vault and the exact parameters. A retry waits on the same transaction instead of sending a second one, so it cannot create a duplicate series. The key is versioned: a v1 checkpoint cannot resume against v2.

## What you have afterwards

- A vault at a deterministic address whose owner is you, holding your collateral and the unsold inventory.
- Three Aqua strategies whose hashes are pinned in the controller.
- A market that quotes both sides, from the first block.

You never approve Aqua, never ship, and never dock. The vault does all three under the controller's direction, which is exactly what makes the collateral guarantees enforceable rather than advisory.

## Your collateral, from here on

```text
locked = Σ ceil(units sold · unitNotional · cap / 1e36)   across all your series
free   = balance − locked
```

`withdrawFree` reverts above `free`. A sale raises `locked`; an exit or a redemption lowers it; finalization reprices the whole reservation from the cap to the real payout and releases the difference immediately. `/portfolio` shows all four numbers and offers Deposit and Withdraw free.

## Winding down

- **Stop issuance** closes new sales for good and docks the ISSUE leg. Exit and redemption are untouched — holders keep both.
- **Close series** docks everything, burns the unsold inventory and frees the residual. It reverts while a single receipt is outstanding.

Docking is not a button you have. That is deliberate: "remove the leg that pays holders out" should not be an action a writer can take.

```cards
[{"href":"/write","title":"Write a series","subtitle":"Three decisions, thirteen parameters, one transaction","icon":"01"},
 {"href":"/docs/mechanics/collateral","title":"Collateral and the vault","subtitle":"Exactly what you can and cannot withdraw","icon":"$"},
 {"href":"/docs/mechanics/market-quote","title":"The two-sided quote","subtitle":"How your bid and ask move as inventory trades","icon":"σ²"}]
```
