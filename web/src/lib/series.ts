/** Normalized series model, shared by the chain (Lens) and API (backend) sources. */
import type { Address, Hex } from "viem";
import { WAD, fmtVolPct, mulDiv, mulDivUp, sqrtWad, yymmdd } from "./format";

/** The five lifecycle states, in the Lens enum's order. */
export enum Status {
  Upcoming = 0,
  Live = 1,
  ExpiredUnfinalized = 2,
  Finalized = 3,
  Closed = 4,
}
export const STATUS_LABEL: Record<Status, string> = {
  [Status.Upcoming]: "Upcoming",
  [Status.Live]: "Live",
  [Status.ExpiredUnfinalized]: "Finalizing",
  [Status.Finalized]: "Finalized",
  [Status.Closed]: "Closed",
};

/** Which of a series' three Aqua strategies. Matches the Solidity `Leg` enum, `NONE` included. */
export enum Leg {
  None = 0,
  Issue = 1,
  Exit = 2,
  Settle = 3,
}
export const LEG_LABEL: Record<Leg, string> = {
  [Leg.None]: "—",
  [Leg.Issue]: "Buy",
  [Leg.Exit]: "Exit",
  [Leg.Settle]: "Redeem",
};

export function statusFrom(v: unknown): Status {
  if (typeof v === "number" || typeof v === "bigint") {
    const n = Number(v);
    return n >= 0 && n <= 4 ? (n as Status) : Status.Upcoming;
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (/^\d+$/.test(s)) return statusFrom(Number(s));
    if (s === "live") return Status.Live;
    if (s === "expired_unfinalized" || s === "expired" || s === "finalizing") return Status.ExpiredUnfinalized;
    if (s === "finalized" || s === "settled") return Status.Finalized;
    if (s === "closed") return Status.Closed;
  }
  return Status.Upcoming;
}

export function legFrom(v: unknown): Leg {
  if (typeof v === "number" || typeof v === "bigint") {
    const n = Number(v);
    return n >= 0 && n <= 3 ? (n as Leg) : Leg.None;
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "issue") return Leg.Issue;
    if (s === "exit") return Leg.Exit;
    if (s === "settle") return Leg.Settle;
  }
  return Leg.None;
}

export interface SeriesParams {
  feed: Address;
  quoteToken: Address;
  start: number;
  expiry: number;
  saleEnd: number;
  sampleInterval: number;
  /** Quote base units paid per 1e18 units per 1e18 variance. */
  unitNotional: bigint;
  /** WAD. The most variance the receipt ever pays for. */
  capVariance: bigint;
  /** WAD. The market's resting forward variance before inventory skew. */
  anchorVariance: bigint;
  /** WAD forward-variance move per 1e18 units of net inventory sold. */
  impactPerUnit: bigint;
  /** Seconds for the inventory skew to halve; 0 = no decay. */
  halfLife: number;
  /** Half of the bid/ask spread, in basis points of projected variance. */
  halfSpreadBps: number;
  maxUnits: bigint;
}

/**
 * The writer's enforceable collateral position.
 *
 * This replaced v1's `coverage`, which measured a wallet the seller could empty at will. Here the
 * collateral is inside a vault whose owner cannot withdraw what is reserved, cannot reduce the Aqua
 * allowance, and cannot dock the legs that pay holders out.
 */
export interface VaultState {
  vault: Address;
  owner: Address;
  balance: bigint;
  locked: bigint;
  free: bigint;
  aquaAllowance: bigint;
  allowanceSufficient: boolean;
}

/** What the market is quoting. None of these is a claim about what variance is worth. */
export interface MarketQuote {
  /** The market's own forward variance after skew decay (WAD). */
  marketVariance: bigint;
  /** Realized-so-far blended with the forward variance over the whole window (WAD), unclamped. */
  projectedVariance: bigint;
  /** Annualized variance of the samples actually checkpointed (WAD). */
  realizedVarianceSoFar: bigint;
  bidVariance: bigint;
  askVariance: bigint;
  /** Executable EXIT bid for 1e18 units, quote base units. */
  bidPerUnit: bigint;
  /** Executable ISSUE ask for 1e18 units, quote base units. */
  askPerUnit: bigint;
  maxPayoutPerUnit: bigint;
}

/** How far the permissionless checkpointing has got. */
export interface OracleProgress {
  samplesStored: number;
  samplesAvailable: number;
  samplesTotal: number;
  processedThrough: number;
  checkpointsCurrent: boolean;
}

