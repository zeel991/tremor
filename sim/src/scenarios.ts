/**
 * The ten scenarios §14 of the implementation plan requires, plus the driver that runs them.
 *
 * The point is not to show that writing variance is profitable. It is to show that the accounting is
 * solvent in every case, that the behaviour is explainable, and that where the writer loses money the
 * loss is exactly the short-variance exposure they took on — no more, and from no other source.
 */

import { Series, Vault, type SeriesParams, type Snapshot } from "./market.js";
import { buildPath, pathVariance, rng, type Path, type Segment } from "./paths.js";
import * as P from "./pricing.js";
import { WAD } from "./pricing.js";

const HOUR = 3600;
const DAY = 86_400;
const USDC = 1_000_000n;

/** A 7-day series on a 2-hour grid: 84 samples, three bounded checkpoint calls. */
export function baseParams(now: number, over: Partial<SeriesParams> = {}): SeriesParams {
  const start = now;
  return {
    start,
    expiry: start + 7 * DAY,
    saleEnd: start + Math.floor((7 * DAY) / 4),
    sampleInterval: 2 * HOUR,
    unitNotional: 100n * USDC,
    capVariance: WAD, // 100% vol
    anchorVariance: 16n * 10n ** 16n, // 0.16 == 40% vol
    impactPerUnit: 8n * 10n ** 14n, // 0.0008 per unit
    halfLife: 6 * HOUR,
    halfSpreadBps: 200,
    maxUnits: 400n * WAD,
    ...over,
  };
}

export interface Holder {
  name: string;
  units: bigint;
  paid: bigint;
  received: bigint;
}

export interface Ctx {
  t: number;
  step: number;
  steps: number;
  series: Series;
  holders: Map<string, Holder>;
  path: Path;
  next: () => number;
  /** Bring the market current, in bounded calls, the way a trader has to before they can trade. */
  sync(): void;
  buy(name: string, amountIn: bigint): void;
  exitUnits(name: string, units: bigint): void;
}

export interface ScenarioSpec {
  key: string;
  title: string;
  /** What this scenario is meant to demonstrate, in one sentence. */
  intent: string;
  segments: Segment[];
  params?: Partial<SeriesParams>;
  /** Extra series sharing the same vault, for the shared-capital scenario. */
  extraSeries?: Array<{ params?: Partial<SeriesParams>; segments: Segment[] }>;
  collateral: bigint;
  /** Called once per sampling step, after the window has been brought current. */
  flow(ctx: Ctx): void;
}

export interface ScenarioResult {
  key: string;
  title: string;
  intent: string;
  /** Realized annualized vol of the generated path, as a percentage. */
  realizedVolPct: number;
  /** The market's ask before any fill, as a volatility percentage. */
  openingAskVolPct: number;
  /** Bounded checkpoint calls, and the largest batch any single call had to store. */
  largestCheckpointBatch: number;
  finalVariance: bigint;
  payoutPerUnit: bigint;
  unitsSold: bigint;
  unitsExited: bigint;
  unitsRedeemed: bigint;
  unitsUnsold: bigint;
  premiumRevenue: bigint;
  exitPayouts: bigint;
  settlementPayouts: bigint;
  writerPnl: bigint;
  buyerPnl: bigint;
  collateral: bigint;
  peakLocked: bigint;
  meanUtilizationPct: number;
  releasedAtFinalization: bigint;
  checkpointCalls: number;
  partialFills: number;
  snapshots: Snapshot[];
  holders: Holder[];
  lvr: {
    poolValue: bigint;
    hedgeUnits: bigint;
    hedgeCost: bigint;
    expectedLvr: bigint;
    hedgePayout: bigint;
    residual: bigint;
  };
  invariants: string[];
  notes: string[];
}

// ---------------------------------------------------------------- the driver

function holder(holders: Map<string, Holder>, name: string): Holder {
  let h = holders.get(name);
  if (!h) {
    h = { name, units: 0n, paid: 0n, received: 0n };
    holders.set(name, h);
  }
  return h;
}

