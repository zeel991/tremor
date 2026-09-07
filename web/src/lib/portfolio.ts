/**
 * Normalized risk-group ("paired markets") model for `TremorPortfolioMarket`.
 *
 * One group backs two complementary capped claims on the same observation window:
 *
 *   HIGH pays S·x and CALM pays S·(1−x), where x = min(finalVariance / capVariance, 1) and
 *   S = capPayoutPerUnit (USDC base units per 1e18 claim units).
 *
 * Because the claims are complementary, the reserve while the group is live is
 * `ceil(max(high, calm) · S / 1e18)` — not the sum of both sides' caps. All arithmetic here mirrors
 * the contract exactly and stays bigint; nothing that can reach a transaction is ever a float.
 */
import type { Address } from "viem";
import { WAD, minBig, maxBig, mulDivUp, yymmdd } from "./format";

/** The two sides of a group. `high` is a boolean on the wire. */
export type Side = "high" | "calm";
export const SIDE_LABEL: Record<Side, string> = { high: "HIGH", calm: "CALM" };
export const sideIsHigh = (side: Side): boolean => side === "high";

/** PMode enum from `PortfolioOrderBuilder` — a uint8 on the wire. */
export enum PMode {
  IssueHigh = 1,
  IssueCalm = 2,
  ExitHigh = 3,
  ExitCalm = 4,
  SettleHigh = 5,
  SettleCalm = 6,
}
export const PMODE_LABEL: Record<PMode, string> = {
  [PMode.IssueHigh]: "ISSUE_HIGH",
  [PMode.IssueCalm]: "ISSUE_CALM",
  [PMode.ExitHigh]: "EXIT_HIGH",
  [PMode.ExitCalm]: "EXIT_CALM",
  [PMode.SettleHigh]: "SETTLE_HIGH",
  [PMode.SettleCalm]: "SETTLE_CALM",
};
export const issueMode = (side: Side): PMode => (side === "high" ? PMode.IssueHigh : PMode.IssueCalm);
export const exitMode = (side: Side): PMode => (side === "high" ? PMode.ExitHigh : PMode.ExitCalm);
export const settleMode = (side: Side): PMode => (side === "high" ? PMode.SettleHigh : PMode.SettleCalm);

export interface GroupParams {
  feed: Address;
  quoteToken: Address;
  start: number;
  expiry: number;
  saleEnd: number;
  sampleInterval: number;
  /** WAD. Variance at which HIGH pays the full S and CALM pays zero. */
  capVariance: bigint;
  /** USDC base units per 1e18 claim units — the shared payout scale S. */
  capPayoutPerUnit: bigint;
  maxUnitsPerSide: bigint;
  /** Fixed writer quotes, USDC base units per 1e18 units. Not a fair-value volatility model. */
  askHigh: bigint;
  bidHigh: bigint;
  askCalm: bigint;
  bidCalm: bigint;
}

export interface GroupState {
  id: bigint;
  writer: Address;
  vault: Address;
  highReceipt: Address;
  calmReceipt: Address;
  highOutstanding: bigint;
  calmOutstanding: bigint;
  reserveLocked: bigint;
  exitBuffer: bigint;
  /** What two separately backed series would have to lock for the same outstanding claims. */
  standaloneCaps: bigint;
  finalized: boolean;
  finalVariance: bigint;
  xWad: bigint;
  highPpu: bigint;
  calmPpu: bigint;
  params: GroupParams;
  source: "chain";
}

// ---------------------------------------------------------------- status

export enum GroupStatus {
  Upcoming = 0,
  Open = 1,
  Trading = 2,
  AwaitingFinalization = 3,
  Finalized = 4,
  Settled = 5,
}
export const GROUP_STATUS_LABEL: Record<GroupStatus, string> = {
  [GroupStatus.Upcoming]: "Upcoming",
  [GroupStatus.Open]: "Open",
  [GroupStatus.Trading]: "Trading",
  [GroupStatus.AwaitingFinalization]: "Awaiting finalization",
  [GroupStatus.Finalized]: "Finalized",
  [GroupStatus.Settled]: "Settled",
};

