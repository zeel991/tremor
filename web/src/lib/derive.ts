/**
 * `/write` derivation — three writer decisions become a complete `SeriesParams`.
 *
 *   01 how long          tenor in whole days
 *   02 how much          collateral in USDC (the rail's amount widget)
 *   03 at what price     a stance on trailing realized vol (or a custom vol %)
 *
 * The other ten fields are derived here, exactly, in bigint. Everything is reachable and
 * overridable through the `overrides` map (the Advanced disclosure), and every override runs back
 * through this one function so the audit table, the rail and `createSeries` can never disagree about
 * what ships.
 *
 * Pure: no React, no `Number` on any value that reaches the chain (timestamps and the two uint32
 * second-counts are `number` in `SeriesParams` itself).
 *
 * Invariants that hold BY CONSTRUCTION rather than by validation:
 *   - `(expiry − start) % sampleInterval == 0`   — the only duration input is a whole number of days
 *     and every interval on the ladder divides 86,400, so the remainder is identically 0. `expiry` is
 *     never an input; it is always recomputed as `start + n·sampleInterval`.
 *   - `sampleInterval >= 300`                    — the ladder's smallest member is 1800.
 *   - `2 <= samples <= 256`                      — the tenor/interval ladders keep both ends inside
 *     the factory's own bounds.
 *   - `saleEnd <= expiry`                        — clamped, and every mode is a multiple of the grid
 *     inside the window.
 *   - `10 <= halfSpreadBps <= 2000`              — clamped to the factory's bounds.
 *   - `0 < anchorVariance <= capVariance`        — the cap ladder floor includes `sqrt(2·anchor)`.
 *   - `askAtSellOut <= capVariance`              — the sell-out lift is clamped to the headroom the
 *     spread leaves, so the ASK stays inside the cap even after the whole inventory sells. Without
 *     that clamp the last buyer would be quoted more than the receipt can ever pay, and the engine
 *     would refuse the fill rather than sell it to them.
 *   - `maxSeriesLiability(params) <= collateral typed` — maxUnits is floored to a whole 0.01 units
 *     from a full-precision quotient, so the ceil-rounded liability still fits the budget.
 */
import type { Address } from "viem";
import {
  BPS,
  RECEIPT_DECIMALS,
  USDC_DECIMALS,
  WAD,
  fmtVolPct,
  maxBig,
  minBig,
  mulDivUp,
  sqrtWad,
  tryParseDecimal,
  varianceFromVolPct,
} from "./format";
import {
  breakEvenVariance,
  issuePremium,
  maxPayoutPerUnit,
  maxSeriesLiability,
  perUnitPrice,
  type SeriesParams,
} from "./series";

// ---------------------------------------------------------------- constants

export const HOUR = 3600;
export const DAY = 86_400;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT32_MAX = 2 ** 32 - 1;
const UINT40_MAX = 2 ** 40 - 1;

/**
 * Sample-count ceiling.
 *
 * The contract's own limit is 256. This is lower because of who pays: the window is walked in
 * bounded permissionless checkpoints of at most `SAMPLES_PER_CHECKPOINT` each, measured at roughly
 * 510 kgas for eight samples of real Chainlink history, so 84 samples is about eleven cheap
 * transactions rather than one enormous one. That is the whole reason the accumulator exists — v1
 * computed the entire window inside the first settlement and made the first redeemer pay for all of
 * it — and it is why this ceiling is a named constant rather than taste.
 */
export const MAX_SAMPLES = 84;

/** The factory's hard floor and ceiling on the sample count. */
export const MIN_SAMPLES = 2;
export const CONTRACT_MAX_SAMPLES = 256;

/** What one `checkpoint` call can store. Mirrors `VarianceAccumulator.MAX_SAMPLES_PER_CALL`. */
export const SAMPLES_PER_CHECKPOINT = 32;

/** Bounded checkpoint calls a window of `samples` returns needs, worst case. */
export const checkpointCallsFor = (samples: number): number =>
  Math.max(1, Math.ceil((samples + 1) / SAMPLES_PER_CHECKPOINT));

/**
 * Sampling grid candidates. Every member divides 86,400, which is what makes exact
 * divisibility structural for any whole-day window. The floor is 1800, not 900: on Chainlink
 * ETH/USD a 15-minute grid frequently resolves two neighbouring t_i to the same round, and a
 * repeated round contributes r_i = 0, which biases RV — and therefore the writer's payout —
 * downward.
 */