/**
 * Runs one scenario end to end and returns its accounting.
 *
 * The loop is deliberately mechanical: advance one sampling step, bring the window current with
 * bounded checkpoint calls, let the scenario's flow act, snapshot. After expiry, finalize and let
 * every holder redeem. Nothing is netted or short-circuited, so the numbers at the end are the sum of
 * events that each individually respected the contracts' clamps.
 */
export function runScenario(spec: ScenarioSpec, now: number, seed: number): ScenarioResult {
  const vault = new Vault();
  vault.deposit(spec.collateral);

  const params = baseParams(now, spec.params);
  const path = buildPath({
    start: params.start,
    end: params.expiry,
    interval: params.sampleInterval,
    spot: 3000,
    segments: spec.segments,
    seed,
  });
  const series = new Series(1, params, vault);

  // Extra series on the same vault, if the scenario shares capital.
  const siblings = (spec.extraSeries ?? []).map((s, i) => {
    const p = baseParams(now, s.params);
    const sp = buildPath({
      start: p.start,
      end: p.expiry,
      interval: p.sampleInterval,
      spot: 3000,
      segments: s.segments,
      seed: seed + 1000 + i,
    });
    return { series: new Series(2 + i, p, vault), path: sp, units: 0n };
  });

  const holders = new Map<string, Holder>();
  const next = rng(seed ^ 0x5eed);
  const invariants: string[] = [];
  const notes: string[] = [];
  let checkpointCalls = 0;
  let largestCheckpointBatch = 0;
  let partialFills = 0;

  const check = (label: string, ok: boolean): void => {
    if (!ok) invariants.push(label);
  };

  const steps = (params.expiry - params.start) / params.sampleInterval;

  /**
   * Walk a window forward in bounded 32-sample calls until it is current.
   *
   * Called lazily — before a trade, and before finalization — rather than on a schedule, because that
   * is the real incentive structure: nobody is paid to checkpoint, so it happens when somebody wants
   * something that needs it. The call count and the largest batch are therefore meaningful.
   */
  const bringCurrent = (t: number, s: Series, pth: Path): void => {
    while (!s.isCurrent(t)) {
      const stored = s.checkpoint(t, (x) => pth.at(x), 32);
      checkpointCalls += 1;
      if (stored > largestCheckpointBatch) largestCheckpointBatch = stored;
      if (stored === 0) break; // nothing left to store; avoid spinning
    }
  };

  const ctxFor = (t: number, step: number): Ctx => ({
    t,
    step,
    steps,
    series,
    holders,
    path,
    next,
    sync() {
      bringCurrent(t, series, path);
    },
    buy(name, amountIn) {
      bringCurrent(t, series, path);
      const fill = series.issue(t, name, amountIn);
      if (!fill) return;
      const h = holder(holders, name);
      h.units += fill.units;
      h.paid += fill.quote;
      if (fill.partial) partialFills += 1;
    },
    exitUnits(name, units) {
      const h = holder(holders, name);
      const want = P.min(units, h.units);
      if (want <= 0n) return;
      bringCurrent(t, series, path);
      const fill = series.exit(t, name, want);
      if (!fill) return;
      h.units -= fill.units;
      h.received += fill.quote;
      if (fill.partial) partialFills += 1;
    },
  });

  // The ask before a single unit has traded, which is what a writer sees when they create the market.
  const openingQuote = series.quote(params.start);

  // ---- the window
  for (let step = 0; step <= steps; step++) {
    const t = params.start + step * params.sampleInterval;

    if (t < params.expiry) spec.flow(ctxFor(t, step));

    // Siblings take a steady trickle of demand so their reservations actually compete for capital.
    for (const sib of siblings) {
      if (sib.series.issuanceOpen(t) && step % 6 === 0) {
        bringCurrent(t, sib.series, sib.path);
        const fill = sib.series.issue(t, `sib${sib.series.id}`, 400n * USDC);
        if (fill) sib.units += fill.units;
      }
    }

    series.snapshot(t);
    // The invariant that matters most, asserted at every single step rather than at the end.
    check(`vault solvency at t+${step}`, vault.balance >= vault.locked);
    check(
      `series liability never exceeds the cap reservation at t+${step}`,
      series.lockedLiability
        <= P.maxLiability(series.outstandingUnits, params.unitNotional, params.capVariance)
          + (series.finalized ? 0n : 1n),
    );
  }

  // ---- expiry, finalization, redemption
  const tEnd = params.expiry;
  bringCurrent(tEnd, series, path);
  for (const sib of siblings) bringCurrent(tEnd, sib.series, sib.path);
  const lockedBefore = vault.locked;
  const { released } = series.finalize(tEnd);
  for (const sib of siblings) {
    if (!sib.series.finalized && sib.series.samplesStored >= sib.series.totalSamples) sib.series.finalize(tEnd);
  }
  // The siblings' own holders redeem too. Without this the shared vault would still be backing live
  // claims at the end, and "all capital is free" would fail for a reason that is correct behaviour.
  for (const sib of siblings) {
    if (sib.units <= 0n) continue;
    if (sib.series.payoutPerUnit === 0n) {
      sib.series.burnWorthless(sib.units);
    } else {
      sib.series.settle(tEnd, `sib${sib.series.id}`, sib.units);
    }
    sib.units = 0n;
  }
  check("finalization released no more than was locked", released <= lockedBefore);

  const unitsBeforeRedemption = series.outstandingUnits;
  if (series.payoutPerUnit === 0n && unitsBeforeRedemption > 0n) {
    notes.push(
      "Finalized at zero realized variance: the SETTLE leg cannot pay a zero output, so the holders' receipts are burned through burnWorthless, which still releases the reservation.",
    );
    for (const h of holders.values()) {
      if (h.units > 0n) {
        series.burnWorthless(h.units);
        h.units = 0n;
      }
    }
  } else {
    for (const h of holders.values()) {
      if (h.units <= 0n) continue;
      const fill = series.settle(tEnd, h.name, h.units);
      if (!fill) continue;
      h.units -= fill.units;
      h.received += fill.quote;
      if (fill.partial) partialFills += 1;
    }
  }
  series.snapshot(tEnd);

  check("every claim was extinguished", series.outstandingUnits === 0n);
  check("no liability remains after redemption", series.lockedLiability === 0n);
  check("vault solvency after redemption", vault.balance >= vault.locked);

  // With nothing outstanding, the series closes and the residual is free — which is the writer's test
  // that no capital is stranded by construction.
  series.close();
  for (const sib of siblings) {
    if (sib.series.outstandingUnits === 0n) sib.series.close();
  }
  check("all capital is free once every series is closed", vault.locked === 0n);
  check(
    "the vault's balance equals deposits plus premiums minus payouts",
    vault.balance === spec.collateral + totalPremium(series, siblings) - totalPaid(series, siblings),
  );

  // ---- metrics
  const realizedVolPct = Math.sqrt(pathVariance(path, params.start, params.expiry, params.sampleInterval)) * 100;
  const openingAskVolPct = Math.sqrt(Number(openingQuote.askVariance) / 1e18) * 100;

  const unitsSold = series.fills.filter((f) => f.leg === "issue").reduce((a, f) => a + f.units, 0n);
  const unitsExited = series.fills.filter((f) => f.leg === "exit").reduce((a, f) => a + f.units, 0n);
  const unitsRedeemed = series.fills.filter((f) => f.leg === "settle").reduce((a, f) => a + f.units, 0n);

  const peakLocked = series.snapshots.reduce((a, s) => (s.vaultLocked > a ? s.vaultLocked : a), 0n);
  const utilSum = series.snapshots.reduce(
    (a, s) => a + (s.vaultBalance === 0n ? 0 : Number((s.vaultLocked * 10_000n) / s.vaultBalance) / 100),
    0,
  );
  const meanUtilizationPct = utilSum / series.snapshots.length;

  const writerPnl = series.premiumTaken - series.exitPaid - series.settlePaid;
  const buyerPnl = [...holders.values()].reduce((a, h) => a + (h.received - h.paid), 0n);

  // ---- LVR: what an LP hedging with this series at t0 would have got
  const poolValue = 1_000_000n * USDC;
  const horizon = BigInt(params.expiry - params.start);
  const hedgeUnits = (poolValue * horizon * WAD) / (8n * P.YEAR * params.unitNotional);
  const q0 = series.quote(params.start);
  const hedgeCost = P.issuePremium(q0.askVariance, q0.askSlope, params.unitNotional, hedgeUnits);
  const realizedVarianceWad = BigInt(Math.round(pathVariance(path, params.start, params.expiry, params.sampleInterval) * 1e18));
  const expectedLvr = (poolValue * realizedVarianceWad * horizon) / (8n * P.YEAR * WAD);
  const hedgePayout = P.settleProceeds(hedgeUnits, series.payoutPerUnit);
  const residual = hedgePayout - hedgeCost - expectedLvr;

  if (series.finalVariance > params.capVariance) {
    notes.push(
      `Realized variance finished above the cap (${(Number(series.finalVariance) / 1e18).toFixed(4)} vs ${(Number(params.capVariance) / 1e18).toFixed(4)}), so the payout is truncated and the hedge under-pays by exactly the excess.`,
    );
  }
  if (partialFills > 0) {
    notes.push(`${partialFills} fills were clamped and re-priced rather than reverted.`);
  }

  return {
    key: spec.key,
    title: spec.title,
    intent: spec.intent,
    realizedVolPct,
    openingAskVolPct,
    largestCheckpointBatch,
    finalVariance: series.finalVariance,
    payoutPerUnit: series.payoutPerUnit,
    unitsSold,
    unitsExited,
    unitsRedeemed,
    unitsUnsold: params.maxUnits - unitsSold,
    premiumRevenue: series.premiumTaken,
    exitPayouts: series.exitPaid,
    settlementPayouts: series.settlePaid,
    writerPnl,
    buyerPnl,
    collateral: spec.collateral,
    peakLocked,
    meanUtilizationPct,
    releasedAtFinalization: released,
    checkpointCalls,
    partialFills,
    snapshots: series.snapshots,
    holders: [...holders.values()],
    lvr: { poolValue, hedgeUnits, hedgeCost, expectedLvr, hedgePayout, residual },
    invariants,
    notes,
  };
}

