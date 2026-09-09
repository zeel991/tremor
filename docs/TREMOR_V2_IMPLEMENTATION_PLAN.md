# Tremor v2 — Covered Variance Market

## Complete implementation plan and acceptance specification

Status: implementation-ready design specification  
Repository: `/Users/zeeast/Desktop/tremor`  
Target product: ETH capped realized-variance receipts, quoted and exchanged through 1inch Aqua and SwapVM  
Primary chain for the judged demo: an Anvil fork of Base mainnet using canonical Aqua, Base USDC, and the Base Chainlink ETH/USD proxy  
Public deployment target: Base Sepolia only after the local-fork security and lifecycle gates pass  

This document replaces the current unsecured-writer design as the implementation target. It does not claim that the code already implements this design. Existing uncommitted repository changes must be preserved while this migration is performed.

---

## 1. Product decision

Tremor v2 is a two-sided, fully collateralized market for capped realized-variance receipts.

The product is not described as a conventional variance swap, futures contract, option, order book, guaranteed LVR hedge, or fair-value oracle. The exact product name is **capped realized-variance receipt**.

One receipt unit has 18 decimals and pays at finalization:

```text
payoutPerUnit = floor(unitNotional × min(finalRealizedVariance, capVariance) / 1e18)
```

`unitNotional` is denominated in six-decimal USDC. Variance is WAD-scaled. `1e18` variance corresponds to annualized variance 1.0 and annualized volatility 100%.

Every series exposes three Aqua/SwapVM legs:

```text
ISSUE   USDC    → receipt    before saleEnd
EXIT    receipt → USDC       before expiry
SETTLE  receipt → USDC       after finalization
```

All three legs use a non-upgradeable `TremorMakerVault` as the Aqua maker. The writer owns the vault but cannot move collateral reserved for outstanding receipts, reduce Aqua approvals, transfer unsold receipt inventory, execute arbitrary calls, or dock EXIT/SETTLE while claims remain.

The EXIT and SETTLE legs deliberately share the same real USDC reserve. This is safe because either leg burns the receipt it consumes. One receipt can exit before expiry or settle after expiry, never both.

---

## 2. Problems this design must solve

The implementation is incomplete unless all of these statements are true and tested:

1. A writer cannot make an already-sold receipt unpayable by moving USDC.
2. A writer cannot revoke or reduce the vault's Aqua allowance.
3. A writer cannot dock EXIT or SETTLE while any receipt is outstanding.
4. Collateral is reserved only for sold units, not unsold capacity.
5. A holder has an executable pre-expiry exit bid, not a UI-only payout indication.
6. A holder can settle after finalization without writer cooperation.
7. Finalization remains permissionless if no backend or keeper is running.
8. No single settlement transaction must scan the entire observation window.
9. Pricing terminology does not represent a bonding-curve quote as conventional options-implied volatility.
10. Aqua is essential: ISSUE, EXIT, and SETTLE are independently shipped strategies sharing one maker balance.
11. The canonical/unmodified SwapVM instruction set is used when deployment compatibility permits it.
12. The UI never claims an order book, peer secondary market, fair value, perfect hedge, or escrow by Aqua.

---

## 3. Actors and trust model

### 3.1 Writer

The writer owns a `TremorMakerVault` and selects immutable market parameters within factory bounds. The writer deposits USDC, receives free premiums, may stop future issuance, and may withdraw only free collateral.

The writer is not trusted for settlement availability.

### 3.2 Buyer or holder

The buyer pays the executable ISSUE ask and receives ERC-20 receipts. A holder may transfer receipts, execute the EXIT bid before expiry, or execute SETTLE after finalization.

### 3.3 Tremor contracts

Contracts enforce collateral reservations, official order hashes, pricing, receipt burns, oracle accumulation, finalization, and withdrawal limits. Contracts are immutable and non-upgradeable for the submission.

### 3.4 Aqua

Aqua stores virtual strategy balances and performs `pull`/`push` token transfers. Aqua does not custody the collateral. The collateral is held by `TremorMakerVault`, which is the maker and grants Aqua an immutable maximum allowance through restricted vault code.

### 3.5 Chainlink

The configured ETH/USD proxy is the only settlement price source. Sample selection remains “latest valid round with `updatedAt <= sampleTime`.” Phase-aware search, answer validation, timestamp validation, and `answeredInRound` validation remain mandatory.

### 3.6 Backend and checkpoint caller

The backend may submit checkpoint transactions in a demo environment, but it has no privileged settlement authority. Any account can checkpoint or finalize. If the backend disappears, another caller can complete the same state transitions.

### 3.7 Explicit residual risks

The final product still has smart-contract risk, USDC issuer risk, Chainlink availability risk, pricing-model risk, liquidity/quote risk, and LVR basis risk. It must not retain unilateral writer-default risk.

---

## 4. Fixed scope and non-goals

### 4.1 Submission scope

- Underlying reference: ETH/USD.
- Settlement token: USDC with six decimals.
- Development execution: Base-mainnet fork.
- Public execution: Base Sepolia after all gates pass.
- One vault per `(writer, quoteToken)`.
- One receipt token per series.
- ISSUE supports exact-in and exact-out.
- EXIT supports exact-in receipt units only.
- SETTLE supports exact-in receipt units only.
- Receipt transfers remain standard ERC-20 transfers.
- No governance, proxy, upgrade admin, emergency custodian, or discretionary settlement override.

### 4.2 Non-goals

- No central limit order book.
- No matching engine.
- No peer-to-peer bid placement.
- No leverage or borrowing.
- No liquidations.
- No yield-bearing collateral.
- No multiple collateral tokens.
- No alternative price feeds.
- No cross-chain receipts.
- No claim-expiry or holder forfeiture.
- No claim of exact LVR replication.
- No Pathfinder integration claim unless independently demonstrated.

---

## 5. Units, arithmetic, and rounding

### 5.1 Units

```text
WAD                 = 1e18
receipt unit        = 1e18 receipt base units
USDC                = 1e6 base units
variance            = WAD
volatility          = sqrtWad(variance), displayed as a percentage
time                = Unix seconds
```

### 5.2 Realized variance

Keep the existing definition:

```text
t_i = start + i × sampleInterval
P_i = latest valid Chainlink answer with updatedAt <= t_i
r_i = lnWad(P_i × 1e18 / P_(i-1))
sumSquaredReturns += r_i × r_i / 1e18
RV = sumSquaredReturns × 31_536_000 / (expiry - start)
```

Every multiplication that can overflow uses `Math.mulDiv` or an equivalent full-precision operation. Existing reference vectors remain authoritative.

### 5.3 Maximum liability

Do not reserve a rounded per-unit amount and multiply it. Compute liability from aggregate outstanding units:

```text
maxLiability(outstandingUnits) =
    ceil(outstandingUnits × unitNotional × capVariance / 1e36)
```

After finalization:

```text
finalLiability(outstandingUnits) =
    ceil(outstandingUnits × payoutPerUnit / 1e18)
```

