Notes the web and backend builds rely on. Fragments below are exact; the Lens structs are read from the exported JSON ABI.

## Who approves whom

Verified in `lib/swap-vm/src/SwapVM.sol::_transferIn`: with `TakerTraits.useTransferFromAndAquaPush = true` the router does `tokenIn.safeTransferFrom(taker, router)` then `forceApprove(AQUA)` + `AQUA.push(...)`.

| Actor | Approves | Spender | For |
|---|---|---|---|
| Taker (buyer) | USDC | **the router** | ISSUE |
| Taker (holder) | receipts | **the router** | EXIT and SETTLE |
| Writer's vault | USDC | **Aqua** | Set once in the vault's constructor. No setter exists |
| Writer's vault | receipts | **Aqua** | Set by the controller when the receipt is registered |

A writer never signs an approval to Aqua. Both vault approvals are made by code the writer does not control, which is what makes them irrevocable.

The other Aqua path (`useTransferFromAndAquaPush = false`) needs a contract taker with a `preTransferInCallback` — not used by Tremor.

## Taker data

```solidity
function buildTakerData(address taker, bool isExactIn, bool isAToB, uint256 thresholdAmount, uint40 deadline, bool allowPartialFill) external pure returns (bytes memory);
function buildTakerData(address taker, bool isExactIn, bool isAToB, uint256 thresholdAmount, uint40 deadline) external pure returns (bytes memory);
```

Mirrors `TakerTraitsLib.build` with `useTransferFromAndAquaPush = true`, `isStrictThresholdAmount = false`, `isFirstTransferFromTaker = false`, no callbacks or hooks, `to = taker`, and `threshold = thresholdAmount == 0 ? "" : abi.encodePacked(uint256)` — minimum out for exact-in, maximum in for exact-out. `isAToB` comes from `lens.legDirection(id, leg)`: ISSUE is `quoteToken < receipt`, EXIT and SETTLE are `receipt < quoteToken`. Clients call the Lens rather than re-implementing the packing.

`allowPartialFill` is what makes the engine's clamps reachable — receipt inventory, the vault's free collateral, the cap, outstanding units, released liability. With it off, `TakerTraits` requires `takerAmount == amountIn` (or `== amountOut`) and any clamped fill reverts with `TakerTraitsTakerAmountInMismatch` / `TakerTraitsTakerAmountOutMismatch`. With it on, the threshold becomes a limit **rate** — pro-rated by the fraction actually filled — so quote the threshold against the taker amount you send, not against the clamped result.

## Lens `SeriesState` field order (ABI tuple order)

```text
(uint256 id, address writer, address vault, address receipt,
 (address feed,address quoteToken,uint40 start,uint40 expiry,uint40 saleEnd,uint32 sampleInterval,
  uint128 unitNotional,uint64 capVariance,uint64 anchorVariance,uint64 impactPerUnit,uint32 halfLife,
  uint16 halfSpreadBps,uint128 maxUnits) params,
 bytes32 issueOrderHash, bytes32 exitOrderHash, bytes32 settlementOrderHash,
 uint8 status /* 0 Upcoming,1 Live,2 ExpiredUnfinalized,3 Finalized,4 Closed */,
 (bool issuanceOpen,bool exitOpen,bool settleOpen,bool issueLegActive,bool exitLegActive,bool settleLegActive) legs,
 (uint256 marketVariance,uint256 projectedVariance,uint256 realizedVarianceSoFar,uint256 bidVariance,
  uint256 askVariance,uint256 bidPerUnit,uint256 askPerUnit,uint256 maxPayoutPerUnit) quote,
 uint256 unitsOutstanding, uint256 unitsAvailable, uint256 lockedLiability,
 uint256 finalVariance, uint256 payoutPerUnit,
 (uint256 samplesStored,uint256 samplesAvailable,uint256 samplesTotal,uint256 processedThrough,
  bool checkpointsCurrent) oracle,
 bool fullyCollateralized,
 (address vault,address owner,uint256 balance,uint256 locked,uint256 free,uint256 aquaAllowance,
  bool allowanceSufficient) vaultState)
```

