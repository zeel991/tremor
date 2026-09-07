Every receipt Tremor sells is backed by USDC that the writer **cannot take back** while the receipt exists. This is the difference between v2 and the design it replaces: v1 measured a wallet the seller could empty at will and called the measurement "coverage". A number a counterparty can invalidate at any moment is not collateral.

## The vault

Each writer gets one `TremorMakerVault`, deployed with `CREATE2` at an address that is a pure function of the writer and the quote token. It has five immutables — owner, quote token, Aqua, router, controller — and nothing else.

| It has | It does not have |
|---|---|
| `deposit` (anyone can add) | An upgrade path or proxy |
| `withdrawFree` (owner, bounded) | An admin, owner-privileged rescue, or emergency custodian |
| Controller-only reserve, ship and dock | An arbitrary call, `delegatecall` or `execute` |
| A one-time `approve(aqua, max)` in the constructor | Any way to change that allowance |

The Aqua allowance is set in the constructor and there is no setter, anywhere, at any privilege level. Every state-changing function re-asserts `balance ≥ locked` before it returns.

## Reservations

`locked` is the sum, across every one of this writer's series, of the collateral reserved for units actually sold:

```text
maxLiability(units) = ceil(units · unitNotional · capVariance / 1e36)
```

That is the whole obligation — what the writer would owe if realized variance finished at or above the cap. It is computed from the **aggregate outstanding position**, not as a rounded per-unit figure times a count, so splitting one fill into a hundred cannot drift the reservation by even a base unit.

A sale increases `locked`. A burn — exit or redemption — decreases it. Nothing else moves it.

```text
free = balance − locked
```

`withdrawFree` reverts above `free`. There is no path, condition or caller for which that is not true.

## Finalization reprices the liability

Before finalization a unit is reserved at the cap, because the cap is the only bound that is known. Once the accumulator fixes the final variance, the real liability is known exactly:

```text
finalLiability(units) = ceil(units · payoutPerUnit / 1e18)
```

and the controller releases the difference back to `free`. A writer whose series finalizes at 30% vol against a 100% cap gets roughly 91% of the reservation back immediately, without waiting for a single holder to redeem.

## One reserve, two burn paths

Aqua balances are *virtual*: shipping registers what a maker is willing to have pulled, and the pull happens at swap time. EXIT and SETTLE are each shipped with a virtual USDC balance covering the whole capped liability, and both pull from **one real balance** — the vault's.

That is safe because a unit can leave through exactly one of them: both burn the receipt in the maker hook, and the engine bounds every payout by the liability that burn releases.

```text
released = lockedLiability(before) − maxLiability(outstanding − unitsFilled)
amountOut ≤ released
```

So the money a payout draws is always money that stopped being owed in the same transaction. A writer who buys their own receipts and redeems them moves USDC from the reserve to their wallet while the same amount stops being reserved — a round trip, not a withdrawal. `contracts/test/Adversarial.t.sol` tests this directly.

## What the Lens reports

```solidity
struct VaultState {
    address vault;
    address owner;
    uint256 balance;             // real USDC in the vault
    uint256 locked;              // reserved for units sold, writer-wide
    uint256 free;                // balance - locked
    uint256 aquaAllowance;       // vault -> Aqua
    bool    allowanceSufficient; // enough to cover locked
}
```

Per series the Lens also reports `lockedLiability` (this series' share) and a single boolean:

```text
fullyCollateralized = balance >= locked
                   && allowance is sufficient
                   && at least one burn leg is still shipped
```

The app never prints "fully collateralized" on anything weaker than all three. When one of them does not hold, the series page says which.

## What a writer can still do

Stop issuance, and close a series that has nothing outstanding. Stopping issuance closes new sales permanently and leaves EXIT and SETTLE untouched. Closing docks the strategies, burns the unsold inventory and frees the residual — and it reverts while a single receipt exists.

Docking is not exposed to writers at all. It is a controller action inside `closeSeries`, precisely so that "remove the leg that pays holders out" is not a button anybody has.