export const INTERVAL_LADDER = [1800, 3600, 7200, 14400, 21600, 43200, 86400] as const;

/**
 * 0.04e18 == 20% vol. A zero anchor would sell free exposure, and it would also divide by zero in the
 * engine's exact-in inverse, which solves for units at the ask.
 */
export const RV_FLOOR = 4n * 10n ** 16n;

/** 100 USDC per unit per 1.0 of variance. Constant so a "unit" means the same thing in every series. */
export const UNIT_NOTIONAL = 100_000_000n;

/** Inventory quantum: 0.01 units. Keeps the rail's size legible and the committed collateral inside the budget. */
export const UNITS_STEP = 10n ** 16n;

/** One whole unit — the smallest inventory worth putting on the market. */
export const MIN_UNITS = WAD;

/** The factory's own ceiling: 4e18 variance == 200% annualized vol. */
export const MAX_CAP_VARIANCE = 4n * WAD;

/** Round cap vols: 50 / 75 / 100 / 150 / 200 % vol. The ladder stops at the contract's ceiling. */
export const CAP_VOL_LADDER = [5n * 10n ** 17n, 75n * 10n ** 16n, WAD, 15n * 10n ** 17n, 2n * WAD] as const;

/**
 * How far selling the ENTIRE inventory may lift the market's forward variance, in basis points of
 * `anchorVariance`.
 *
 * `impactPerUnit` is derived from `maxUnits` so the price impact of clearing the whole book is a
 * fixed, bounded, stated quantity instead of a raw σ²-per-unit knob nobody can hold in their head
 * next to an inventory size. A flat per-unit slope is scale-blind: at the load sim's 400–900-unit
 * inventories the old 0.005e18 default moved the quote by 0.2–2.0 against an anchor of ~0.18, so
 * buyers paid 75–101% implied against 34–46% realized (`sim/out/report.md` §F4).
 */
export const SELLOUT_LIFT_BPS = 5_000n;
export const SELLOUT_LIFT_CHOICES = [2_500n, 5_000n, 10_000n] as const;

/**
 * Half of the bid/ask spread, in basis points of projected variance. 200 bps is a 4% round trip in
 * variance terms, which is about 2% in volatility terms.
 *
 * This is the price of the EXIT leg existing: the writer quotes a bid as well as an ask, and the
 * spread is what pays them for standing on both sides. The factory bounds it to [10, 2000].
 */
export const HALF_SPREAD_BPS = 200;
export const MIN_HALF_SPREAD_BPS = 10;
export const MAX_HALF_SPREAD_BPS = 2_000;
export const HALF_SPREAD_CHOICES = [50, 100, 200, 400] as const;

/** Stance = a multiplier on trailing realized VOL, in bps. A vol multiple squares in variance. */
export const STANCE_BPS = { cheap: 10_000n, fair: 11_500n, rich: 13_500n } as const;

export type Stance = keyof typeof STANCE_BPS | "custom";
export const STANCES: Stance[] = ["cheap", "fair", "rich", "custom"];
export const STANCE_LABEL: Record<Stance, string> = {
  cheap: "Cheap",
  fair: "Fair",
  rich: "Rich",
  custom: "Custom",
};

export type SaleMode = "start" | "quarter" | "half" | "expiry";
export const SALE_MODE_LABEL: Record<SaleMode, string> = {
  start: "At window start",
  quarter: "First quarter",
  half: "Halfway",
  expiry: "At expiry",
};

/** Tenors offered on the primary path. Any whole number of days is reachable in Advanced. */
export const TENORS = [1, 7, 14, 30] as const;

// ---------------------------------------------------------------- overrides

export type OverrideKey =
  | "start"
  | "tenorDays"
  | "sampleInterval"
  | "saleMode"
  | "unitNotional"
  | "capVolPct"
  | "halfSpreadBps"
  | "selloutLiftBps"
  | "impactPerUnit"
  | "halfLifeHours"
  | "maxUnits";

export type Overrides = Partial<Record<OverrideKey, string>>;

export const OVERRIDE_KEYS: OverrideKey[] = [
  "start",
  "tenorDays",
  "sampleInterval",
  "saleMode",
  "unitNotional",
  "capVolPct",
  "halfSpreadBps",
  "selloutLiftBps",
  "impactPerUnit",
  "halfLifeHours",
  "maxUnits",
];