/** Lifecycle from immutable times plus the finalized flag. `now` is unix seconds. */
export function groupStatus(g: GroupState, now: number): GroupStatus {
  if (g.finalized) {
    return g.highOutstanding === 0n && g.calmOutstanding === 0n ? GroupStatus.Settled : GroupStatus.Finalized;
  }
  if (now < g.params.start) return GroupStatus.Upcoming;
  if (now >= g.params.expiry) return GroupStatus.AwaitingFinalization;
  if (now < g.params.saleEnd) return GroupStatus.Open;
  return GroupStatus.Trading;
}

// ---------------------------------------------------------------- payout math (mirrors the contract)

/** x = min(finalVariance / capVariance, 1), WAD. */
export function xWadFor(finalVariance: bigint, capVariance: bigint): bigint {
  if (capVariance <= 0n) return 0n;
  return minBig((finalVariance * WAD) / capVariance, WAD);
}

/** HIGH payout per 1e18 units: floor(S · x / 1e18). */
export const highPpuFor = (capPayoutPerUnit: bigint, xWad: bigint): bigint => (capPayoutPerUnit * xWad) / WAD;

/**
 * CALM payout per 1e18 units. Defined as the complement `S − highPpu` so the complete-set identity
 * `highPpu + calmPpu == S` holds exactly, with no rounding dust stranded in the vault.
 */
export const calmPpuFor = (capPayoutPerUnit: bigint, xWad: bigint): bigint =>
  capPayoutPerUnit - highPpuFor(capPayoutPerUnit, xWad);

/** Reserve while the group is live: `ceil(max(high, calm) · S / 1e18)`. */
export const liveReserve = (high: bigint, calm: bigint, capPayoutPerUnit: bigint): bigint => {
  const worst = maxBig(high, calm);
  return worst === 0n ? 0n : mulDivUp(worst, capPayoutPerUnit, WAD);
};

/** Reserve after finalization: `floor(h·highPpu/1e18) + floor(c·calmPpu/1e18)`. */
export const finalizedReserve = (high: bigint, calm: bigint, highPpu: bigint, calmPpu: bigint): bigint =>
  (high * highPpu) / WAD + (calm * calmPpu) / WAD;

/** The current reserve the contract would require for this exact outstanding pair. */
export const reserveFor = (g: GroupState, high: bigint, calm: bigint): bigint =>
  g.finalized ? finalizedReserve(high, calm, g.highPpu, g.calmPpu) : liveReserve(high, calm, g.params.capPayoutPerUnit);

/** What two separately backed series would lock: `ceil(h·S/1e18) + ceil(c·S/1e18)`. */
export const standaloneCapsFor = (high: bigint, calm: bigint, capPayoutPerUnit: bigint): bigint =>
  (high === 0n ? 0n : mulDivUp(high, capPayoutPerUnit, WAD)) +
  (calm === 0n ? 0n : mulDivUp(calm, capPayoutPerUnit, WAD));

/** Reserve released by burning `units` of one side, at the current outstanding pair. */
export function reserveReleasedByBurn(g: GroupState, side: Side, units: bigint): bigint {
  const h = side === "high" ? g.highOutstanding - units : g.highOutstanding;
  const c = side === "calm" ? g.calmOutstanding - units : g.calmOutstanding;
  if (h < 0n || c < 0n) return 0n;
  const before = reserveFor(g, g.highOutstanding, g.calmOutstanding);
  const after = reserveFor(g, h, c);
  return before > after ? before - after : 0n;
}

// ---------------------------------------------------------------- fixed-quote pricing (UI estimates only)

/** ISSUE premium at the writer's fixed ask: `ceil(units · ask / 1e18)`. Always re-quote on chain. */
export const groupIssuePremium = (units: bigint, ask: bigint): bigint =>
  units <= 0n ? 0n : mulDivUp(units, ask, WAD);

/** EXIT proceeds at the writer's fixed bid: `floor(units · bid / 1e18)`. Always re-quote on chain. */
export const groupExitProceeds = (units: bigint, bid: bigint): bigint => (units <= 0n ? 0n : (units * bid) / WAD);