The reservation delta for issuance or burn is the difference between the old and new aggregate liability. This avoids fill-splitting rounding drift.

### 5.4 Final payout

```text
cappedVariance = min(finalRealizedVariance, capVariance)
payoutPerUnit = floor(unitNotional × cappedVariance / 1e18)
payout(units) = floor(units × payoutPerUnit / 1e18)
```

### 5.5 Market projection

For the latest fully checkpointed sample:

```text
duration  = expiry - start
elapsed   = processedThrough - start
remaining = expiry - processedThrough

projectedVariance =
    (realizedVarianceSoFar × elapsed + forwardVariance × remaining) / duration
```

Before `start`, `elapsed = 0` and `projectedVariance = forwardVariance`. At expiry, `remaining = 0` and projection converges to final realized variance.

### 5.6 Forward quote state

Each series stores:

```text
anchorVariance      uint64
signedSkew          int192
lastSkewTimestamp   uint64
impactPerUnit       uint64
halfLife            uint32
halfSpreadBps       uint16
```

The skew decays toward zero:

```text
decayedSkew = signedSkew × 2^(-(now - lastSkewTimestamp) / halfLife)
forwardVariance = clamp(anchorVariance + decayedSkew, 0, capVariance)
```

If `halfLife == 0`, skew does not decay.

ISSUE increases skew by:

```text
impactPerUnit × issuedUnits / 1e18
```

EXIT decreases skew by:

```text
impactPerUnit × exitedUnits / 1e18
```

The resulting signed skew must be bounded so `anchorVariance + skew` remains representable. Clamp only at defined zero/cap pricing boundaries; do not silently overflow.

### 5.7 Bid and ask

```text
baseAskVariance = ceil(projectedVariance × (10_000 + halfSpreadBps) / 10_000)
baseBidVariance = floor(projectedVariance × (10_000 - halfSpreadBps) / 10_000)
```

The ISSUE fill integrates positive inventory impact over the requested units. The EXIT fill integrates negative inventory impact. Existing maker-favouring rounding remains:

- ISSUE exact-in: receipt units round down.
- ISSUE exact-out: USDC payment rounds up.
- EXIT exact-in: USDC output rounds down.
- SETTLE exact-in: USDC output rounds down.

Mandatory price bounds:

```text
0 <= executableBid <= executableAsk
executableBidPerUnit <= maxPayoutPerUnit
executableAskVariance <= capVariance unless UI explicitly permits paying above maximum payout
```

For the submission, disallow an ask above maximum payout. A quote producing an ask above the cap clamps at the cap; if inventory impact would make marginal ask exceed cap, partially fill only the units that remain within the cap.

### 5.8 Parameter bounds

Factory validation uses these submission bounds:

```text
sampleInterval       >= 300 seconds
samples              >= 2 and <= 256
saleEnd               >= block.timestamp and <= expiry
start                 <= saleEnd
unitNotional          > 0
capVariance           > 0 and <= 4e18
anchorVariance        > 0 and <= capVariance
impactPerUnit         <= capVariance
halfSpreadBps         >= 10 and <= 2_000
halfLife              == 0 or between 300 seconds and 30 days
maxUnits              > 0
```

The factory accepts only its immutable quote token and feed in the submission build.

---

## 6. Lifecycle and state machine

### 6.1 Series states

```text
UPCOMING             now < start
LIVE                 start <= now < expiry
EXPIRED_UNFINALIZED  now >= expiry and final variance not stored
FINALIZED            final variance stored and outstandingUnits > 0
CLOSED               outstandingUnits == 0 and issuance permanently stopped
```

Independent booleans:

```text
issuanceOpen = !issuanceStopped && now <= saleEnd && inventory > 0
exitOpen     = now < expiry && outstandingUnits > 0
settleOpen   = finalized && outstandingUnits > 0
```

EXIT and SETTLE can never be open simultaneously.

### 6.2 Vault creation

1. Writer calls `VarianceSeriesFactory.createVault()`.
2. The series factory deploys a deterministic non-upgradeable vault using CREATE2 salt `keccak256(writer, quoteToken)`.
3. Duplicate creation returns or reverts with the existing vault address; choose one behavior and test it. The implementation decision is to return the existing vault without deploying again.
4. Vault stores immutable `OWNER`, `QUOTE_TOKEN`, `AQUA`, `ROUTER`, and `CONTROLLER`.
5. Vault grants Aqua `type(uint256).max` USDC allowance in its constructor.
6. Vault exposes no method that can lower or replace this allowance.

### 6.3 Deposit

1. Any address may call `deposit(amount)` to fund the vault for the writer.
2. Vault transfers USDC from `msg.sender` to itself.
3. Emit `Deposited(payer, amount, newBalance, lockedBalance)`.
4. Zero amount reverts.

### 6.4 Series creation

1. Writer calls `VarianceSeriesFactory.createSeries(vault, params)`.
2. Factory verifies `vault.OWNER() == msg.sender`, official vault registration, quote token, feed, parameter bounds, and dependency code.
3. Factory allocates `seriesId`.
4. Factory deploys `VarianceReceipt`, minting `maxUnits` to the vault.
5. Factory builds ISSUE, EXIT, and SETTLE orders with maker equal to the vault.
6. Factory records all three hashes and maps each hash to `(seriesId, leg)`.
7. Factory asks the vault to approve the receipt to Aqua.
8. Factory asks the vault to ship all three strategies.
9. ISSUE ships receipt virtual balance `maxUnits` and USDC virtual balance zero.
10. EXIT ships USDC virtual balance equal to the maximum liability for `maxUnits` and receipt virtual balance zero.
11. SETTLE ships the same USDC virtual balance and receipt virtual balance zero.
12. No USDC is reserved merely because the maximum virtual EXIT/SETTLE balances were shipped.
13. Emit one `SeriesCreated` event containing writer, vault, receipt, all hashes, and all parameters.

The oversized EXIT and SETTLE virtual balances are deliberate. The engine constrains executable output by outstanding receipt liability and the vault constrains real withdrawals. Unsold receipts cannot be extracted from the vault, so unreserved virtual output cannot be consumed.

### 6.5 ISSUE

1. Require `issuanceOpen`.
2. Require oracle accumulator current through the latest required sample if the series has started.
3. Calculate projected variance and executable ask.
4. Calculate units/output using integral pricing and clamp to Aqua receipt inventory, cap-priced inventory, and vault free-collateral capacity.
5. In static quote mode, return amounts without state changes.
6. In swap mode, update quote skew and call controller `onIssue(seriesId, units)` before transfers.
7. Controller recomputes aggregate liability using new outstanding units.
8. Controller calls vault `increaseLocked(delta)`.
9. If any later Aqua transfer fails, all state changes revert atomically.
10. Aqua pulls receipts from vault to buyer and pushes USDC from buyer to vault.
11. Emit `Issued(seriesId, buyer, units, premium, newOutstanding, newLocked)`.