/** Fields an expert can reach, in `SeriesParams` struct order, for the audit table. */
export type ParamKey = keyof SeriesParams;

export interface Issue {
  /** Stable key for React lists. */
  id: string;
  message: string;
  /** Where the offending control lives: the primary decisions or inside Advanced. */
  where: "primary" | "advanced";
  /** The param row it belongs to, so Advanced can render it under the input. */
  param?: ParamKey;
}

export interface Note {
  id: string;
  message: string;
  param?: ParamKey;
}

// ---------------------------------------------------------------- input / output

export interface DeriveInput {
  nowTs: number;
  feed: Address;
  quoteToken: Address;
  /** Trailing realized variance (WAD) — API, or the on-chain Lens fallback. null = unavailable. */
  trailingVariance: bigint | null;
  /** True while the trailing query is still in flight: not an error, just not here yet. */
  trailingPending?: boolean;
  /** 01 — whole days. */
  tenorDays: number;
  /** 02 — USDC as typed in the rail. */
  collateral: string;
  /** 03 — stance, or "custom" with a vol %. */
  stance: Stance;
  customVolPct: string;
  /**
   * Collateral this writer can actually commit: wallet USDC plus whatever their vault already holds
   * free. Both are spendable by `createSeries`, which tops the vault up out of the wallet.
   */
  walletUsdc?: bigint;
  overrides: Overrides;
}

export interface Derived {
  /** Complete and valid, or null when a hard error blocks assembly. */
  params: SeriesParams | null;
  /** Same fields as `params` but always present, so the audit table can render mid-error. */
  draft: SeriesParams;

  // the market this writer is opening
  /** Trailing realized variance the price is anchored on (WAD), after the 20% floor. */
  trailingVariance: bigint;
  trailingAvailable: boolean;
  trailingPending: boolean;
  trailingFloored: boolean;
  stanceVariance: Record<"cheap" | "fair" | "rich", bigint>;

  // window
  tenorSeconds: number;
  samples: number;
  /** Bounded, permissionless checkpoint calls the window will need. */
  checkpointCalls: number;

  // size
  collateralTyped: bigint | null;
  collateralCommitted: bigint;
  /** The most one unit can ever pay: `unitNotional · cap / 1e18`. */
  maxPayoutPerUnit: bigint;

  // the two-sided quote this market opens at
  /** Executable ISSUE ask for one unit at creation, quote base units. */
  askPerUnit: bigint;
  /** Executable EXIT bid for one unit at creation, quote base units. */
  bidPerUnit: bigint;
  /** Premium collected if the entire inventory sells, at the integral price. */
  premiumIfSoldOut: bigint;
  /** Forward variance after the whole inventory has sold. */
  varianceAtSellOut: bigint;
  /** The ASK at sell-out. Must stay inside the cap or the last buyer cannot be filled. */
  askAtSellOut: bigint;
  breakEvenVariance: bigint;
  worstCaseNet: bigint;

  errors: Issue[];
  warnings: Issue[];
  notes: Note[];
  overriddenKeys: OverrideKey[];
}

// ---------------------------------------------------------------- helpers

const clampInt = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

const parseVariance = (pct: string): bigint | null => {
  try {
    return pct.trim() ? varianceFromVolPct(pct) : null;
  } catch {
    return null;
  }
};

const parseIntStr = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const t = s.trim();
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
};

/** Next whole hour, at least 5 minutes out — the grid then lands on clean clock times. */
export const defaultStart = (nowTs: number): number => Math.ceil((nowTs + 300) / HOUR) * HOUR;

/** Finest grid that keeps the sample count at or under `MAX_SAMPLES`. */
export function intervalFor(tenorSeconds: number): number {
  for (const d of INTERVAL_LADDER) if (Math.ceil(tenorSeconds / d) <= MAX_SAMPLES) return d;
  return INTERVAL_LADDER[INTERVAL_LADDER.length - 1];
}

/** Decay for the inventory signal: 3 grid steps, held inside [1h, 12h]. */
export const halfLifeFor = (sampleInterval: number): number => clampInt(3 * sampleInterval, HOUR, 12 * HOUR);