The sub-structs are grouped deliberately: a flat 35-element tuple exceeds what alloy's `sol!` macro will decode, and nesting keeps one shape that both a Rust decoder and a TypeScript client handle.

| Field | Meaning |
|---|---|
| `quote.marketVariance` | The market's forward variance after skew decay (WAD). Not a fair value |
| `quote.projectedVariance` | Realized-so-far blended with the forward variance over the whole window, unclamped |
| `quote.bidPerUnit` / `askPerUnit` | Executable prices for `1e18` units, quote base units |
| `quote.maxPayoutPerUnit` | `floor(unitNotional · cap / 1e18)` |
| `unitsOutstanding` | Units held by anyone other than the vault |
| `unitsAvailable` | Units still shipped on the ISSUE strategy |
| `lockedLiability` | This series' share of the vault's `locked` |
| `finalVariance` / `payoutPerUnit` | Zero until `finalize`; fixed forever after |
| `oracle.processedThrough` | The timestamp the accumulator has reached |
| `fullyCollateralized` | `balance ≥ locked` **and** the allowance suffices **and** a burn leg is shipped |

## Lens functions

```solidity
function state(uint256 id) external view returns (SeriesState memory);
function states(uint256 from, uint256 to) external view returns (SeriesState[] memory);
function vaultState(address vault) external view returns (VaultState memory);
function writerVault(address writer) external view returns (address vault, bool exists, VaultState memory);
function quoteIssueExactIn(uint256 id, uint256 quoteIn) external view returns (uint256 units, uint256 premium);
function quoteIssueExactOut(uint256 id, uint256 units) external view returns (uint256 filledUnits, uint256 premium);
function quoteExitExactIn(uint256 id, uint256 units) external view returns (uint256 filledUnits, uint256 quoteOut);
function quoteSettleExactIn(uint256 id, uint256 units) external view returns (uint256 filledUnits, uint256 quoteOut);
function realizedVariance(address feed, uint40 start, uint40 end, uint32 interval) external view returns (uint256 rv, uint256 samples);
function samplePrices(address feed, uint40 start, uint40 end, uint32 interval) external view returns (uint256[] memory prices, uint80[] memory roundIds);
function priceAt(address feed, uint256 t) external view returns (uint256 answer, uint80 roundId);
function volatilityPct(uint256 variance) external pure returns (uint256);
function legDirection(uint256 id, Leg leg) external view returns (bool isAToB);
function lvrHedgeUnits(uint256 id, uint256 poolValueQuote, uint40 horizonSeconds) external view returns (uint256);
```

Every `quote*` view returns the **filled** amount as well as the price, so a clamped size is visible before a transaction is built.

## Human-readable fragments