Premium received is not required to make the just-completed issuance solvent; collateral capacity is checked before counting incoming premium.

### 6.6 EXIT

1. Require `exitOpen`.
2. Require current checkpoints.
3. Accept exact-in receipt units only.
4. Require requested units do not exceed holder balance or outstanding units.
5. Calculate projected variance and executable bid using integral negative inventory impact.
6. Clamp USDC output below both Aqua virtual balance and liability released by burning the units.
7. In static mode, return amounts without state changes.
8. In swap mode, update quote skew.
9. Aqua pulls USDC from vault to holder.
10. Aqua pushes receipts from holder to vault.
11. Receipt post-transfer hook burns the net received units.
12. Receipt calls controller `onBurn(orderHash, units, amountOut)`.
13. Controller validates that the hash is the official EXIT order, decrements outstanding units, recomputes liability, and unlocks the liability delta.
14. Require `amountOut <= unlocked liability delta`.
15. Emit `Exited(seriesId, holder, units, amountOut, newOutstanding, newLocked)`.

Any hook or accounting failure reverts the complete Aqua swap, including the earlier USDC transfer.

### 6.7 Checkpointing

1. Anyone calls `VarianceAccumulator.checkpoint(seriesId, maxSamples)`.
2. Require `1 <= maxSamples <= 32`.
3. Determine the latest sample time not greater than `min(block.timestamp, expiry)`.
4. Process from the next missing sample through at most `maxSamples` new samples.
5. For the initial sample, store price and round ID without adding a return.
6. For each later sample, find and validate the latest Chainlink round at or before the sample time, calculate log return, and add its square.
7. Persist `processedSamples`, `processedThrough`, `lastPrice`, `lastRoundId`, and `sumSquaredReturns`.
8. Emit one bounded `Checkpointed` event summarizing the range; do not emit every raw sample unless gas measurement approves it.
9. Repeated calls with no new sample return without mutation or revert with `NothingToCheckpoint`; implementation decision: return current state without mutation for idempotent automation.

### 6.8 Finalization

1. Anyone calls `finalize(seriesId)` after expiry.
2. Require every sample through expiry has been checkpointed.
3. Compute final annualized variance from stored sum.
4. Compute payout per unit.
5. Store immutable final variance and payout.
6. Recompute locked liability from maximum payout to actual payout for outstanding units.
7. Unlock the difference immediately.
8. Emit `Finalized(seriesId, finalVariance, cappedVariance, payoutPerUnit, outstandingUnits, releasedCollateral)`.
9. Repeated finalization reverts with `AlreadyFinalized`.

### 6.9 SETTLE

1. Require `finalized`.
2. Accept exact-in receipt units only.
3. Calculate `amountOut = floor(units × payoutPerUnit / 1e18)`.
4. If payout per unit is zero, allow receipts to be burned for zero output through an explicit `burnWorthless` controller function; do not route zero-output settlement through SwapVM if router traits reject it.
5. For positive payout, Aqua pulls USDC from vault and pushes receipts into the vault.
6. Receipt hook burns units and calls controller.
7. Controller validates official SETTLE hash, decrements outstanding, recomputes final liability, and unlocks the delta.
8. Require `amountOut <= unlocked liability delta` allowing only defined rounding dust.
9. Emit `Settled(seriesId, holder, units, amountOut, newOutstanding, newLocked)`.

### 6.10 Stop issuance and close

1. Writer may call `stopIssuance(seriesId)` at any time.
2. Controller permanently marks issuance stopped.
3. Vault docks only the ISSUE strategy.
4. EXIT and SETTLE remain active while outstanding units exist.
5. After `outstandingUnits == 0`, anyone may call `closeSeries`.
6. Controller asks vault to dock remaining active strategies and unlocks any rounding residual.
7. Unsold receipts may be burned by the controller during close.
8. Emit `SeriesClosed`.

---

## 7. Contract architecture

### 7.1 Vault factory responsibility — integrated into `VarianceSeriesFactory.sol`

Responsibilities:

- Deterministic official-vault deployment from the existing series factory.
- Registry `vaultOf[writer]`; the submission factory has one immutable quote token.
- `isVault[address]` verification.
- No owner or privileged mutation.

Public interface:

```solidity
function createVault() external returns (address vault);
function predictVault(address writer) external view returns (address);
function vaultOf(address writer) external view returns (address);
function isVault(address vault) external view returns (bool);
```

Events:

```solidity
event VaultCreated(address indexed writer, address indexed quoteToken, address vault);
```

Do not add a separate `TremorVaultFactory` contract. Keeping vault deployment and series registration in one immutable factory removes an unnecessary cross-contract trust edge.

### 7.2 `TremorMakerVault.sol` — new

Immutable fields:

```solidity
address OWNER;
IERC20 QUOTE_TOKEN;
IAqua AQUA;
address ROUTER;
address CONTROLLER;
```

State:

```solidity
uint256 lockedQuote;
mapping(address receipt => bool protected) protectedReceipts;
```

Required methods:

```solidity
function deposit(uint256 amount) external;
function withdrawFree(uint256 amount, address recipient) external;
function freeQuote() external view returns (uint256);
function increaseLocked(uint256 amount) external;
function decreaseLocked(uint256 amount) external;
function registerAndApproveReceipt(address receipt) external;
function shipStrategy(bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
    external returns (bytes32);
function dockStrategy(bytes32 strategyHash, address[] calldata tokens) external;
```

Authorization:

- `withdrawFree`: OWNER only.
- `increaseLocked`, `decreaseLocked`, receipt registration, shipping, docking: CONTROLLER only.
- No generic `execute`, arbitrary approval, delegatecall, selfdestruct, upgrade, owner change, or rescue of quote/protected receipt tokens.

Every lock change and withdrawal checks `QUOTE_TOKEN.balanceOf(vault) >= lockedQuote`.

### 7.3 `VarianceSeriesFactory.sol` — refactor into controller/factory

Replace seller-as-maker assumptions with separate `writer` and `vault` fields.

Series state:

```solidity
struct Series {
    address writer;
    address vault;
    address receipt;
    bytes32 issueOrderHash;
    bytes32 exitOrderHash;
    bytes32 settlementOrderHash;
    SeriesParams params;
    uint256 outstandingUnits;
    uint256 lockedLiability;
    bool issuanceStopped;
    bool finalized;
    uint256 finalVariance;
    uint256 payoutPerUnit;
}
```

Order registry:

```solidity
enum Leg { NONE, ISSUE, EXIT, SETTLE }
struct OrderRef { uint256 seriesId; Leg leg; }
mapping(bytes32 => OrderRef) orderRef;
```

Only the official engine can call issuance accounting. Only the official receipt can call burn accounting. Validate both order hash and leg on every callback.

Delete the old seller-wallet `aggregateReserved`, allowance coverage, and reservation-release model after migration tests are replaced. Aggregate locked backing lives in each vault and per-series locked liability remains in the controller.