/**
 * Round cap vol, at least twice trailing realized AND at least `sqrt(2·anchor)` so buyers keep 2×
 * upside at the cap. Anchoring on trailing realized (not on the writer's own price) is what stops
 * decision 03 from silently moving the size settled in decision 02: for every stance
 * `sqrt(2·anchor) <= 1.91·trailingVol < 2·trailingVol`, so only a custom price can lift the cap.
 */
export function capVarianceFor(trailingVariance: bigint, anchorVariance: bigint): bigint {
  const floorVol = maxBig(2n * sqrtWad(trailingVariance), sqrtWad(2n * anchorVariance));
  const capVol = CAP_VOL_LADDER.find((v) => v >= floorVol) ?? CAP_VOL_LADDER[CAP_VOL_LADDER.length - 1];
  return (capVol * capVol) / WAD;
}

/** Variance for a stance: a vol multiple of trailing realized squares cleanly into a variance multiple. */
export const stanceVariance = (trailingVariance: bigint, bps: bigint): bigint =>
  (trailingVariance * bps * bps) / (BPS * BPS);

// ---------------------------------------------------------------- the derivation

export function deriveSeries(input: DeriveInput): Derived {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const notes: Note[] = [];
  const ov = input.overrides;
  const overriddenKeys = OVERRIDE_KEYS.filter((k) => ov[k] !== undefined);

  // ---- what the market is anchored on -----------------------------------
  const trailingAvailable = input.trailingVariance !== null;
  const pending = !trailingAvailable && input.trailingPending === true;
  const trailingRaw = input.trailingVariance ?? 0n;
  const trailingFloored = trailingRaw < RV_FLOOR;
  const trailing = trailingFloored ? RV_FLOOR : trailingRaw;
  if (trailingAvailable && trailingFloored) {
    notes.push({
      id: "anchor-floor",
      message:
        trailingRaw === 0n
          ? "Trailing realized vol reads 0.0% — the feed printed no fresh rounds in that window, so this is a missing market, not a calm one. Prices start from a 20% floor; set your own level."
          : "Trailing realized vol is under the 20% floor, so prices are anchored on 20% instead.",
    });
  }

  // ---- price (anchorVariance: where the market rests) --------------------
  const stances = {
    cheap: stanceVariance(trailing, STANCE_BPS.cheap),
    fair: stanceVariance(trailing, STANCE_BPS.fair),
    rich: stanceVariance(trailing, STANCE_BPS.rich),
  };
  let anchorVariance: bigint;
  if (input.stance === "custom") {
    const v = parseVariance(input.customVolPct);
    if (v === null || v <= 0n) {
      errors.push({ id: "anchor-parse", message: "Enter the volatility you want to quote around.", where: "primary", param: "anchorVariance" });
      anchorVariance = stances.fair;
    } else {
      anchorVariance = v;
    }
  } else if (!trailingAvailable) {
    errors.push(
      pending
        ? { id: "anchor-pending", message: "Reading ETH's trailing realized volatility…", where: "primary", param: "anchorVariance" }
        : {
            id: "anchor-trailing",
            message: "Trailing realized vol is unavailable, so there is nothing to price against. Enter a volatility yourself.",
            where: "primary",
            param: "anchorVariance",
          },
    );
    anchorVariance = stances.fair;
  } else {
    anchorVariance = stances[input.stance];
  }
  if (anchorVariance > UINT64_MAX) {
    errors.push({
      id: "anchor-uint64",
      message: "That price does not fit the contract's uint64 variance field — the ceiling is about 429% vol.",
      where: input.stance === "custom" ? "primary" : "advanced",
      param: "anchorVariance",
    });
    anchorVariance = stances.fair;
  }

  // ---- spread: the price of quoting both sides ---------------------------
  let halfSpreadBps = HALF_SPREAD_BPS;
  if (ov.halfSpreadBps !== undefined) {
    const v = parseIntStr(ov.halfSpreadBps);
    if (v === null || v < MIN_HALF_SPREAD_BPS || v > MAX_HALF_SPREAD_BPS) {
      errors.push({
        id: "spread-range",
        message: `The half-spread must be between ${MIN_HALF_SPREAD_BPS} and ${MAX_HALF_SPREAD_BPS} basis points.`,
        where: "advanced",
        param: "halfSpreadBps",
      });
    } else {
      halfSpreadBps = v;
    }
  }
  const spread = BigInt(halfSpreadBps);

  // ---- cap (anchored on trailing realized, not on the writer's price) ----
  let capVariance: bigint;
  const capOv = ov.capVolPct !== undefined ? parseVariance(ov.capVolPct) : null;
  if (ov.capVolPct !== undefined) {
    if (capOv === null || capOv <= 0n) {
      errors.push({ id: "cap-parse", message: "Cap must be a volatility above 0.", where: "advanced", param: "capVariance" });
      capVariance = capVarianceFor(trailing, anchorVariance);
    } else if (capOv > MAX_CAP_VARIANCE) {
      errors.push({
        id: "cap-ceiling",
        message: `The contract caps variance at ${fmtVolPct(MAX_CAP_VARIANCE)}% vol.`,
        where: "advanced",
        param: "capVariance",
      });
      capVariance = capVarianceFor(trailing, anchorVariance);
    } else {
      capVariance = capOv;
    }
  } else {
    capVariance = capVarianceFor(trailing, anchorVariance);
    const naturalCap = capVarianceFor(trailing, 0n);
    if (capVariance > naturalCap) {
      notes.push({
        id: "cap-lifted",
        message: `Cap raised to ${fmtVolPct(capVariance)}% vol so buyers still have 2× upside at your price.`,
        param: "capVariance",
      });
    }
  }
  if (capVariance > MAX_CAP_VARIANCE) {
    // Only reachable when the ladder's own top entry is above the contract ceiling, which it is not,
    // or when a future ladder change makes it so. Clamp rather than ship an unusable series.
    capVariance = MAX_CAP_VARIANCE;
  }
  if (anchorVariance > capVariance) {
    errors.push({
      id: "anchor-over-cap",
      message: "Your price is above the maximum payout, so the market could not open. Raise the cap or lower your price.",
      where: "advanced",
      param: "capVariance",
    });
  } else if (capVariance < 2n * anchorVariance) {
    warnings.push({
      id: "cap-thin",
      message: `Buyers have less than 2× upside at this cap (${fmtVolPct(capVariance)}% vol against a ${fmtVolPct(anchorVariance)}% price), so the series will be slow to fill.`,
      where: "advanced",
      param: "capVariance",
    });
  }

  // The ASK, not the anchor, is what a buyer pays, and the engine refuses to sell above the cap. So
  // the spread has to leave room: `anchor · (1 + s) <= cap`.
  const askVariance = mulDivUp(anchorVariance, BPS + spread, BPS);
  if (askVariance > capVariance && anchorVariance <= capVariance) {
    errors.push({
      id: "ask-over-cap",
      message: `With a ${halfSpreadBps} bp half-spread the ask starts at ${fmtVolPct(askVariance)}% vol, above the ${fmtVolPct(capVariance)}% cap. Raise the cap, lower your price, or tighten the spread.`,
      where: "advanced",
      param: "halfSpreadBps",
    });
  }

  // ---- window ------------------------------------------------------------
  const tenorOv = parseIntStr(ov.tenorDays);
  if (ov.tenorDays !== undefined && (tenorOv === null || tenorOv < 1)) {
    errors.push({ id: "tenor-parse", message: "The window must be a whole number of days, 1 or more.", where: "advanced", param: "expiry" });
  }
  const tenorDays = clampInt(tenorOv ?? input.tenorDays, 1, 3650);
  const tenorSeconds = tenorDays * DAY;

  const intervalOv = parseIntStr(ov.sampleInterval);
  // The Advanced control is a select over the ladder, so an off-ladder value cannot be typed;
  // anything unexpected falls back to the derived grid rather than breaking divisibility.
  const sampleInterval =
    intervalOv !== null && (INTERVAL_LADDER as readonly number[]).includes(intervalOv) ? intervalOv : intervalFor(tenorSeconds);

  const startOv = parseIntStr(ov.start);
  if (ov.start !== undefined && startOv === null) {
    errors.push({ id: "start-parse", message: "That start time is not a valid date.", where: "advanced", param: "start" });
  }
  const start = startOv ?? defaultStart(input.nowTs);

  // expiry is NEVER an input: n whole grid steps, so `(expiry − start) % Δ == 0` identically.
  const n = Math.max(1, Math.round(tenorSeconds / sampleInterval));
  const expiry = start + n * sampleInterval;
  const samples = n;
  const checkpointCalls = checkpointCallsFor(samples);
  if (samples < MIN_SAMPLES) {
    errors.push({
      id: "samples-floor",
      message: `A window needs at least ${MIN_SAMPLES} samples to have a return to measure.`,
      where: "advanced",
      param: "sampleInterval",
    });
  }
  if (samples > CONTRACT_MAX_SAMPLES) {
    errors.push({
      id: "samples-ceiling",
      message: `The contract allows at most ${CONTRACT_MAX_SAMPLES} samples; this window asks for ${samples}. Use a coarser grid.`,
      where: "advanced",
      param: "sampleInterval",
    });
  } else if (samples > MAX_SAMPLES) {
    warnings.push({
      id: "samples-checkpoints",
      message: `${samples} samples means about ${checkpointCalls} bounded checkpoint calls to walk the window. Anyone can make them, but somebody has to.`,
      where: "advanced",
      param: "sampleInterval",
    });
  }

  const saleMode = ((): SaleMode => {
    const m = ov.saleMode;
    return m === "start" || m === "quarter" || m === "half" || m === "expiry" ? m : "quarter";
  })();
  const steps = saleMode === "start" ? 0 : saleMode === "half" ? Math.max(1, Math.floor(n / 2)) : saleMode === "expiry" ? n : Math.max(1, Math.floor(n / 4));
  let saleEnd = Math.min(expiry, start + steps * sampleInterval);
  if (saleEnd <= input.nowTs) {
    // `createSeries` requires `saleEnd >= block.timestamp`. A back-dated window (Advanced start
    // in the past) would revert, so hold the sale open for an hour — which is exactly how the
    // demo writes a series that settles from real Chainlink history.
    saleEnd = input.nowTs + HOUR;
    notes.push({
      id: "sale-held",
      message: "This window has already started, so the sale is held open for one hour — that is how a back-dated series is written.",
      param: "saleEnd",
    });
  }
  if (start <= input.nowTs) {
    warnings.push({
      id: "start-past",
      message: "This window has already started. Fine for a back-dated demo that settles from real history, but buyers cannot normally buy into it.",
      where: "advanced",
      param: "start",
    });
  }
  if (start > UINT40_MAX || expiry > UINT40_MAX) {
    errors.push({ id: "ts-range", message: "That window is outside the range the contract stores (uint40 seconds).", where: "advanced", param: "expiry" });
  }

  // ---- unit notional ----------------------------------------------------
  let unitNotional = UNIT_NOTIONAL;
  if (ov.unitNotional !== undefined) {
    const v = tryParseDecimal(ov.unitNotional, USDC_DECIMALS);
    if (v === null || v <= 0n) {
      errors.push({ id: "notional", message: "Unit notional must be more than 0 USDC.", where: "advanced", param: "unitNotional" });
    } else if (v > UINT128_MAX) {
      errors.push({ id: "notional-range", message: "Unit notional does not fit uint128.", where: "advanced", param: "unitNotional" });
    } else {
      unitNotional = v;
    }
  }

  // ---- size: collateral in, inventory out --------------------------------
  const payoutCeilingPerUnit = maxPayoutPerUnit({ unitNotional, capVariance }); // quote per 1e18 units
  const collateralTyped = tryParseDecimal(input.collateral || "0", USDC_DECIMALS);
  if (input.collateral.trim() !== "" && collateralTyped === null) {
    errors.push({ id: "collateral-parse", message: "Collateral must be a number of USDC.", where: "primary" });
  }
  const budget = collateralTyped !== null && collateralTyped > 0n ? collateralTyped : 0n;

  let maxUnits: bigint;
  const unitsOv = ov.maxUnits !== undefined ? tryParseDecimal(ov.maxUnits, RECEIPT_DECIMALS) : null;
  if (ov.maxUnits !== undefined) {
    if (unitsOv === null || unitsOv <= 0n) {
      errors.push({ id: "units-parse", message: "Max units must be more than 0.", where: "advanced", param: "maxUnits" });
      maxUnits = 0n;
    } else if (unitsOv > UINT128_MAX) {
      errors.push({ id: "units-range", message: "Max units does not fit uint128.", where: "advanced", param: "maxUnits" });
      maxUnits = 0n;
    } else {
      maxUnits = unitsOv;
    }
  } else if (capVariance <= 0n || unitNotional <= 0n) {
    maxUnits = 0n;
  } else {
    // The exact inverse of maxSeriesLiability(): full-precision quotient, then floor to 0.01 units.
    const raw = (budget * WAD * WAD) / (unitNotional * capVariance);
    maxUnits = (raw / UNITS_STEP) * UNITS_STEP;
  }

  const collateralCommitted = maxUnits > 0n ? maxSeriesLiability({ maxUnits, unitNotional, capVariance }) : 0n;

  if (maxUnits < MIN_UNITS && ov.maxUnits === undefined) {
    if (budget > 0n) {
      errors.push({
        id: "under-one-unit",
        message: `That covers less than one unit. This series needs at least ${fmtUsdcPlain(payoutCeilingPerUnit)} USDC of collateral — one unit of cap risk.`,
        where: "primary",
      });
    } else {
      errors.push({ id: "no-collateral", message: "Set the collateral you want to put at risk.", where: "primary" });
    }
  }
  if (input.walletUsdc !== undefined && collateralCommitted > input.walletUsdc) {
    errors.push({
      id: "short-balance",
      message: `You can commit ${fmtUsdcPlain(input.walletUsdc)} USDC — your wallet plus the free collateral in your vault. This series reserves ${fmtUsdcPlain(collateralCommitted)}.`,
      where: "primary",
    });
  }
  if (maxUnits >= MIN_UNITS && collateralTyped !== null && collateralTyped - collateralCommitted >= payoutCeilingPerUnit && ov.maxUnits === undefined) {
    // Only reachable with a rounding step this large; keep the writer informed rather than silent.
    notes.push({ id: "size-round", message: "Inventory is quantised to 0.01 units, so a little collateral stays uncommitted.", param: "maxUnits" });
  }

  // ---- inventory impact: impactPerUnit, derived from the inventory --------
  //
  // Selling the whole book is allowed to move the market's forward variance by a stated amount, and
  // `impactPerUnit` is whatever slope produces exactly that:
  //
  //     lift          = min(SELLOUT_LIFT_BPS/1e4 · anchorVariance, askHeadroom)
  //     impactPerUnit = lift · 1e18 / maxUnits
  //
  // `askHeadroom` is what the spread leaves before the ASK would exceed the cap:
  // `cap·1e4/(1e4+s) − anchor`. Clamping to it is not cosmetic — the engine refuses to quote above
  // the cap, so a lift past that point would simply stop the last buyers from being filled at all.
  //
  // At the default 50% lift, full sell-out puts the marginal ask at 1.5× the anchor (1.22× in vol
  // terms) and the average paid across the whole inventory at 1.25× (1.12× in vol). On a trailing
  // 42% market a Fair series opens at 48% and sells out at an average 54% — a normal variance risk
  // premium, not the 2.2× squeeze the load sim measured with a flat per-unit slope.
  const liftBps = ((): bigint => {
    const raw = ov.selloutLiftBps;
    if (raw === undefined) return SELLOUT_LIFT_BPS;
    const n2 = parseIntStr(raw);
    return n2 !== null && n2 > 0 ? BigInt(n2) : SELLOUT_LIFT_BPS;
  })();
  const askCeilingVariance = (capVariance * BPS) / (BPS + spread);
  const askHeadroom = askCeilingVariance > anchorVariance ? askCeilingVariance - anchorVariance : 0n;
  const lift = minBig((anchorVariance * liftBps) / BPS, askHeadroom);
  let impactPerUnit = maxUnits > 0n ? (lift * WAD) / maxUnits : 0n;
  if (ov.impactPerUnit !== undefined) {
    const v = tryParseDecimal(ov.impactPerUnit, 18);
    if (v === null || v < 0n) {
      errors.push({ id: "impact-parse", message: "Price impact must be 0 or more.", where: "advanced", param: "impactPerUnit" });
    } else if (v > capVariance) {
      errors.push({
        id: "impact-range",
        message: "The contract requires the per-unit impact to be at or below the cap.",
        where: "advanced",
        param: "impactPerUnit",
      });
    } else {
      impactPerUnit = v;
    }
  }
  const varianceAtSellOut = anchorVariance + (impactPerUnit * maxUnits) / WAD;
  const askAtSellOut = mulDivUp(minBig(varianceAtSellOut, capVariance), BPS + spread, BPS);
  if (varianceAtSellOut > askCeilingVariance && capVariance > anchorVariance) {
    warnings.push({
      id: "ask-clamps-early",
      message: `This curve reaches the cap before the inventory sells out, so the last units cannot be sold at all. Lower the impact, raise the cap, or reduce the inventory.`,
      where: "advanced",
      param: "impactPerUnit",
    });
  }

  // ---- decay -------------------------------------------------------------
  let halfLife = halfLifeFor(sampleInterval);
  if (ov.halfLifeHours !== undefined) {
    const v = tryParseDecimal(ov.halfLifeHours, 0);
    if (v === null || v < 0n) {
      errors.push({ id: "halflife", message: "Half-life must be 0 hours or more.", where: "advanced", param: "halfLife" });
    } else if (v * BigInt(HOUR) > BigInt(UINT32_MAX)) {
      errors.push({ id: "halflife-range", message: "Half-life does not fit uint32 seconds.", where: "advanced", param: "halfLife" });
    } else {
      halfLife = Number(v) * HOUR;
    }
  }

  // ---- readouts ----------------------------------------------------------
  //
  // Both sides of the market, at creation. `askVariance` is the projection times (1 + s) clamped to
  // the cap, and at creation nothing has elapsed so the projection is exactly the anchor.
  const askAtOpen = minBig(askVariance, capVariance);
  const bidAtOpen = minBig((anchorVariance * (BPS - spread)) / BPS, capVariance);
  const askPerUnit = perUnitPrice(unitNotional, askAtOpen);
  const bidPerUnit = perUnitPrice(unitNotional, bidAtOpen);

  // What the whole inventory raises, at the integral price the engine charges rather than at the
  // opening ask — which is the difference between a number a writer can rely on and one they cannot.
  const askSlope = (impactPerUnit * (BPS + spread)) / BPS;
  const premiumIfSoldOut = issuePremium(unitNotional, askAtOpen, askSlope, maxUnits);
  const be = breakEvenVariance(premiumIfSoldOut, maxUnits, unitNotional);
  const worstCaseNet = premiumIfSoldOut - collateralCommitted;

  const draft: SeriesParams = {
    feed: input.feed,
    quoteToken: input.quoteToken,
    start,
    expiry,
    saleEnd,
    sampleInterval,
    unitNotional,
    capVariance,
    anchorVariance,
    impactPerUnit,
    halfLife,
    halfSpreadBps,
    maxUnits,
  };

  // Last line of defence. Unreachable through this UI; if it ever fires, the derivation broke.
  if ((draft.expiry - draft.start) % draft.sampleInterval !== 0) {
    errors.push({ id: "divisibility", message: "Internal: the window is not a whole number of samples.", where: "advanced", param: "sampleInterval" });
  }
  if (draft.sampleInterval < 300) {
    errors.push({ id: "interval-floor", message: "Internal: the sampling interval is below the 300s floor.", where: "advanced", param: "sampleInterval" });
  }

  const params =
    errors.length === 0 && maxUnits >= MIN_UNITS && anchorVariance > 0n && capVariance > 0n ? draft : null;

  return {
    params,
    draft,
    trailingVariance: trailing,
    trailingAvailable,
    trailingPending: pending,
    trailingFloored,
    stanceVariance: stances,
    tenorSeconds,
    samples,
    checkpointCalls,
    collateralTyped,
    collateralCommitted,
    maxPayoutPerUnit: payoutCeilingPerUnit,
    askPerUnit,
    bidPerUnit,
    premiumIfSoldOut,
    varianceAtSellOut,
    askAtSellOut,
    breakEvenVariance: be,
    worstCaseNet,
    errors,
    warnings,
    notes,
    overriddenKeys,
  };
}

// ---------------------------------------------------------------- small local formatter

/** Plain grouped USDC without pulling the whole format surface into error strings. */
function fmtUsdcPlain(v: bigint): string {
  const whole = v / 10n ** BigInt(USDC_DECIMALS);
  const frac = (v % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0").slice(0, 2);
  return `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

/** The largest whole-unit collateral a balance can back — what MAX fills in. */
export function maxCollateralFor(balance: bigint, unitNotional: bigint, capVariance: bigint): bigint {
  if (balance <= 0n || unitNotional <= 0n || capVariance <= 0n) return 0n;
  const raw = (balance * WAD * WAD) / (unitNotional * capVariance);
  const units = (raw / UNITS_STEP) * UNITS_STEP;
  return mulDivUp(units * unitNotional, capVariance, WAD * WAD);
}