/** SETTLE proceeds at the fixed payout: `floor(units · ppu / 1e18)`. */
export const groupSettleProceeds = (units: bigint, ppu: bigint): bigint => (units <= 0n ? 0n : (units * ppu) / WAD);

export const askFor = (g: GroupState, side: Side): bigint => (side === "high" ? g.params.askHigh : g.params.askCalm);
export const bidFor = (g: GroupState, side: Side): bigint => (side === "high" ? g.params.bidHigh : g.params.bidCalm);
export const ppuFor = (g: GroupState, side: Side): bigint => (side === "high" ? g.highPpu : g.calmPpu);
export const outstandingFor = (g: GroupState, side: Side): bigint =>
  side === "high" ? g.highOutstanding : g.calmOutstanding;
export const receiptFor = (g: GroupState, side: Side): Address => (side === "high" ? g.highReceipt : g.calmReceipt);

// ---------------------------------------------------------------- exit-liquidity accounting

/**
 * What can pay an early exit right now, mirroring the contract's `ExitUnderfunded(needed, available)`:
 * the reserve this burn releases plus the writer-managed exit buffer. Settlement backing is protected
 * and locked; the buffer is separate and the writer can withdraw the unused part at any time — which
 * is exactly why an exit quote can become unavailable before execution.
 */
export function exitAvailability(g: GroupState, side: Side, units: bigint): { needed: bigint; available: bigint } {
  const needed = groupExitProceeds(units, bidFor(g, side));
  const available = reserveReleasedByBurn(g, side, units) + g.exitBuffer;
  return { needed, available };
}

export const exitFunded = (g: GroupState, side: Side, units: bigint): boolean => {
  const { needed, available } = exitAvailability(g, side, units);
  return available >= needed;
};

// ---------------------------------------------------------------- what a user can do

export const groupCanBuy = (g: GroupState, now: number): boolean =>
  !g.finalized && now >= g.params.start && now < g.params.saleEnd;

export const groupCanExit = (g: GroupState, side: Side, now: number): boolean =>
  !g.finalized && now < g.params.expiry && outstandingFor(g, side) > 0n;

export const groupCanRedeem = (g: GroupState, side: Side): boolean => g.finalized && ppuFor(g, side) > 0n;

/** A side that finalized worthless cannot go through SwapVM (zero output); it burns instead. */
export const groupNeedsWorthlessBurn = (g: GroupState, side: Side): boolean =>
  g.finalized && ppuFor(g, side) === 0n && outstandingFor(g, side) > 0n;

/** Free collateral in the vault the writer could still commit or withdraw. */
export const vaultFreeCollateral = (balance: bigint, locked: bigint): bigint =>
  balance > locked ? balance - locked : 0n;

// ---------------------------------------------------------------- display

export const groupSymbol = (g: Pick<GroupState, "params">): string => `tPAIR-ETH-${yymmdd(g.params.expiry)}`;
export const sideSymbol = (g: Pick<GroupState, "params">, side: Side): string =>
  `${side === "high" ? "tHIGH" : "tCALM"}-ETH-${yymmdd(g.params.expiry)}`;

export function sortGroups(list: GroupState[], now: number): GroupState[] {
  const rank: Record<GroupStatus, number> = {
    [GroupStatus.Open]: 0,
    [GroupStatus.Trading]: 1,
    [GroupStatus.Upcoming]: 2,
    [GroupStatus.AwaitingFinalization]: 3,
    [GroupStatus.Finalized]: 4,
    [GroupStatus.Settled]: 5,
  };
  return [...list].sort(
    (a, b) => rank[groupStatus(a, now)] - rank[groupStatus(b, now)] || a.params.expiry - b.params.expiry,
  );
}

/** Collateral required to back the whole inventory of one side at the cap. */
export const maxGroupLiability = (p: Pick<GroupParams, "maxUnitsPerSide" | "capPayoutPerUnit">): bigint =>
  p.maxUnitsPerSide === 0n ? 0n : mulDivUp(p.maxUnitsPerSide, p.capPayoutPerUnit, WAD);