### 7.4 `SeriesParams.sol` — update

Replace:

```text
baseVariance
bumpPerUnit
```

with:

```text
anchorVariance
impactPerUnit
halfSpreadBps
```

Keep feed and quote token in the struct only if ABI clarity is worth the duplication; factory must require they equal immutable configured addresses.

Final proposed struct:

```solidity
struct SeriesParams {
    address feed;
    address quoteToken;
    uint40 start;
    uint40 expiry;
    uint40 saleEnd;
    uint32 sampleInterval;
    uint128 unitNotional;
    uint64 capVariance;
    uint64 anchorVariance;
    uint64 impactPerUnit;
    uint32 halfLife;
    uint16 halfSpreadBps;
    uint128 maxUnits;
}
```

### 7.5 `TremorMarketEngine.sol` — new

Implement the official SwapVM `IExtruction` interface. One target handles three modes encoded in immutable order arguments.

Arguments:

```text
version   uint8  = 1
mode      uint8  = 1 ISSUE, 2 EXIT, 3 SETTLE
seriesId  uint64
```

The engine must:

- Verify `query.orderHash` maps to the same series and mode.
- Verify `query.maker` equals series vault.
- Verify token direction.
- Read only official series/controller state.
- Implement static and swap behavior with identical arithmetic.
- Write skew/reservation state only when `isStaticContext == false`.
- Consume zero taker argument bytes in v1.
- Return the incoming `nextPC` unchanged.
- Reject exact-out EXIT and SETTLE.
- Clamp against Aqua balances, receipt inventory, outstanding units, cap, and vault collateral.

Do not make the engine upgradeable. Do not add an owner.

### 7.6 `VarianceAccumulator.sol` — replace or extend current oracle

Move series-specific accumulated history here. Retain general trailing-variance cache only for the LVR and adaptive-spread feature.

Series accumulator state:

```solidity
struct Accumulator {
    uint16 processedSamples;
    uint40 processedThrough;
    uint80 lastRoundId;
    uint256 lastPriceWad;
    uint256 sumSquaredReturnsWad;
}
```

The accumulator reads series parameters from the controller to prevent caller-supplied feed/window substitution.

### 7.7 `VarianceReceipt.sol` — update

- Mint `maxUnits` to vault.
- Store immutable CONTROLLER in addition to ROUTER and SERIES_ID.
- Burn only from the official maker vault in a post-transfer-in hook.
- Use `orderHash` to distinguish EXIT and SETTLE through controller validation.
- Pass burned units and `amountOut` to controller after burn.
- Require `feeIn == 0` for v1, or explicitly account for net receipt input. Submission decision: require zero receipt-side fee and burn `amountIn`.
- Add controller-only burn of unsold inventory during final close.
- Add holder-callable `burnWorthless` through controller when finalized payout is zero.

### 7.8 `TremorOrderBuilder.sol` — replace two-leg builder

Build three Aqua orders against the configured official router using built-in `Salt`, `Deadline`, and `Extruction` instructions.

- ISSUE has deadline `saleEnd` and no receipt burn hook.
- EXIT has deadline `expiry` and receipt post-transfer hook.
- SETTLE has no deadline and receipt post-transfer hook.
- Every order maker is vault.
- Every order receiver remains maker/default.
- Use Aqua mode.
- Include unique series salt and mode in the program so hashes cannot collide.

Expose:

```solidity
function issueOrder(
    SeriesParams memory params,
    uint256 seriesId,
    address receipt,
    address vault,
    address engine
) internal pure returns (ISwapVM.Order memory);

function exitOrder(
    SeriesParams memory params,
    uint256 seriesId,
    address receipt,
    address vault,
    address engine
) internal pure returns (ISwapVM.Order memory);

function settlementOrder(
    SeriesParams memory params,
    uint256 seriesId,
    address receipt,
    address vault,
    address engine
) internal pure returns (ISwapVM.Order memory);

function shipBytes(ISwapVM.Order memory order) internal pure returns (bytes memory);
function orderHash(ISwapVM.Order memory order) internal pure returns (bytes32);
function sortedTokens(address quoteToken, address receipt) internal pure returns (address[] memory);
```

### 7.9 `TremorLens.sol` — refactor read model

Replace coverage fields with enforceable vault fields:

```solidity
struct VaultState {
    uint256 balance;
    uint256 locked;
    uint256 free;
    uint256 aquaAllowance;
    bool allowanceSufficient;
}
```

Series state must include:

```text
writer, vault, receipt
three order hashes
status and open-leg booleans
marketVariance
projectedVariance
bidPerUnit
askPerUnit
unitsOutstanding
unitsAvailable
maxPayoutPerUnit
finalVariance
payoutPerUnit
checkpoint progress
locked liability
vault state
```

Quote methods:

```solidity
quoteIssueExactIn(seriesId, usdcIn)
quoteIssueExactOut(seriesId, units)
quoteExitExactIn(seriesId, units)
quoteSettleExactIn(seriesId, units)
```

Direction helpers use `Leg`, not a boolean premium/settlement flag.

### 7.10 Existing contracts to retire from the production path

After parity tests pass, remove production dependencies on:

- `TremorRouter.sol`
- `TremorOpcodes.sol`
- `ImpliedVarianceQuote.sol`
- `RequireBacked.sol`
- `VarianceSettle.sol`

Their logic moves into `TremorMarketEngine` and controller/accumulator modules. `VarianceSpread` may remain as a separate custom-router research implementation only if the main deployment still needs that router. Preferred production path: implement adaptive spread through official `Extruction` as a separate immutable target or a fourth engine mode.

Do not claim custom opcodes after migrating to built-in `Extruction`. Claim custom SwapVM programs and external pricing/settlement logic.

---

## 8. Router compatibility gate

The production preference is the canonical AquaSwapVM router with built-in `Extruction`. Chain deployments can differ, so implementation must perform this gate before deleting the custom router path.

### Gate procedure

1. Add a minimal `ExtructionEcho` contract returning deterministic swap registers.
2. On the Base-mainnet fork, use the configured canonical router address.
3. Verify router bytecode exists.
4. Ship a two-token Aqua strategy from a test vault containing `ExtructionEcho`.
5. Call router quote and swap.
6. Assert quote/swap equality and real Aqua `pull`/`push` transfers.
7. Assert maker hook support with the receipt hook selector.

### Gate result

- If all checks pass, canonical router is mandatory for Tremor v2.
- If opcode or hook support fails, deploy the unmodified official `AquaSwapVMRouter` source pinned in the repository and repeat the test.
- Do not return to the custom-opcode router merely to avoid adapting the engine.
- Record router address, source commit, bytecode hash, and gate result in deployment metadata.

---

## 9. Backend migration

### 9.1 Event model

Index these new events:

```text
VaultCreated
Deposited
FreeWithdrawn
SeriesCreated
IssuanceStopped
Checkpointed
Finalized
Issued
Exited
Settled
SeriesClosed
Aqua Shipped/Docked/Pulled/Pushed
SwapVM Swapped
ERC20 Transfer for receipt ownership reconstruction if required
```

Router `Swapped` events map order hash to ISSUE, EXIT, or SETTLE.

### 9.2 Database schema

Create a new schema version. Development databases may be reset only through an explicit migration command; startup must not silently destroy them.

Tables:

```text
vaults
series
orders
fills
checkpoints
finalizations
vault_events
aqua_events
rounds
phases
round_coverage
cursor
schema_meta
```

`fills.leg` becomes `issue | exit | settle`. Store `amount_in`, `amount_out`, `units`, `price_per_unit`, `taker`, `maker_vault`, transaction identity, and timestamp.

### 9.3 API

Required endpoints:

```text
GET /health
GET /config
GET /vault/:address
GET /series
GET /series/:id
GET /series/:id/fills
GET /series/:id/variance
GET /series/:id/market
GET /series/:id/quote?issue_usdc=&issue_units=&exit_units=&settle_units=
GET /series/:id/aqua
GET /feed/history
GET /variance/trailing
GET /lvr
```

`/series/:id/market` returns time-series points containing timestamp, realized variance/volatility, market/projected variance/volatility, bid, ask, and checkpoint freshness.

All large integers remain decimal strings. Floats remain display-only convenience values.

### 9.4 Automation

The backend may expose an optional checkpoint worker enabled by environment configuration. It must:

- Use a separate explicitly provided demo key, never an embedded key.
- Submit only permissionless checkpoint/finalize calls.
- Stop and report errors rather than skipping samples.
- Be unnecessary for correctness.
- Be disabled by default in production documentation unless key management is configured.

### 9.5 Backend tests

- Decode all new event signatures.
- Rebuild order-hash mapping after restart.
- Handle all three fill legs separately.
- Preserve cursor reorg/reset logic.
- Match Solidity projected-variance and bid/ask vectors exactly within integer representation.
- Match accumulator/final variance vectors.
- Reject stale or mismatched manifests.
- Bound query pagination and concurrency.
- Return oracle-unavailable separately from zero variance.

---

## 10. Subgraph migration

Update `subgraph/schema.graphql`, mappings, templates, ABIs, and manifest.

Entities:

```text
Vault
Series
Order
Fill
Checkpoint
Finalization
VaultAction
ReceiptBalance
```

The subgraph is supplemental discovery/history. Contract reads through Lens remain authoritative for executable quotes, locked collateral, final payout, and current balances.

Codegen and build must pass. Do not commit generated `node_modules`. Confirm `.gitignore` excludes it.

---

## 11. Frontend migration

### 11.1 Terminology

Replace globally:

```text
variance swap             → capped variance receipt or variance market
seller                    → writer, except low-level maker fields
implied volatility        → market quote volatility
premium leg               → issue leg
accrued payout indication → executable exit value when EXIT is open
coverage                  → locked collateral
settle                    → redeem at final variance
```

Do not display “fully collateralized” unless Lens confirms `vault.balance >= vault.locked`, allowance is sufficient, and the required Aqua strategies remain active.

### 11.2 Markets page

Columns:

```text
Series
Status
Expiry
Realized vol
Market vol
Bid
Ask
Available units
Locked backing
Action
```

Filters: Upcoming, Live, Finalizing, Finalized, Closed, Issuance open.

### 11.3 Individual series page

Default visible hierarchy:

1. Compact market header.
2. Stock-style volatility time-series chart.
3. Connected-wallet position summary.
4. Dark trade rail with Buy, Exit, or Redeem.
5. One-line locked-collateral state.
6. Compact user-facing settlement explanation.
7. Collapsed advanced details.

Primary chart:

- X-axis time.
- Y-axis annualized volatility percentage.
- Solid realized-volatility line.
- Dashed market-quote-volatility line.
- Optional bid/ask band rendered without a gradient.
- Start, current checkpoint, sale end, and expiry markers.
- Range controls constrained to available series history.
- Crosshair tooltip with timestamp, realized vol, market vol, bid, ask, and checkpoint status.
- Payoff and oracle-price charts remain secondary tabs.

### 11.4 Position summary

For a connected holder:

```text
units held
average indexed entry price
total indexed cost
executable exit bid before expiry
exit proceeds
unrealized P&L based on executable bid
final redemption value after finalization
maximum payout
```

Average entry based only on indexed wallet buys is labeled “indexed average entry.” Transfers into the wallet make cost basis unknown; show `—` rather than inventing it.

### 11.5 Trade rail

Tabs are lifecycle-aware:

- Before sale end: Buy and Exit.
- After sale end but before expiry: Exit only.
- Expired but incomplete checkpoints: Update market / Finalize progress.
- Finalized: Redeem.
- Closed or no balance: informational state.

Buy shows executable ask, units, maximum payout, slippage, and locked-backing confirmation.

Exit shows executable bid, units, proceeds, indexed P&L when known, slippage, and receipt burn disclosure.

Redeem shows final variance, payout per unit, units, and exact USDC output.

### 11.6 Writer page

Replace the current five-step EOA shipping flow with:

1. Create or load maker vault.
2. Deposit chosen USDC capacity.
3. Choose series terms.
4. Create series and ship all strategies through vault.
5. Confirm market open.

Show vault balance, locked, free, outstanding maximum liability, and withdrawable premiums.

### 11.7 Portfolio

Holder table separates live exit value from final redemption value.

Writer table shows vault-level balance/locked/free plus per-series outstanding units and liability. Writer controls are Deposit, Withdraw free, Stop issuance, and Close eligible series. No direct docking or approval control appears.

### 11.8 Advanced details

Move addresses, order hashes, raw programs, Aqua events, checkpoints, Chainlink round IDs, immutable parameters, and complete fills under Advanced details. Keep them available for judges without forcing ordinary users through protocol internals.

### 11.9 Frontend transaction changes

Add flows:

```text
CREATE_VAULT
DEPOSIT
CREATE_SERIES
BUY
EXIT
CHECKPOINT
FINALIZE
REDEEM
STOP_ISSUANCE
WITHDRAW_FREE
CLOSE_SERIES
BURN_WORTHLESS
```

Every flow uses simulate, wallet confirmation, receipt wait, explicit failure state, and query invalidation. Existing persisted write checkpoints must be versioned so v1 checkpoints cannot resume against v2 addresses.

---

## 12. File-by-file migration map

### Root and documentation

- `AGENTS.md`: replace v1 product paragraph, repository map, invariants, commands, and demo facts.
- `README.md`: rewrite product definition, three legs, vault safety, pricing language, run instructions, status, and caveats.
- `ARCHITECTURE.md`: replace two-leg architecture with this binding specification after code matches.
- `DESIGN.md`: retain visual tokens; update market-page hierarchy and Buy/Exit/Redeem terminology.
- `CLAUDE.md`: point agents to this plan during migration, then back to updated architecture.
- `docs/TASKS.md`: track migration gates and external deployment actions.
- `docs/DEMO_SCRIPT.md`: replace the observable-solvency demo with malicious-writer reverts and successful exit/settlement.
- `docs/architecture.md`: update diagrams.
- `Makefile`: add checkpoint/finalization demo targets if scripts require them.
- `scripts/dev.sh`: start the new contracts/backend/web without stale manifests.