```text
// VarianceSeriesFactory (the controller)
event VaultCreated(address indexed writer, address indexed quoteToken, address vault)
event SeriesCreated(uint256 indexed seriesId, address indexed writer, address vault, address receipt, bytes32 issueOrderHash, bytes32 exitOrderHash, bytes32 settlementOrderHash, (address,address,uint40,uint40,uint40,uint32,uint128,uint64,uint64,uint64,uint32,uint16,uint128) params)
event Issued(uint256 indexed seriesId, address indexed buyer, uint256 units, uint256 premium, uint256 outstandingUnits, uint256 lockedLiability)
event Exited(uint256 indexed seriesId, address indexed holder, uint256 units, uint256 proceeds, uint256 outstandingUnits, uint256 lockedLiability)
event Settled(uint256 indexed seriesId, address indexed holder, uint256 units, uint256 proceeds, uint256 outstandingUnits, uint256 lockedLiability)
event Finalized(uint256 indexed seriesId, uint256 finalVariance, uint256 cappedVariance, uint256 payoutPerUnit, uint256 outstandingUnits, uint256 releasedCollateral)
event IssuanceStopped(uint256 indexed seriesId, address indexed writer)
event WorthlessBurned(uint256 indexed seriesId, address indexed holder, uint256 units)
event SeriesClosed(uint256 indexed seriesId, uint256 unsoldBurned, uint256 releasedCollateral)
function createVault() returns (address vault)
function predictVault(address writer) view returns (address)
function createSeries(address vault, (…) p) returns (uint256 seriesId, address receipt)
function stopIssuance(uint256 seriesId)
function burnWorthless(uint256 seriesId, uint256 units)
function closeSeries(uint256 seriesId)
function seriesCount() view returns (uint256)
function vaultOf(address writer) view returns (address)
function series(uint256 seriesId) view returns (address writer, address vault, address receipt, bytes32 issueOrderHash, bytes32 exitOrderHash, bytes32 settlementOrderHash, (…) params)
// TremorMakerVault
function deposit(uint256 amount)
function withdrawFree(uint256 amount, address recipient)
function quoteBalance() view returns (uint256)
function lockedQuote() view returns (uint256)
function freeQuote() view returns (uint256)
function aquaAllowance() view returns (uint256)
// VarianceAccumulator
function checkpoint(uint256 seriesId, uint16 maxSamples) returns (uint256 stored, uint256 available)
function finalize(uint256 seriesId) returns (uint256 finalVariance)
function progress(uint256 seriesId) view returns (uint256 stored, uint256 available, uint256 total)
function isCurrent(uint256 seriesId) view returns (bool)
function MAX_SAMPLES_PER_CALL() view returns (uint16)
// TremorPrograms
function orders(uint256 id) view returns ((address,uint256,bytes) issue, (address,uint256,bytes) exit, (address,uint256,bytes) settlement)
function order(uint256 id, uint8 leg) view returns ((address,uint256,bytes))
function shipPlan(uint256 id) view returns (bytes[] strategies, address[] tokens, uint256[][] amounts)
function program(uint256 id, uint8 leg) view returns (bytes)
// Aqua
function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32)
function dock(address app, bytes32 strategyHash, address[] tokens)
function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)
event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)
event Docked(address maker, address app, bytes32 strategyHash)
event Pulled(address maker, address app, bytes32 strategyHash, address token, uint256 amount)
event Pushed(address maker, address app, bytes32 strategyHash, address token, uint256 amount)
// AquaSwapVMRouter (official, unmodified)
function quote((address maker,uint256 traits,bytes data) order, uint256 amount, bytes takerTraitsAndData) view returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)
function swap((address maker,uint256 traits,bytes data) order, uint256 amount, bytes takerTraitsAndData) payable returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)
function hash((address maker,uint256 traits,bytes data) order) view returns (bytes32)
event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)
// Chainlink proxy
function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
function phaseId() view returns (uint16)
function phaseAggregators(uint16 phaseId) view returns (address)
function decimals() view returns (uint8)
```

`MakerTraits` is the `uint256` `traits` field. Series ids start at `1`. Docking is **not** exposed to writers: it is a controller action inside `stopIssuance` and `closeSeries`.

## Exported ABI files

Arrays only, in `web/src/abi/` and `backend/abi/`, written by `contracts/script/export-abi.sh`: `TremorLens`, `TremorPrograms`, `VarianceSeriesFactory`, `TremorMarketEngine`, `TremorMakerVault`, `TremorSeriesDeployer`, `VarianceAccumulator`, `AquaSwapVMRouter`, `Aqua`, `VarianceReceipt`, `ERC20`, `AggregatorV3`, `RealizedVarianceOracle`, `MockUSDC`.

> A stale exported ABI decodes the live Lens struct into the wrong fields and every number on the page is quietly wrong. Always re-export after a redeploy — `make demo` does.