/** Which legs a user can act on, and which Aqua strategies are still shipped. */
export interface LegStatus {
  issuanceOpen: boolean;
  exitOpen: boolean;
  settleOpen: boolean;
  issueLegActive: boolean;
  exitLegActive: boolean;
  settleLegActive: boolean;
}

export interface SeriesState {
  id: bigint;
  writer: Address;
  vault: Address;
  receipt: Address;
  params: SeriesParams;
  issueOrderHash: Hex;
  exitOrderHash: Hex;
  settlementOrderHash: Hex;
  status: Status;
  legs: LegStatus;
  quote: MarketQuote;
  unitsOutstanding: bigint;
  /** Receipt units still shipped on the ISSUE strategy. */
  unitsAvailable: bigint;
  lockedLiability: bigint;
  finalVariance: bigint;
  payoutPerUnit: bigint;
  oracle: OracleProgress;
  /**
   * True only when the vault holds what it reserved, Aqua can still move it, and a burn leg is still
   * shipped. Never display "fully collateralized" on anything weaker than this.
   */
  fullyCollateralized: boolean;
  vaultState: VaultState;
  // backend extras
  fillsCount?: number;
  issueCount?: number;
  exitCount?: number;
  settleCount?: number;
  premiumQuote?: bigint;
  exitQuote?: bigint;
  settlementQuote?: bigint;
  unitsIssued?: bigint;
  unitsExited?: bigint;
  unitsSettled?: bigint;
  lastFillAt?: number;
  source: "chain" | "api";
}

// ---------------------------------------------------------------- derived quantities (bigint)

/**
 * The most a series can ever owe: `ceil(maxUnits · unitNotional · cap / 1e36)` in quote base units.
 * This is what both burn legs are shipped with, and what a writer has to be able to fund before the
 * whole inventory can sell.
 *
 * Rounded UP because that is exactly what `VariancePricing.maxLiability` computes; funding the floor
 * can leave the last unit unsellable.
 */
export const maxSeriesLiability = (p: Pick<SeriesParams, "maxUnits" | "unitNotional" | "capVariance">): bigint =>
  mulDivUp(p.maxUnits * p.unitNotional, p.capVariance, WAD * WAD);

/** Collateral reserved for `units` outstanding, before finalization: `ceil(u · N · cap / 1e36)`. */
export const maxLiabilityFor = (
  units: bigint,
  p: Pick<SeriesParams, "unitNotional" | "capVariance">,
): bigint => (units <= 0n ? 0n : mulDivUp(units * p.unitNotional, p.capVariance, WAD * WAD));

/** The most one unit can ever pay: `floor(unitNotional · cap / 1e18)`. */
export const maxPayoutPerUnit = (p: Pick<SeriesParams, "unitNotional" | "capVariance">): bigint =>
  (p.unitNotional * p.capVariance) / WAD;

/** Quote base units per 1e18 units at a given variance: `floor(unitNotional · v / 1e18)`. */
export const perUnitPrice = (unitNotional: bigint, variance: bigint): bigint => (unitNotional * variance) / WAD;

/** `floor(units · payoutPerUnit / 1e18)` — what a redemption pays. */
export const payoutFor = (units: bigint, payoutPerUnit: bigint): bigint => (units * payoutPerUnit) / WAD;

/**
 * Premium for `units` when the marginal ask starts at `askVariance` and rises by `slope` per 1e18
 * units: `ceil(unitNotional · (ask·u + ceil(slope·u²/2e18)) / 1e36)`.
 *
 * This is the integral, not the marginal price, which is the whole point: charging the opening ask on
 * every slice would let a buyer split a fill to beat the market.
 */
export function issuePremium(unitNotional: bigint, askVariance: bigint, slope: bigint, units: bigint): bigint {
  if (units <= 0n) return 0n;
  const integral = askVariance * units + mulDivUp(slope * units, units, 2n * WAD);
  return mulDivUp(unitNotional, integral, WAD * WAD);
}

/** Proceeds for selling `units` back against a falling bid, floored. */
export function exitProceeds(unitNotional: bigint, bidVariance: bigint, slope: bigint, units: bigint): bigint {
  if (units <= 0n) return 0n;
  const gross = bidVariance * units;
  const impact = (slope * units * units) / (2n * WAD);
  if (impact >= gross) return 0n;
  return mulDiv(unitNotional, gross - impact, WAD * WAD);
}