### Contracts

- Add `contracts/src/TremorMakerVault.sol`.
- Add `contracts/src/TremorMarketEngine.sol`.
- Add `contracts/src/VarianceAccumulator.sol`.
- Add interfaces for vault, controller, accumulator, and official extruction target.
- Refactor `contracts/src/VarianceSeriesFactory.sol`.
- Refactor `contracts/src/TremorLens.sol`.
- Refactor `contracts/src/libs/SeriesParams.sol`.
- Refactor `contracts/src/libs/TremorOrderBuilder.sol`.
- Refactor `contracts/src/tokens/VarianceReceipt.sol`.
- Reuse phase-aware functionality from `contracts/src/libs/RealizedVariance.sol`.
- Decide `RealizedVarianceOracle.sol` scope: trailing variance only.
- Retire custom router/opcode files from deployment after official-router gate passes.
- Update mocks only where new interfaces require it.
- Rewrite deployment, demo, ABI export, and manifest sync scripts.
- Update `contracts/CONTRACTS.md` only after observed tests match.

### Contract tests

- Replace `PremiumLeg.t.sol` with `IssueLeg.t.sol`.
- Add `ExitLeg.t.sol`.
- Replace `SettlementLeg.t.sol` for finalized settlement.
- Add `MakerVault.t.sol`.
- Add `VarianceAccumulator.t.sol`.
- Add `MarketPricing.t.sol`.
- Rewrite `Adversarial.t.sol`.
- Rewrite `Invariants.t.sol`.
- Rewrite `ShipRoundTrip.t.sol` for three official-router programs.
- Update `ForkE2E.t.sol`.
- Update `VarianceSpread.t.sol` if retained.
- Update `test/base/TremorTestBase.sol` for vault and three-leg helpers.
- Add reference vectors for projected variance, decay, bid/ask integration, and reservation rounding.

### Backend

- Update contract bindings and build-time ABI selection.
- Update config/deployment manifest validation.
- Migrate database schema and indexer leg mapping.
- Add market-pricing replica or consume Lens values; Lens remains executable authority.
- Add vault, market, and checkpoint APIs.
- Update health/readiness for new contracts and router identity.
- Update README and environment example.

### Web

- Update ABI files and contract address configuration.
- Replace normalized series and coverage models.
- Update chain reads, hooks, API schemas, and transaction flows.
- Add Exit ticket and checkpoint/finalization controls.
- Replace observable coverage UI with locked collateral state.
- Keep volatility chart primary and payoff chart secondary.
- Update markets, series, writer, portfolio, hedge, landing, and documentation copy.
- Preserve the binding visual system unless a component no longer fits the simplified hierarchy.

### Subgraph and simulation

- Update subgraph schema, ABIs, mappings, manifest, network configuration, codegen, and README.
- Replace the old default/recycle simulation with vault solvency, mutually exclusive exit/settlement, pricing, and writer P&L simulations.
- Produce a new report containing parameter sweeps and invariant summaries.

---

## 13. Contract test matrix

### 13.1 Vault unit tests

- Deterministic deployment and duplicate call behavior.
- Correct immutable writer, token, Aqua, router, and controller.
- Deposit accounting.
- Owner-only withdrawal.
- Withdrawal exactly equal to free balance succeeds.
- Withdrawal one unit above free balance reverts.
- Non-owner withdrawal reverts.
- Controller-only lock/unlock/ship/dock/receipt registration.
- Aqua allowance is maximum and cannot be changed by owner.
- Protected receipt cannot be rescued.
- No arbitrary call surface.
- Reentrancy attempts through malicious token fail; submission deployment still restricts token to USDC.

### 13.2 Series creation tests

- Parameter bounds individually.
- Unsupported feed/token rejection.
- Unofficial vault rejection.
- Wrong writer rejection.
- Receipt minted only to vault.
- Three distinct order hashes.
- Correct makers and token directions.
- Correct Aqua virtual balances.
- No collateral locked before a sale.

### 13.3 ISSUE tests

- Exact-in and exact-out.
- Quote/swap equality in same block/state.
- Integral pricing prevents split-fill savings.
- Inventory clamp.
- Cap-price clamp.
- Free-collateral clamp.
- Reserve only sold units.
- Aggregate reserve across fills and series.
- Failed token transfer rolls back reserve and skew.
- Sale deadline and stopped issuance.
- Stale checkpoint failure.
- Wrong direction/hash/maker/receipt failure.

### 13.4 EXIT tests

- Exact-in success before expiry.
- Exact-out rejection.
- Bid below ask.
- Bid never exceeds maximum liability.
- Exit burns receipts.
- Exit reduces outstanding units.
- Exit releases correct maximum liability delta.
- Exit proceeds and remaining reserve preserve solvency.
- Partial exit.
- Exit after expiry reverts.
- Repeated/replayed receipt cannot exit again.
- Exit and subsequent settlement of remaining units succeeds.

### 13.5 Accumulator tests

- Initial sample storage.
- One and multiple return accumulation.
- Bounded 32-sample processing.
- Idempotent no-op.
- Future samples excluded.
- Exact end sample included.
- Phase crossing.
- Reverting and zero-timestamp nonexistent rounds.
- Invalid answer, timestamp, and answeredInRound rejection.
- Window predating feed rejection.
- Match Python/Decimal vectors.
- Finalization impossible before all samples.

### 13.6 SETTLE tests

- Finalization after expiry.
- Finalization before expiry reverts.
- Finalization cache immutable.
- Cap applied.
- Final liability releases cap surplus.
- Exact-in redemption.
- Exact-out rejection.
- Partial redemptions sum within defined rounding bound.
- Receipt burn and liability release.
- Zero-payout burn path.
- Redemption remains available without writer action.
- Very late redemption succeeds.

### 13.7 Adversarial tests

- Writer cannot withdraw locked collateral.
- Writer cannot revoke allowance.
- Writer cannot directly dock as vault.
- Writer cannot make vault perform arbitrary calls.
- Writer can stop ISSUE without affecting EXIT/SETTLE.
- Controller cannot accept fake order hash.
- Fake receipt cannot release liability.
- Genuine receipt with wrong leg hash cannot release liability.
- Hook replay fails.
- Second-address accomplice replay fails.
- Reentrancy through hook fails.
- Malicious engine target is not registered.
- Overlapping EXIT/SETTLE virtual balances cannot overdraw real reserve.
- Cross-series activity cannot spend another series' locked liability.
- Direct transfer of receipts between holders preserves total liability.

### 13.8 Invariants and fuzzing

