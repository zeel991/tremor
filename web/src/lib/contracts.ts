/**
 * Single place that binds addresses and ABIs.
 *
 * ABIs: a JSON file in `src/abi/` wins when it carries a non-empty `abi` array (Foundry artifact or
 * bare array); otherwise the human-readable fragments below are used. Types always come from the
 * human-readable definitions so viem's inference is stable regardless of which runtime ABI is active.
 *
 * A stale JSON ABI decodes a live contract into the wrong fields silently, which is the worst failure
 * mode in this file. `contracts/script/export-abi.sh` is what keeps them current, and
 * `deploymentSchema` refuses a manifest that is not schema v3 so at least the addresses cannot be
 * mismatched at the same time.
 */
import { parseAbi, zeroAddress, isAddress, type Abi, type Address } from "viem";
import { z } from "zod";
import deploymentJson from "@/config/deployment.json";
import sepoliaDeploymentJson from "@/config/deployment-84532.json";
import { env } from "@/config/env";

import LensJson from "@/abi/TremorLens.json";
import ControllerJson from "@/abi/VarianceSeriesFactory.json";
import EngineJson from "@/abi/TremorMarketEngine.json";
import AccumulatorJson from "@/abi/VarianceAccumulator.json";
import ProgramsJson from "@/abi/TremorPrograms.json";
import VaultJson from "@/abi/TremorMakerVault.json";
import RouterJson from "@/abi/AquaSwapVMRouter.json";
import AquaJson from "@/abi/Aqua.json";
import ReceiptJson from "@/abi/VarianceReceipt.json";
import Erc20Json from "@/abi/ERC20.json";
import PortfolioMarketJson from "@/abi/TremorPortfolioMarket.json";

/** Set to false to force the human-readable fallbacks even when JSON ABIs are present. */
const PREFER_JSON_ABI = true;

/** The only manifest shape this app understands. Must match `Deploy.s.sol`. */
export const MANIFEST_SCHEMA_VERSION = 3;

// ---------------------------------------------------------------- addresses

export interface Deployment {
  schemaVersion: number;
  chainId: number;
  aqua: Address;
  router: Address;
  routerSourceCommit?: string;
  routerBytecodeHash?: `0x${string}`;
  weth: Address;
  usdc: Address;
  feed: Address;
  seriesFactory: Address;
  marketEngine: Address;
  accumulator: Address;
  seriesDeployer: Address;
  programs: Address;
  lens: Address;
  oracle: Address;
  portfolioMarket: Address;
  portfolioAccumulator: Address;
  deploymentBlock: number;
  writer: Address;
  buyer: Address;
}

const addressSchema = z
  .string()
  .refine(isAddress, "invalid EVM address")
  .transform((v) => v as Address);

const deploymentSchema = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION, {
    message: `deployment manifest must be schemaVersion ${MANIFEST_SCHEMA_VERSION}; re-run contracts/script/Deploy.s.sol`,
  }),
  chainId: z.number().int().positive(),
  aqua: addressSchema,
  router: addressSchema,
  routerSourceCommit: z.string().optional(),
  routerBytecodeHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional()
    .transform((v) => v as `0x${string}` | undefined),
  weth: addressSchema,
  usdc: addressSchema,
  feed: addressSchema,
  seriesFactory: addressSchema,
  marketEngine: addressSchema,
  accumulator: addressSchema,
  seriesDeployer: addressSchema,
  programs: addressSchema,
  lens: addressSchema,
  oracle: addressSchema,
  portfolioMarket: addressSchema,
  portfolioAccumulator: addressSchema,
  deploymentBlock: z.number().int().nonnegative(),
  writer: addressSchema,
  buyer: addressSchema,
});