/** The realized variance at which a redemption returns exactly what was paid. */
export function breakEvenVariance(quotePaid: bigint, units: bigint, unitNotional: bigint): bigint {
  if (units === 0n || unitNotional === 0n) return 0n;
  return (quotePaid * WAD * WAD) / (units * unitNotional);
}

// ---------------------------------------------------------------- display helpers

export const marketVolPct = (s: SeriesState): string => fmtVolPct(s.quote.marketVariance);
export const projectedVolPct = (s: SeriesState): string => fmtVolPct(s.quote.projectedVariance);
export const realizedVolPct = (s: SeriesState): string => fmtVolPct(effectiveVariance(s));

/** The realized variance to show: the final one once known, otherwise what has been checkpointed. */
export const effectiveVariance = (s: SeriesState): bigint =>
  isFinalized(s) ? s.finalVariance : s.quote.realizedVarianceSoFar;

export const isFinalized = (s: SeriesState): boolean =>
  s.status === Status.Finalized || s.status === Status.Closed;

export const receiptSymbol = (s: Pick<SeriesState, "params">): string => `tVAR-ETH-${yymmdd(s.params.expiry)}`;
export const receiptName = (s: Pick<SeriesState, "params">): string =>
  `Tremor ETH Variance ${new Date(s.params.expiry * 1000).toISOString().slice(0, 10)}`;

export const volFromVariance = (v: bigint): bigint => sqrtWad(v);

/** Fraction of the observation window that has been checkpointed, in basis points. */
export const checkpointProgressBps = (s: SeriesState): bigint =>
  s.oracle.samplesTotal <= 1
    ? 0n
    : mulDiv(BigInt(Math.max(0, s.oracle.samplesStored - 1)), 10_000n, BigInt(s.oracle.samplesTotal - 1));

/** Sample points that have passed but have not been checkpointed. */
export const checkpointsBehind = (s: SeriesState): number =>
  Math.max(0, s.oracle.samplesAvailable - s.oracle.samplesStored);

// ---------------------------------------------------------------- what a user can do

export const canBuy = (s: SeriesState): boolean => s.legs.issuanceOpen && s.oracle.checkpointsCurrent;
export const canExit = (s: SeriesState): boolean => s.legs.exitOpen && s.oracle.checkpointsCurrent;
export const canRedeem = (s: SeriesState): boolean => s.legs.settleOpen && s.payoutPerUnit > 0n;
/** A finalized series that pays nothing cannot be redeemed through SwapVM, which rejects a zero output. */
export const needsWorthlessBurn = (s: SeriesState): boolean =>
  isFinalized(s) && s.payoutPerUnit === 0n && s.unitsOutstanding > 0n;
/** Expired with sample points still missing: somebody has to checkpoint before anyone can be paid. */
export const needsCheckpoint = (s: SeriesState): boolean => checkpointsBehind(s) > 0;
export const needsFinalize = (s: SeriesState): boolean =>
  s.status === Status.ExpiredUnfinalized && s.oracle.samplesStored >= s.oracle.samplesTotal;
export const canClose = (s: SeriesState): boolean =>
  s.status !== Status.Closed && s.unitsOutstanding === 0n;

export function sortSeries(list: SeriesState[]): SeriesState[] {
  const rank: Record<Status, number> = {
    [Status.Live]: 0,
    [Status.Upcoming]: 1,
    [Status.ExpiredUnfinalized]: 2,
    [Status.Finalized]: 3,
    [Status.Closed]: 4,
  };
  return [...list].sort((a, b) => rank[a.status] - rank[b.status] || a.params.expiry - b.params.expiry);
}

// ---------------------------------------------------------------- filters (markets page)

export type MarketFilter = "all" | "upcoming" | "live" | "finalizing" | "finalized" | "closed" | "issuanceOpen";
export const MARKET_FILTER_LABEL: Record<MarketFilter, string> = {
  all: "All",
  upcoming: "Upcoming",
  live: "Live",
  finalizing: "Finalizing",
  finalized: "Finalized",
  closed: "Closed",
  issuanceOpen: "Issuance open",
};

export function matchesFilter(s: SeriesState, f: MarketFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "upcoming":
      return s.status === Status.Upcoming;
    case "live":
      return s.status === Status.Live;
    case "finalizing":
      return s.status === Status.ExpiredUnfinalized;
    case "finalized":
      return s.status === Status.Finalized;
    case "closed":
      return s.status === Status.Closed;
    case "issuanceOpen":
      return s.legs.issuanceOpen;
  }
}