Run stateful fuzz sequences over deposits, creates, issues, transfers, exits, checkpoints, finalization, settlement, free withdrawals, issuance stops, and closes.

Assert after every successful action:

```text
vaultBalance >= vaultLocked
seriesOutstanding = issued - exited - settled - worthlessBurned
sum(seriesLocked for vault) = vaultLocked
receipt totalSupply = maxUnits - exited - settled - worthlessBurned - unsoldBurnedAtClose
receipt totalSupply - vault receipt balance = seriesOutstanding
cumulative exit + settlement payout <= cumulative reserved capacity + collected premiums not counted as required
bid <= ask
bidPerUnit <= maxPayoutPerUnit
finalized liability uses final payout, not cap
```

Use at least 128 fuzz runs for ordinary suites and 1,000 runs for the final invariant suite if runtime remains acceptable. Record runtime and seed for any failure.

### 13.9 Fork E2E

On Base fork with canonical Aqua, official router, real USDC, and real ETH/USD:

1. Deploy factories, engine, accumulator, and Lens.
2. Deploy writer vault.
3. Fund vault with real forked USDC.
4. Create and ship a forward series.
5. Execute buyer issuance.
6. Execute pre-expiry exit for part of the position.
7. Prove writer withdrawal/dock/revoke paths fail.
8. Create a chain-31337-only historical series.
9. Checkpoint its real Chainlink window in bounded calls.
10. Finalize.
11. Settle remaining receipts.
12. Assert all USDC/receipt/vault-lock/Aqua virtual-balance deltas.

---

## 14. Economic simulation

The simulation must stop trying to prove exact hedging. It should quantify behavior.

Scenarios:

- Low realized variance below market quote.
- Realized variance near market quote.
- High realized variance at cap.
- Early volatility spike followed by calm.
- Calm period followed by late spike.
- Heavy issuance demand.
- Heavy early exits.
- Alternating issue/exit flow.
- Writer stops issuance.
- Multiple series sharing one vault.

Outputs:

```text
writer premium revenue
exit payouts
settlement payouts
writer final P&L
buyer entry, exit, and settlement P&L
locked/free capital over time
capital utilization
bid/ask path
realized versus projected variance
LVR estimate and residual basis error
```

Acceptance is not profitability in every scenario. Acceptance means accounting is solvent, behavior is explainable, and losses match the defined short-variance exposure.

---

## 15. Deployment manifest

New manifest fields:

```json
{
  "chainId": 31337,
  "deploymentBlock": 0,
  "aqua": "0x0000000000000000000000000000000000000000",
  "router": "0x0000000000000000000000000000000000000000",
  "routerSourceCommit": "pinned git commit",
  "routerBytecodeHash": "0x00",
  "usdc": "0x0000000000000000000000000000000000000000",
  "feed": "0x0000000000000000000000000000000000000000",
  "seriesFactory": "0x0000000000000000000000000000000000000000",
  "marketEngine": "0x0000000000000000000000000000000000000000",
  "accumulator": "0x0000000000000000000000000000000000000000",
  "lens": "0x0000000000000000000000000000000000000000",
  "writer": "0x0000000000000000000000000000000000000000",
  "buyer": "0x0000000000000000000000000000000000000000"
}
```

Deployment scripts fill real values. Zero addresses are examples only and must fail application readiness.

Deployment order:

1. Verify Aqua and router code/hash.
2. Deploy `VarianceSeriesFactory`. Its constructor stores immutable Aqua/router/feed/quote-token addresses, deploys `VarianceAccumulator(address(this), feed)`, then deploys `TremorMarketEngine(address(this), accumulator)`, and stores both child addresses as immutables. Because child contracts are created by the factory constructor, each child receives the final factory address without mutable initialization or predicted-address wiring.
3. Deploy Lens with factory, engine, accumulator, router, and Aqua references; its constructor verifies every cross-link.
4. Verify all immutable cross-links and child bytecode.
5. Write manifest.
6. Export ABIs.
7. Sync web, backend, and subgraph.
8. Run smoke lifecycle against deployed addresses.

---

## 16. Demo script

Target length: 3 minutes.

### 0:00–0:20 — Product

“Tremor is a covered market for ETH realized variance. One protected Aqua maker vault runs issuance, early exit, and final settlement strategies against a shared reserve.”

### 0:20–0:45 — Why Aqua

Show the three decoded SwapVM programs and their common maker vault. Explain that EXIT and SETTLE share reserve safely because both burn the same receipt claim.

### 0:45–1:10 — Create and buy

Deposit USDC, create a series, show no collateral reserved before sale, execute an ISSUE swap, and show exact sold-unit liability become locked.

### 1:10–1:35 — Attack the writer

Attempt locked withdrawal, allowance reduction, and settlement docking. Show each reverting or being structurally unavailable. Do not rely on UI-only disabled buttons; show on-chain transaction simulation/revert evidence.

### 1:35–1:55 — Real exit

Show the buyer’s executable bid and sell part of the receipts through EXIT. Show USDC received, receipts burned, and liability released.

### 1:55–2:25 — Oracle finalization

Use the historical fork series. Run bounded checkpoints, show real Chainlink round IDs/phase transition in advanced view, finalize variance, and show cap surplus unlocked.

### 2:25–2:45 — Settlement

Redeem the remaining receipts through SETTLE. Show Lens quote equals swap, USDC reaches holder, receipt supply falls, and vault remains solvent.

### 2:45–3:00 — LP connection

Show the same realized-variance state widening an Aqua AMM spread and the LVR calculator sizing an approximate long-variance receipt position. State basis-risk caveat in one sentence.

---

## 17. Execution sequence and commit plan

Do not perform a cross-stack rewrite in one commit. Preserve the existing dirty worktree before beginning through a human-approved commit or branch. Do not discard current changes.

Recommended commits:

1. `Document Tremor covered-market architecture`
2. `Add deterministic protected maker vaults`
3. `Track sold-unit liabilities in the series controller`
4. `Accumulate variance in bounded permissionless checkpoints`
5. `Build issue exit and settlement SwapVM programs`
6. `Price two-sided variance markets through Extruction`
7. `Burn exit and settlement receipts atomically`
8. `Prove vault solvency with adversarial invariants`
9. `Run the three-leg lifecycle on a Base fork`
10. `Index vaults checkpoints and three-leg fills`
11. `Expose executable variance bid and ask APIs`
12. `Add vault and market entities to the subgraph`
13. `Replace the series page with the two-sided volatility terminal`
14. `Update writer and portfolio flows for protected vaults`
15. `Rewrite documentation and demo around covered receipts`
16. `Verify the complete submission lifecycle`

Each commit must build and test its affected package. Do not commit generated secrets, `.env` files, private keys, SQLite databases, logs, `node_modules`, or `.next`.

---

## 18. Verification commands

Run from the repository root unless stated otherwise.

### Contracts

