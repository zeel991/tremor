## Status

| Status | Condition |
|---|---|
| `Upcoming` | `now < start` |
| `Live` | `start ≤ now < expiry` |
| `Finalizing` | `now ≥ expiry`, not yet finalized |
| `Finalized` | `finalize` has run: `finalVariance` and `payoutPerUnit` are fixed |
| `Closed` | Nothing outstanding, strategies docked, unsold inventory burned, residual collateral freed |

The Lens encodes status as `uint8` (`0 Upcoming, 1 Live, 2 ExpiredUnfinalized, 3 Finalized, 4 Closed`); the API uses lowercase strings. Status is only half the picture — what a user can actually do depends on the legs and on whether the market is current.

## Who can do what

| | Upcoming | Live, before `saleEnd` | Live, after `saleEnd` | Finalizing | Finalized | Closed |
|---|---|---|---|---|---|---|
| Buy | — | ✓ | — | — | — | — |
| Exit | — | ✓ | ✓ | — | — | — |
| Redeem | — | — | — | — | ✓ | — |
| Checkpoint | — | ✓ | ✓ | ✓ | — | — |
| Finalize | — | — | — | ✓ when complete | — | — |
| Stop issuance (writer) | ✓ | ✓ | — | — | — | — |
| Close (writer) | ✓ if nothing sold | ✓ if nothing outstanding | ✓ if nothing outstanding | ✓ if nothing outstanding | ✓ if nothing outstanding | — |

`stopIssuance` remains callable on chain after `saleEnd`, but by then the ISSUE leg is dead by its own `Deadline`, so it only docks an empty strategy — the app stops offering it once issuance is closed either way.

Buying and exiting additionally require the market to be **current** — every passed sample point stored. See [Checkpoints and finalization](/docs/mechanics/checkpoints).

The app derives the trade rail's tabs from exactly this table, so it never offers a button whose only possible outcome is a revert.

## Sequence

```text
WRITE     writer:  createVault (once) → approve USDC → deposit → createSeries
                   createSeries mints maxUnits to the vault and ships ISSUE, EXIT and SETTLE in one tx
BUY       buyer:   approve USDC to the router → router.swap(ISSUE order, USDC)
                   receipts out, premium into the vault, skew rises, collateral reserved at the cap
EXIT      holder:  approve receipts to the router → router.swap(EXIT order, units)
                   USDC out at the bid, receipts burned, skew falls, reservation released
UPDATE    anyone:  accumulator.checkpoint(id, 32)      repeat until stored == available
EXPIRE    saleEnd passes → ISSUE dead by Deadline; expiry passes → EXIT dead by Deadline
FINALIZE  anyone:  accumulator.finalize(id)
                   fixes finalVariance and payoutPerUnit; releases the cap surplus to the writer
REDEEM    holder:  router.swap(SETTLE order, units)
                   USDC out at payoutPerUnit, receipts burned, reservation released
CLOSE     writer:  factory.closeSeries(id)   only with nothing outstanding
```

## Who signs what

| Actor | Action | Call |
|---|---|---|
| Writer | create a vault | `factory.createVault()` — idempotent |
| Writer | fund it | `usdc.approve(vault)`, `vault.deposit(amount)` |
| Writer | open a market | `factory.createSeries(vault, params)` → `(id, receipt)` |
| Writer | withdraw unreserved collateral | `vault.withdrawFree(amount, recipient)` |
| Writer | close new sales | `factory.stopIssuance(id)` |
| Writer | wind a series up | `factory.closeSeries(id)` |
| Buyer | buy | `usdc.approve(router)`, `router.swap(issueOrder, amountIn, takerData)` |
| Holder | exit | `receipt.approve(router)`, `router.swap(exitOrder, units, takerData)` |
| Holder | redeem | `receipt.approve(router)`, `router.swap(settlementOrder, units, takerData)` |
| Holder | burn a worthless position | `factory.burnWorthless(id, units)` |
| Anyone | update the market | `accumulator.checkpoint(id, maxSamples)` |
| Anyone | fix the payout | `accumulator.finalize(id)` |

Note what is missing: nobody ships, nobody docks, nobody approves Aqua. All three are done by the controller and the vault, which is what makes the collateral guarantees hold.

## Where the UI reads it

Lists and live fields come from `TremorLens.states(from, to)` over RPC, chain-first. The backend adds fill history, the reconstructed quote path and vault event history. Both poll every 8–30 s, and every executable number on a ticket is re-quoted on chain immediately before the transaction is built.