const selectedDeployment = env.chainId === 84532 ? sepoliaDeploymentJson : deploymentJson;
const parsedDeployment = deploymentSchema.safeParse(selectedDeployment);
export const deploymentError = parsedDeployment.success
  ? undefined
  : parsedDeployment.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`).join("; ");

const emptyDeployment: Deployment = {
  schemaVersion: 0,
  chainId: 0,
  aqua: zeroAddress,
  router: zeroAddress,
  weth: zeroAddress,
  usdc: zeroAddress,
  feed: zeroAddress,
  seriesFactory: zeroAddress,
  marketEngine: zeroAddress,
  accumulator: zeroAddress,
  seriesDeployer: zeroAddress,
  programs: zeroAddress,
  lens: zeroAddress,
  oracle: zeroAddress,
  portfolioMarket: zeroAddress,
  portfolioAccumulator: zeroAddress,
  deploymentBlock: 0,
  writer: zeroAddress,
  buyer: zeroAddress,
};
export const ADDR: Deployment = parsedDeployment.success ? parsedDeployment.data : emptyDeployment;

export const isZeroAddress = (a: string | undefined | null): boolean => !a || a.toLowerCase() === zeroAddress;

/** True when every address the UI needs is present and the manifest is for this chain. */
export const isDeployed: boolean =
  ADDR.schemaVersion === MANIFEST_SCHEMA_VERSION &&
  ADDR.chainId === env.chainId &&
  !isZeroAddress(ADDR.seriesFactory) &&
  !isZeroAddress(ADDR.marketEngine) &&
  !isZeroAddress(ADDR.accumulator) &&
  !isZeroAddress(ADDR.programs) &&
  !isZeroAddress(ADDR.lens) &&
  !isZeroAddress(ADDR.router) &&
  !isZeroAddress(ADDR.aqua) &&
  !isZeroAddress(ADDR.usdc);

/**
 * The portfolio ("paired markets") surface needs two more addresses. It degrades independently: a
 * manifest that is valid but lacks live portfolio contracts hides the feature with an honest note
 * instead of rendering buttons that can only revert.
 */
export const isPortfolioDeployed: boolean =
  isDeployed && !isZeroAddress(ADDR.portfolioMarket) && !isZeroAddress(ADDR.portfolioAccumulator);

/**
 * Who a taker approves before `router.swap`. SwapVM pulls the taker's tokenIn with
 * `safeTransferFrom(taker, address(this), …)` executed by the router (`SwapVM._transferIn`), so the
 * spender is the router — never Aqua. Aqua's allowance belongs to the maker's vault, which grants it
 * once in its constructor and can never reduce it.
 */
export const TAKER_SPENDER: "router" | "aqua" = "router";
export const takerSpender = (): Address => (TAKER_SPENDER === "router" ? ADDR.router : ADDR.aqua);

// ---------------------------------------------------------------- ABI selection

function pickAbi<T extends Abi>(json: unknown, fallback: T): T {
  if (!PREFER_JSON_ABI) return fallback;
  const arr = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { abi?: unknown }).abi)
      ? (json as { abi: unknown[] }).abi
      : null;
  if (arr && arr.length > 0) return arr as unknown as T;
  return fallback;
}

// ---------------------------------------------------------------- human-readable fragments

const SERIES_PARAMS_STRUCT =
  "struct SeriesParams { address feed; address quoteToken; uint40 start; uint40 expiry; uint40 saleEnd; uint32 sampleInterval; uint128 unitNotional; uint64 capVariance; uint64 anchorVariance; uint64 impactPerUnit; uint32 halfLife; uint16 halfSpreadBps; uint128 maxUnits; }";

const ORDER_STRUCT = "struct Order { address maker; uint256 traits; bytes data; }";

const VAULT_STATE_STRUCT =
  "struct VaultState { address vault; address owner; uint256 balance; uint256 locked; uint256 free; uint256 aquaAllowance; bool allowanceSufficient; }";
const MARKET_QUOTE_STRUCT =
  "struct MarketQuote { uint256 marketVariance; uint256 projectedVariance; uint256 realizedVarianceSoFar; uint256 bidVariance; uint256 askVariance; uint256 bidPerUnit; uint256 askPerUnit; uint256 maxPayoutPerUnit; }";
const ORACLE_PROGRESS_STRUCT =
  "struct OracleProgress { uint256 samplesStored; uint256 samplesAvailable; uint256 samplesTotal; uint256 processedThrough; bool checkpointsCurrent; }";
const LEG_STATUS_STRUCT =
  "struct LegStatus { bool issuanceOpen; bool exitOpen; bool settleOpen; bool issueLegActive; bool exitLegActive; bool settleLegActive; }";

export const LENS_ABI_HR = parseAbi([
  SERIES_PARAMS_STRUCT,
  VAULT_STATE_STRUCT,
  MARKET_QUOTE_STRUCT,
  ORACLE_PROGRESS_STRUCT,
  LEG_STATUS_STRUCT,
  // Field order is binding: it is the ABI tuple order. `status` is a uint8 on the wire.
  "struct SeriesState { uint256 id; address writer; address vault; address receipt; SeriesParams params; bytes32 issueOrderHash; bytes32 exitOrderHash; bytes32 settlementOrderHash; uint8 status; LegStatus legs; MarketQuote quote; uint256 unitsOutstanding; uint256 unitsAvailable; uint256 lockedLiability; uint256 finalVariance; uint256 payoutPerUnit; OracleProgress oracle; bool fullyCollateralized; VaultState vaultState; }",
  "function state(uint256 id) view returns (SeriesState)",
  "function states(uint256 from, uint256 to) view returns (SeriesState[])",
  "function vaultState(address vault) view returns (VaultState)",
  "function writerVault(address writer) view returns (address vault, bool exists, VaultState vs)",
  "function quoteIssueExactIn(uint256 id, uint256 quoteIn) view returns (uint256 units, uint256 premium)",
  "function quoteIssueExactOut(uint256 id, uint256 units) view returns (uint256 filledUnits, uint256 premium)",
  "function quoteExitExactIn(uint256 id, uint256 units) view returns (uint256 filledUnits, uint256 quoteOut)",
  "function quoteSettleExactIn(uint256 id, uint256 units) view returns (uint256 filledUnits, uint256 quoteOut)",
  "function realizedVariance(address feed, uint40 start, uint40 end, uint32 interval) view returns (uint256 rv, uint256 samples)",
  "function samplePrices(address feed, uint40 start, uint40 end, uint32 interval) view returns (uint256[] prices, uint80[] roundIds)",
  "function volatilityPct(uint256 variance) pure returns (uint256)",
  "function buildTakerData(address taker, bool isExactIn, bool isAToB, uint256 thresholdAmount, uint40 deadline, bool allowPartialFill) pure returns (bytes)",
  "function lvrHedgeUnits(uint256 id, uint256 poolValueQuote, uint40 horizonSeconds) view returns (uint256 units)",
  "function legDirection(uint256 id, uint8 leg) view returns (bool isAToB)",
]);

export const CONTROLLER_ABI_HR = parseAbi([
  SERIES_PARAMS_STRUCT,
  "event VaultCreated(address indexed writer, address indexed quoteToken, address vault)",
  "event SeriesCreated(uint256 indexed seriesId, address indexed writer, address indexed vault, address receipt, bytes32 issueOrderHash, bytes32 exitOrderHash, bytes32 settlementOrderHash, SeriesParams params)",
  "event Issued(uint256 indexed seriesId, address indexed buyer, uint256 units, uint256 premium, uint256 newOutstanding, uint256 newLocked)",
  "event Exited(uint256 indexed seriesId, address indexed holder, uint256 units, uint256 amountOut, uint256 newOutstanding, uint256 newLocked)",
  "event Settled(uint256 indexed seriesId, address indexed holder, uint256 units, uint256 amountOut, uint256 newOutstanding, uint256 newLocked)",
  "event Finalized(uint256 indexed seriesId, uint256 finalVariance, uint256 cappedVariance, uint256 payoutPerUnit, uint256 outstandingUnits, uint256 releasedCollateral)",
  "event IssuanceStopped(uint256 indexed seriesId, address indexed writer)",
  "event SeriesClosed(uint256 indexed seriesId, uint256 unsoldBurned, uint256 releasedCollateral)",
  "function createVault() returns (address vault)",
  "function predictVault(address writer) view returns (address)",
  "function vaultOf(address writer) view returns (address)",
  "function isVault(address vault) view returns (bool)",
  "function createSeries(address vault, SeriesParams p) returns (uint256 seriesId, address receipt)",
  "function createBackdatedDemoSeries(address vault, SeriesParams p) returns (uint256 seriesId, address receipt)",
  "function stopIssuance(uint256 seriesId)",
  "function closeSeries(uint256 seriesId)",
  "function burnWorthless(uint256 seriesId, uint256 units)",
  "function seriesCount() view returns (uint256)",
  "function isClosed(uint256 seriesId) view returns (bool)",
  "function series(uint256 seriesId) view returns (address writer, address vault, address receipt, bytes32 issueOrderHash, bytes32 exitOrderHash, bytes32 settlementOrderHash, SeriesParams params)",
  "function maxSeriesLiability(SeriesParams p) pure returns (uint256)",
  "function ENGINE() view returns (address)",
  "function ACCUMULATOR() view returns (address)",
  "function ROUTER() view returns (address)",
  "function QUOTE_TOKEN() view returns (address)",
  "function FEED() view returns (address)",
]);

export const VAULT_ABI_HR = parseAbi([
  "event Deposited(address indexed payer, uint256 amount, uint256 newBalance, uint256 lockedBalance)",
  "event FreeWithdrawn(address indexed recipient, uint256 amount, uint256 newBalance, uint256 lockedBalance)",
  "function OWNER() view returns (address)",
  "function QUOTE_TOKEN() view returns (address)",
  "function lockedQuote() view returns (uint256)",
  "function quoteBalance() view returns (uint256)",
  "function freeQuote() view returns (uint256)",
  "function aquaAllowance() view returns (uint256)",
  "function deposit(uint256 amount)",
  "function withdrawFree(uint256 amount, address recipient)",
]);

export const ACCUMULATOR_ABI_HR = parseAbi([
  "struct Accumulator { uint16 processedSamples; uint40 processedThrough; uint80 lastRoundId; uint256 lastPriceWad; uint256 sumSquaredReturnsWad; }",
  "event Checkpointed(uint256 indexed seriesId, uint256 fromSample, uint256 toSample, uint40 processedThrough, uint80 lastRoundId, uint256 sumSquaredReturnsWad)",
  "function accumulator(uint256 seriesId) view returns (Accumulator)",
  "function progress(uint256 seriesId) view returns (uint256 stored, uint256 available, uint256 total)",
  "function isCurrent(uint256 seriesId) view returns (bool)",
  "function realizedSoFar(uint256 seriesId) view returns (uint256 variance, uint256 elapsed, uint256 processedThrough)",
  "function checkpoint(uint256 seriesId, uint16 maxSamples) returns (uint256 stored, uint256 available)",
  "function finalize(uint256 seriesId) returns (uint256 finalVariance)",
  "function MAX_SAMPLES_PER_CALL() view returns (uint16)",
]);

export const ENGINE_ABI_HR = parseAbi([
  "function market(uint256 seriesId) view returns (uint256 projected, uint256 bidVariance, uint256 askVariance, uint256 forward, uint256 realizedSoFar)",
  "function quoteIssueExactIn(uint256 seriesId, uint256 amountIn) view returns (uint256 units, uint256 premium)",
  "function quoteIssueExactOut(uint256 seriesId, uint256 units) view returns (uint256 filledUnits, uint256 premium)",
  "function quoteExitExactIn(uint256 seriesId, uint256 units) view returns (uint256 filledUnits, uint256 amountOut)",
  "function quoteSettleExactIn(uint256 seriesId, uint256 units) view returns (uint256 filledUnits, uint256 amountOut)",
]);

export const PROGRAMS_ABI_HR = parseAbi([
  ORDER_STRUCT,
  "function orders(uint256 seriesId) view returns (Order issue, Order exit, Order settlement)",
  "function order(uint256 seriesId, uint8 leg) view returns (Order)",
  "function shipPlan(uint256 seriesId) view returns (bytes[] strategies, address[] tokens, uint256[][] amounts)",
  "function program(uint256 seriesId, uint8 leg) view returns (bytes)",
]);

export const AQUA_ABI_HR = parseAbi([
  "function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)",
  "function safeBalances(address maker, address app, bytes32 strategyHash, address token0, address token1) view returns (uint256 balance0, uint256 balance1)",
  "event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)",
  "event Docked(address maker, address app, bytes32 strategyHash)",
  "event Pulled(address maker, address app, bytes32 strategyHash, address token, uint256 amount)",
  "event Pushed(address maker, address app, bytes32 strategyHash, address token, uint256 amount)",
]);

export const ROUTER_ABI_HR = parseAbi([
  ORDER_STRUCT,
  "function quote(Order order, uint256 amount, bytes takerTraitsAndData) view returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)",
  "function swap(Order order, uint256 amount, bytes takerTraitsAndData) payable returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)",
  "function hash(Order order) view returns (bytes32)",
  "event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)",
]);

export const ERC20_ABI_HR = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);

export const FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function phaseId() view returns (uint16)",
  "function phaseAggregators(uint16 phaseId) view returns (address)",
  "function decimals() view returns (uint8)",
]);

export const ORACLE_ABI_HR = parseAbi([
  "function trailing(address feed, uint32 window, uint32 interval) view returns (uint256 rv, uint256 samples, uint40 from, uint40 to)",
  "function poke(address feed, uint32 window, uint32 interval) returns (uint256 rv)",
  "function cachedTrailing(uint32 window) view returns (uint256 variance, uint256 updatedAt)",
]);

/**
 * TremorPortfolioMarket: one contract is the controller and the pricing Extruction target for a
 * "risk group" — two complementary capped claims (HIGH pays S·x, CALM pays S·(1−x), where
 * x = min(finalVariance / capVariance, 1) and S = capPayoutPerUnit). Field order in both structs is
 * binding ABI tuple order; `orderFor`'s mode is the PMode enum, a uint8 on the wire.
 */
export const PORTFOLIO_MARKET_ABI_HR = parseAbi([
  ORDER_STRUCT,
  "struct GroupParams { address feed; address quoteToken; uint40 start; uint40 expiry; uint40 saleEnd; uint32 sampleInterval; uint64 capVariance; uint128 capPayoutPerUnit; uint128 maxUnitsPerSide; uint128 askHigh; uint128 bidHigh; uint128 askCalm; uint128 bidCalm; }",
  "struct GroupView { address writer; address vault; address highReceipt; address calmReceipt; uint256 highOutstanding; uint256 calmOutstanding; uint256 reserveLocked; uint256 exitBuffer; uint256 standaloneCaps; bool finalized; uint256 finalVariance; uint256 xWad; uint256 highPpu; uint256 calmPpu; }",
  "event VaultCreated(address writer, address vault)",
  "event GroupCreated(uint256 groupId, address writer, address vault, address highReceipt, address calmReceipt, GroupParams params)",
  "event GroupFinalized(uint256 groupId, uint256 finalVariance, uint256 xWad, uint256 highPayoutPerUnit, uint256 calmPayoutPerUnit, uint256 releasedCollateral)",
  "event PortfolioIssued(uint256 groupId, address buyer, bool high, uint256 units, uint256 premium, uint256 highOutstanding, uint256 calmOutstanding, uint256 reserveLocked)",
  "event PortfolioExited(uint256 groupId, address holder, bool high, uint256 units, uint256 amountOut, uint256 reserveReleased, uint256 bufferDrawn, uint256 reserveLocked)",
  "event PortfolioSettled(uint256 groupId, address holder, bool high, uint256 units, uint256 amountOut, uint256 reserveLocked)",
  "event ExitBufferFunded(uint256 groupId, address payer, uint256 amount, uint256 newBuffer)",
  "event ExitBufferWithdrawn(uint256 groupId, uint256 amount, uint256 newBuffer)",
  "event WorthlessBurned(uint256 groupId, address holder, bool high, uint256 units)",
  "function createVault() returns (address vault)",
  "function vaultOf(address writer) view returns (address vault)",
  "function isVault(address vault) view returns (bool)",
  "function createGroup(address vault, GroupParams p) returns (uint256 groupId)",
  "function createBackdatedDemoGroup(address vault, GroupParams p) returns (uint256 groupId)",
  "function allocateExitBuffer(uint256 groupId, uint256 amount)",
  "function fundExitBuffer(uint256 groupId, uint256 amount)",
  "function withdrawExitBuffer(uint256 groupId, uint256 amount)",
  "function burnWorthless(uint256 groupId, bool high, uint256 units)",
  "function groupCount() view returns (uint256)",
  "function groupView(uint256 groupId) view returns (GroupView v)",
  "function groupParams(uint256 groupId) view returns (GroupParams)",
  "function orderFor(uint256 groupId, uint8 mode) view returns (Order)",
  "function orderHashFor(uint256 groupId, uint8 mode) view returns (bytes32)",
  "function orderRef(bytes32 orderHash) view returns (uint256 groupId, uint8 mode)",
  "function ACCUMULATOR() view returns (address)",
  "function ROUTER() view returns (address)",
  "function QUOTE_TOKEN() view returns (address)",
  "function FEED() view returns (address)",
]);

// ---------------------------------------------------------------- exported ABIs (runtime = JSON if present)

export const lensAbi = pickAbi(LensJson as unknown, LENS_ABI_HR);
export const controllerAbi = pickAbi(ControllerJson as unknown, CONTROLLER_ABI_HR);
export const engineAbi = pickAbi(EngineJson as unknown, ENGINE_ABI_HR);
export const accumulatorAbi = pickAbi(AccumulatorJson as unknown, ACCUMULATOR_ABI_HR);
export const programsAbi = pickAbi(ProgramsJson as unknown, PROGRAMS_ABI_HR);
export const vaultAbi = pickAbi(VaultJson as unknown, VAULT_ABI_HR);
export const routerAbi = pickAbi(RouterJson as unknown, ROUTER_ABI_HR);
export const aquaAbi = pickAbi(AquaJson as unknown, AQUA_ABI_HR);
export const receiptAbi = pickAbi(ReceiptJson as unknown, ERC20_ABI_HR);
export const erc20Abi = pickAbi(Erc20Json as unknown, ERC20_ABI_HR);
export const oracleAbi = ORACLE_ABI_HR;
export const portfolioMarketAbi = pickAbi(PortfolioMarketJson as unknown, PORTFOLIO_MARKET_ABI_HR);

export const abiSource = {
  lens: lensAbi === (LENS_ABI_HR as Abi) ? "fallback" : "json",
  controller: controllerAbi === (CONTROLLER_ABI_HR as Abi) ? "fallback" : "json",
  engine: engineAbi === (ENGINE_ABI_HR as Abi) ? "fallback" : "json",
  accumulator: accumulatorAbi === (ACCUMULATOR_ABI_HR as Abi) ? "fallback" : "json",
  programs: programsAbi === (PROGRAMS_ABI_HR as Abi) ? "fallback" : "json",
  vault: vaultAbi === (VAULT_ABI_HR as Abi) ? "fallback" : "json",
  router: routerAbi === (ROUTER_ABI_HR as Abi) ? "fallback" : "json",
  aqua: aquaAbi === (AQUA_ABI_HR as Abi) ? "fallback" : "json",
  portfolioMarket: portfolioMarketAbi === (PORTFOLIO_MARKET_ABI_HR as Abi) ? "fallback" : "json",
} as const;

export type Order = { maker: Address; traits: bigint; data: `0x${string}` };