```bash
cd contracts
forge fmt --check
forge build --sizes
forge test -vv
BASE_RPC_URL=https://mainnet.base.org forge test --match-contract ForkE2E -vv
```

### Backend

```bash
cd backend
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo build --release
```

### Subgraph

```bash
cd subgraph
npm ci
npm run codegen
npm run build
```

### Web

Stop `next dev` before the production build.

```bash
cd web
npm ci
npm test
npx tsc --noEmit
npx eslint src
npm run build
```

### Complete lifecycle

```bash
scripts/dev.sh --fresh
```

Then verify:

- `/health` is ready and at chain head.
- Landing, markets, series, write, portfolio, hedge, and docs routes return 200.
- Vault creation/deposit works.
- ISSUE, EXIT, checkpoint, finalize, and SETTLE work.
- Writer attack calls fail.
- API and chain values agree.
- Browser console has no errors.
- Mobile layout has no horizontal overflow.

---

## 19. Final acceptance gates

### Gate A — Security

- All writer rug paths are impossible in contract tests.
- Stateful solvency invariant passes.
- No admin or upgrade authority can bypass locks.

### Gate B — Aqua relevance

- Three strategies are visibly shipped through Aqua.
- Real token transfers occur through Aqua pull/push.
- EXIT and SETTLE safely share one reserve.
- Official-router compatibility is demonstrated or the unmodified pinned official router fallback is documented.

### Gate C — Financial correctness

- Product is named accurately.
- Bid, ask, cap, payout, and P&L formulas match reference vectors.
- No fair-value or perfect-hedge claims remain.

### Gate D — Oracle liveness

- Bounded checkpoints process the full window.
- Finalization is permissionless.
- Settlement gas is measured and acceptable after finalization.

### Gate E — Product completeness

- Buyer can buy, exit, and redeem.
- Writer can fund, issue, stop, withdraw free funds, and close.
- Every displayed value has a chain/API source and correct label.

### Gate F — Submission

- Complete commit history.
- Base-fork demo passes from a fresh environment.
- Public deployment smoke test passes if submitted.
- Source and ABI artifacts match deployment bytecode.
- Demo video shows real transfers and failed writer attacks.

---

## 20. Stop conditions

Stop implementation and resolve the cause before continuing if any of these occur:

- The canonical router cannot execute required Extruction and hooks and the unmodified-router fallback also fails.
- Vault balance can fall below locked collateral in any fuzz sequence.
- EXIT and SETTLE can consume the same receipt.
- A writer-controlled method can lower Aqua allowance or dock protected strategies.
- Quote and swap diverge for identical state.
- Finalization requires a trusted key.
- The first redeem still performs unbounded history traversal.
- The UI displays a non-executable value as “close value.”
- Aqua is removed from actual token execution.
- The migration requires discarding unrelated uncommitted user work.

---

## 21. Definition of done

Tremor v2 is done only when a fresh Base-fork run demonstrates this exact sequence without privileged intervention:

```text
create protected writer vault
deposit USDC
create and ship ISSUE, EXIT, and SETTLE Aqua strategies
buy receipts
fail malicious writer withdrawal/revoke/dock attempts
exit part of the position at an executable bid
checkpoint real Chainlink history in bounded calls
finalize realized variance
redeem remaining receipts
burn every consumed receipt
release only the corresponding liability
retain vault solvency after every state transition
```

At that point the defensible submission claim is:

> Tremor is a fully collateralized, two-sided market for capped ETH realized-variance receipts. A protected contract maker runs issuance, early exit, and final settlement as Aqua SwapVM strategies sharing one reserve. Receipt burns make exit and settlement mutually exclusive, while permissionless Chainlink checkpoints make path-dependent settlement deterministic and bounded.

---

## 22. Execution instructions for an implementation agent

These instructions are part of the plan and apply to Opus 5 at medium reasoning or any replacement implementation agent.

1. Work only in `/Users/zeeast/Desktop/tremor`.
2. Read `AGENTS.md`, `ARCHITECTURE.md`, `DESIGN.md`, `contracts/CONTRACTS.md`, `docs/TASKS.md`, package-specific agent guides, and this complete file before editing.
3. Begin with `git status --short` and preserve every existing modification and untracked file. Never reset, checkout, clean, stash, overwrite, or delete user changes to obtain a clean tree.
4. Treat this document as the target architecture and current `ARCHITECTURE.md` as the v1 baseline until implementation and tests justify replacing it.
5. Complete the router compatibility gate before refactoring production order encoding.
6. Implement contracts and contract tests before backend or frontend migrations. Do not create UI values that have no final contract source.
7. Use `apply_patch` for edits and `rg` for search. Keep upstream Aqua and SwapVM source unmodified.
8. After each phase, run the smallest relevant tests and record actual output. Do not report unobserved success.
9. Do not weaken a failing invariant, remove an adversarial test, lower a safety bound, introduce an admin bypass, or substitute a mock for the Base-fork lifecycle merely to make a gate pass.
10. Do not add a trusted keeper requirement. Checkpointing and finalization remain permissionless.
11. Do not add an owner-controlled generic vault call, approval setter, settlement dock, token rescue for protected assets, proxy, upgrade function, pause that blocks holder redemption, or discretionary oracle override.
12. If current upstream interfaces differ from this plan, inspect the pinned source and adapt the implementation while preserving the stated safety and product invariants. Document the exact interface difference and resulting code choice in the commit body and architecture document.
13. If a required action depends on an unknown deployed-chain fact, resolve it with the read-only compatibility gate described here. Do not guess addresses, opcode availability, hooks, decimals, or feed behavior.
14. If a formula is ambiguous in code, add a high-precision reference vector first, then implement Solidity, Rust, and TypeScript against the same vector.
15. Keep all contract arithmetic integer-only. Floating-point math is permitted only for backend/UI display and simulation, never as executable authority.
16. Keep Lens and on-chain router quotes authoritative. Backend calculations are replicas for charts and diagnostics.
17. Version manifests, database schemas, persisted frontend transaction checkpoints, and API response schemas so v1 state cannot be interpreted as v2.
18. Do not update claims in README, docs, or UI before the corresponding behavior passes tests.
19. Do not deploy publicly with a private key stored in the repository or command history. Public broadcast remains a human keystore action.
20. End only when all six acceptance gates in Section 19 pass or when a stop condition in Section 20 is reached and documented with command output.

### Required phase reports

At the end of each implementation phase, report:

```text
phase name
files changed
behavior added or removed
tests executed
exact pass/fail result
known remaining failures
next dependency
```

### Required final report

The final implementation report must include:

```text
deployed/local addresses and chain IDs used
canonical or fallback router identity and compatibility evidence
contract size report
Foundry test totals
fork lifecycle transaction hashes or local receipts
backend format/lint/test/build results
subgraph codegen/build results
web test/typecheck/lint/build results
measured checkpoint, finalization, exit, and settlement gas
verified security invariants
remaining disclosed risks
documentation files updated
demo command and observed result
```
