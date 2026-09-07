`TremorMarketEngine` is the `Extruction` target for all three legs. It is where every executable price in Tremor comes from.

```solidity
function extrude(
    uint256 pc,
    bytes calldata args,        // immutable program arguments
    bytes calldata takerArgs,   // unused: v1 consumes no taker bytes
    SwapQuery calldata query,
    SwapRegisters memory swap,
    bool isStaticContext
) external returns (uint256 nextPC, uint256 takerArgsConsumed, SwapRegisters memory);
```

## The arguments select the leg

```text
[version:1][mode:1][seriesId:8]        10 bytes

version  1
mode     1 ISSUE · 2 EXIT · 3 SETTLE
```

Anything else reverts: an unknown version, a wrong length, a mode outside 1–3.

## What it validates before it prices

The engine is called by the router with an order it did not choose, so it re-derives everything rather than trusting the arguments:

| Check | Error |
|---|---|
| The order hash is registered for exactly this `(seriesId, leg)` | `OrderNotRegistered` |
| `order.maker` is that series' vault | `MakerNotVault` |
| Token direction matches the leg | `WrongDirection` |
| The registers have not already been priced by another instruction | `RecomputeDetected` |
| The market is current (ISSUE, EXIT) | `CheckpointsStale` |
| Issuance is open (ISSUE) | `IssuanceClosed` |
| Not finalized and before expiry (EXIT) | `ExitWindowClosed` |
| Finalized (SETTLE) | `NotFinalized` |
| The payout is non-zero (SETTLE) | `ZeroPayout` |

The order-hash check is the important one: it means a Tremor program cannot be lifted into somebody else's order and pointed at somebody else's vault.

## What each mode does

**ISSUE** — `USDC → receipts`. Exact-in and exact-out. Units are clamped by the inventory still shipped, by the cap, and by the vault's free collateral; the premium is the integral of the rising ask over the size that actually fills. On a swap it calls `onIssue`, which reserves collateral at the cap and raises the skew.

**EXIT** — `receipts → USDC`, exact-in only. Units are clamped by the units outstanding and by the point where the falling bid reaches zero; proceeds are additionally clamped by the collateral this burn releases and by the leg's Aqua balance. On a swap it calls `onExit`, which lowers the skew.

**SETTLE** — `receipts → USDC`, exact-in only, at the fixed `payoutPerUnit`. Clamped the same way.

The reservation itself is released by the **receipt**, not by the engine: the maker hook burns the units and calls `onBurn`, which is the single place a liability decreases. That is why the two burn legs can share one real balance.

## Quote and swap are the same arithmetic

There is exactly one difference between a quote and a swap, and it is guarded on SwapVM's `isStaticContext`: a swap writes state (the new skew, the new reservation) and a quote does not. The numbers are computed by identical code paths, so the price in a ticket and the price in a block cannot diverge within a block.

## Views for the app

```solidity
function market(uint256 seriesId)      returns (MarketQuote memory);
function quoteIssueExactIn(uint256 seriesId, uint256 amountIn)   returns (...);
function quoteIssueExactOut(uint256 seriesId, uint256 units)     returns (...);
function quoteExit(uint256 seriesId, uint256 units)              returns (...);
function quoteSettle(uint256 seriesId, uint256 units)            returns (...);
```

Each runs the same clamps as the corresponding fill, so a quote that returns a partial fill tells you so before you sign. `TremorLens` bundles `market()` into its per-series read; the trade tickets use the `quote*` views for the exact size in the box.