const totalPremium = (s: Series, sibs: Array<{ series: Series }>): bigint =>
  s.premiumTaken + sibs.reduce((a, x) => a + x.series.premiumTaken, 0n);
const totalPaid = (s: Series, sibs: Array<{ series: Series }>): bigint =>
  s.exitPaid + s.settlePaid + sibs.reduce((a, x) => a + x.series.exitPaid + x.series.settlePaid, 0n);

// ---------------------------------------------------------------- the ten scenarios

const COLLATERAL = 40_000n * USDC; // backs 400 units at a 100%-vol cap

/** Steady demand through the sale window: four buyers, one buy each per step. */
function steadyDemand(ctx: Ctx, perStep: bigint, buyers = 4): void {
  if (ctx.t > ctx.series.params.saleEnd) return;
  for (let i = 0; i < buyers; i++) ctx.buy(`buyer${i + 1}`, perStep);
}

export const SCENARIOS: ScenarioSpec[] = [
  {
    key: "low-realized",
    title: "Low realized variance, well below the market's quote",
    intent: "The writer's best case: they sold variance at 40% and it printed 20%.",
    segments: [{ share: 1, vol: 0.2 }],
    collateral: COLLATERAL,
    flow: (ctx) => steadyDemand(ctx, 600n * USDC),
  },
  {
    key: "near-quote",
    title: "Realized variance near the market's quote",
    intent: "The break-even neighbourhood: the writer keeps roughly the spread and the impact.",
    segments: [{ share: 1, vol: 0.4 }],
    collateral: COLLATERAL,
    flow: (ctx) => steadyDemand(ctx, 600n * USDC),
  },
  {
    key: "at-cap",
    title: "High realized variance, at the cap",
    intent: "The writer's worst case, and the proof that it is bounded by the cap and nothing worse.",
    segments: [{ share: 1, vol: 1.1 }],
    collateral: COLLATERAL,
    flow: (ctx) => steadyDemand(ctx, 600n * USDC),
  },
  {
    key: "early-spike",
    title: "Early volatility spike, then calm",
    intent: "Shows the projection converging downward as calm samples accumulate, and what that does to the bid.",
    segments: [
      { share: 0.25, vol: 1.2 },
      { share: 0.75, vol: 0.15 },
    ],
    collateral: COLLATERAL,
    flow: (ctx) => steadyDemand(ctx, 600n * USDC),
  },
  {
    key: "late-spike",
    title: "Calm, then a late spike",
    intent: "The case the sale window exists for: the spike lands after issuance has closed.",
    segments: [
      { share: 0.7, vol: 0.15 },
      { share: 0.3, vol: 1.3 },
    ],
    collateral: COLLATERAL,
    flow: (ctx) => steadyDemand(ctx, 600n * USDC),
  },
  {
    key: "heavy-issuance",
    title: "Heavy issuance demand",
    intent: "Demand large enough to hit the inventory and collateral clamps, to show fills clamping instead of failing.",
    segments: [{ share: 1, vol: 0.45 }],
    collateral: COLLATERAL,
    flow: (ctx) => {
      if (ctx.t > ctx.series.params.saleEnd) return;
      for (let i = 0; i < 8; i++) ctx.buy(`whale${i + 1}`, 4_000n * USDC);
    },
  },
  {
    key: "heavy-early-exits",
    title: "Heavy early exits",
    intent: "Everything bought in the first day is sold back in the second: the reserve has to survive it.",
    segments: [{ share: 1, vol: 0.4 }],
    collateral: COLLATERAL,
    flow: (ctx) => {
      if (ctx.step < 12) {
        steadyDemand(ctx, 900n * USDC);
      } else if (ctx.step < 24) {
        for (const h of ctx.holders.values()) ctx.exitUnits(h.name, h.units / 2n);
      }
    },
  },
  {
    key: "alternating-flow",
    title: "Alternating issue and exit flow",
    intent: "Round-tripping against the market repeatedly, to show the spread accrues and the skew does not drift.",
    segments: [{ share: 1, vol: 0.4 }],
    collateral: COLLATERAL,
    flow: (ctx) => {
      if (ctx.t > ctx.series.params.saleEnd) {
        for (const h of ctx.holders.values()) ctx.exitUnits(h.name, h.units / 4n);
        return;
      }
      if (ctx.step % 2 === 0) steadyDemand(ctx, 800n * USDC, 3);
      else for (const h of ctx.holders.values()) ctx.exitUnits(h.name, h.units / 3n);
    },
  },
  {
    key: "issuance-stopped",
    title: "The writer stops issuance mid-window",
    intent: "Proof that stopping sales leaves the exit and the redemption completely untouched.",
    segments: [{ share: 1, vol: 0.5 }],
    collateral: COLLATERAL,
    flow: (ctx) => {
      if (ctx.step === 8) {
        ctx.series.stopIssuance();
        return;
      }
      if (ctx.step < 8) steadyDemand(ctx, 900n * USDC);
      else if (ctx.step % 6 === 0) for (const h of ctx.holders.values()) ctx.exitUnits(h.name, h.units / 5n);
    },
  },
  {
    key: "shared-vault",
    title: "Three series sharing one vault",
    intent: "Capital is reserved writer-wide, so a second and third market compete for the same free collateral.",
    segments: [{ share: 1, vol: 0.4 }],
    collateral: COLLATERAL,
    extraSeries: [
      { segments: [{ share: 1, vol: 0.6 }] },
      { segments: [{ share: 1, vol: 0.25 }] },
    ],
    flow: (ctx) => steadyDemand(ctx, 700n * USDC),
  },
];
