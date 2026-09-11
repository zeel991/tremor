/**
 * Typed fetchers for every backend endpoint. snake_case JSON is camelized before zod parsing; amounts
 * become bigint, timestamps unix seconds, prices floats (charts only).
 *
 * The backend serves the Lens state flat, because that is what a JSON consumer wants; the app's model
 * is nested (`legs`, `quote`, `oracle`) because that is what a 35-field tuple has to become to be
 * readable. The grouping happens once, here, in `toSeriesState`.
 */
"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { env } from "@/config/env";
import { parseDecimal, sqrtWad, toBigInt } from "./format";
import { statusFrom, type SeriesParams, type SeriesState, type VaultState } from "./series";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get offline(): boolean {
    return this.status === 0;
  }
}

// ---------------------------------------------------------------- key normalisation

const camel = (k: string): string => k.replace(/[_-]([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());

export function camelizeDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelizeDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[camel(k)] = camelizeDeep(val);
    return out;
  }
  return v;
}

// ---------------------------------------------------------------- scalar codecs

const numLike = z.union([z.string(), z.number(), z.bigint()]);

/** Integer-valued inputs are taken verbatim; decimal strings/floats are scaled by `decimals`. */
function fixedToBigInt(v: string | number | bigint, decimals: number): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (Number.isInteger(v)) return BigInt(v);
    return parseDecimal(v.toFixed(Math.min(decimals, 18)), decimals);
  }
  const s = v.trim();
  if (/^-?\d+$/.test(s) || /^0x[0-9a-f]+$/i.test(s)) return toBigInt(s);
  if (/^-?\d*\.\d+$/.test(s)) return parseDecimal(s, decimals);
  return toBigInt(s);
}

const zFixed = (decimals: number) => numLike.transform((v) => fixedToBigInt(v, decimals));
const zWad = zFixed(18);
const zUsdc = zFixed(6);
const zUnits = zFixed(18);
const zRaw = zFixed(0);
const zInt = numLike.transform((v) => Number(toBigInt(v)));
const zTs = zInt;
const zAddr = z.string().transform((s) => s as Address);
const zHex = z.string().transform((s) => s as Hex);
const zStatus = z.union([z.string(), z.number()]).transform(statusFrom);
const zBool = z
  .union([z.boolean(), z.string(), z.number()])
  .transform((v) => v === true || v === "true" || v === 1 || v === "1");

/** Price → USD float. Accepts floats, decimal strings, 8-dec or 18-dec integer strings. */
function priceToNumber(v: string | number | bigint): number {
  const asBig = (b: bigint): number => {
    const abs = b < 0n ? -b : b;
    if (abs > 10n ** 15n) return Number(b) / 1e18;
    if (abs > 10n ** 10n) return Number(b) / 1e8;
    return Number(b);
  };
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return asBig(v);
  const s = v.trim();
  if (/^-?\d+$/.test(s)) return asBig(BigInt(s));
  return Number(s);
}
const zPrice = numLike.transform(priceToNumber);

/** Signed WAD (string) or plain fraction (float) → float. */
function wadOrFractionToNumber(v: string | number | bigint): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v) / 1e18;
  const s = v.trim();
  if (/^-?\d+$/.test(s)) return Number(BigInt(s)) / 1e18;
  return Number(s);
}
const zFraction = numLike.transform(wadOrFractionToNumber);

// ---------------------------------------------------------------- schemas

export const HealthSchema = z.object({
  ok: z.boolean(),
  chainId: zInt.optional(),
  headBlock: zInt.optional(),
  indexedBlock: zInt.optional(),
  seriesIndexed: zInt.optional(),
  vaultsIndexed: zInt.optional(),
  schemaVersion: zInt.nullable().optional(),
  manifestSchemaVersion: zInt.optional(),
  indexerError: z.string().nullable().optional(),
  lagBlocks: zInt.nullable().optional(),
});
export type Health = z.infer<typeof HealthSchema>;

export const ConfigSchema = z.looseObject({
  schemaVersion: zInt.optional(),
  chainId: zInt.optional(),
  aqua: z.string().optional(),
  usdc: z.string().optional(),
  feed: z.string().optional(),
  router: z.string().optional(),
  routerSourceCommit: z.string().nullable().optional(),
  routerBytecodeHash: z.string().nullable().optional(),
  seriesFactory: z.string().optional(),
  marketEngine: z.string().optional(),
  accumulator: z.string().optional(),
  programs: z.string().optional(),
  lens: z.string().optional(),
  oracle: z.string().optional(),
  deploymentBlock: zInt.optional(),
  feedDecimals: zInt.default(8),
  quoteDecimals: zInt.default(6),
  maxSamplesPerCheckpoint: zInt.default(32),
});
export type ApiConfig = z.infer<typeof ConfigSchema>;

const ParamsSchema = z.object({
  feed: zAddr,
  quoteToken: zAddr,
  start: zTs,
  expiry: zTs,
  saleEnd: zTs,
  sampleInterval: zInt,
  unitNotional: zUsdc,
  capVariance: zWad,
  anchorVariance: zWad,
  impactPerUnit: zWad,
  halfLife: zInt,
  halfSpreadBps: zInt,
  maxUnits: zUnits,
});

export const VaultStateSchema = z.object({
  vault: zAddr,
  owner: zAddr,
  balance: zUsdc.default(0n),
  locked: zUsdc.default(0n),
  free: zUsdc.default(0n),
  aquaAllowance: zRaw.default(0n),
  allowanceSufficient: zBool.default(false),
});

const PARAM_KEYS = Object.keys(ParamsSchema.shape);

/** Accept both a nested `{ params: {...} }` and a flattened summary. */
function nestParams(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const o = { ...(raw as Record<string, unknown>) };
  if (!o.params || typeof o.params !== "object") {
    if (PARAM_KEYS.some((k) => k in o)) {
      const params: Record<string, unknown> = {};
      for (const k of PARAM_KEYS) if (k in o) params[k] = o[k];
      o.params = params;
    }
  }
  if (o.seriesId !== undefined && o.id === undefined) o.id = o.seriesId;
  return o;
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;

/**
 * The backend's flat projection of the Lens state.
 *
 * Every field the Lens owns is nullable here on purpose: when the Lens is unreachable the backend
 * serves a DB-derived summary with nulls where a live read would have gone, and the UI shows an em
 * dash rather than a zero that looks like a real number.
 */
const SeriesCore = z.object({
  id: zRaw,
  writer: zAddr,
  vault: zAddr.default(ZERO_ADDR),
  receipt: zAddr,
  params: ParamsSchema,
  issueOrderHash: zHex.default("0x"),
  exitOrderHash: zHex.default("0x"),
  settlementOrderHash: zHex.default("0x"),
  status: zStatus.nullable().default(0),
  issuanceOpen: zBool.nullable().default(false),
  exitOpen: zBool.nullable().default(false),
  settleOpen: zBool.nullable().default(false),
  issueLegActive: zBool.nullable().default(false),
  exitLegActive: zBool.nullable().default(false),
  settleLegActive: zBool.nullable().default(false),
  marketVariance: zWad.nullable().default(0n),
  projectedVariance: zWad.nullable().default(0n),
  realizedVarianceSoFar: zWad.nullable().default(0n),
  bidVariance: zWad.nullable().default(0n),
  askVariance: zWad.nullable().default(0n),
  bidPerUnit: zUsdc.nullable().default(0n),
  askPerUnit: zUsdc.nullable().default(0n),
  maxPayoutPerUnit: zUsdc.nullable().default(0n),
  unitsOutstanding: zUnits.nullable().default(0n),
  unitsAvailable: zUnits.nullable().default(0n),
  lockedLiability: zUsdc.nullable().default(0n),
  finalVariance: zWad.nullable().default(0n),
  payoutPerUnit: zUsdc.nullable().default(0n),
  samplesStored: zInt.nullable().default(0),
  samplesAvailable: zInt.nullable().default(0),
  samplesTotal: zInt.nullable().default(0),
  processedThrough: zTs.nullable().default(0),
  checkpointsCurrent: zBool.nullable().default(false),
  fullyCollateralized: zBool.nullable().default(false),
  vaultState: VaultStateSchema.nullable().optional(),
  fillsCount: zInt.optional(),
  issueCount: zInt.optional(),
  exitCount: zInt.optional(),
  settleCount: zInt.optional(),
  premiumQuote: zUsdc.optional(),
  exitQuote: zUsdc.optional(),
  settlementQuote: zUsdc.optional(),
  unitsIssued: zUnits.optional(),
  unitsExited: zUnits.optional(),
  unitsSettled: zUnits.optional(),
  lastFillAt: zTs.nullable().optional(),
  source: z.string().optional(),
  lensError: z.string().nullable().optional(),
});

export type ApiLeg = "issue" | "exit" | "settle";
const zLeg = z
  .string()
  .transform((s) => {
    const v = s.toLowerCase();
    return (v === "exit" ? "exit" : v === "settle" ? "settle" : "issue") as ApiLeg;
  })
  .default("issue");

export const FillSchema = z.object({
  txHash: zHex,
  block: zInt.optional(),
  timestamp: zTs.default(0),
  seriesId: zInt.optional(),
  leg: zLeg,
  orderHash: zHex.optional(),
  makerVault: zAddr.default(ZERO_ADDR),
  taker: zAddr.default(ZERO_ADDR),
  amountIn: zRaw.default(0n),
  amountOut: zRaw.default(0n),
  units: zUnits.default(0n),
  quoteAmount: zUsdc.default(0n),
  pricePerUnit: zUsdc.default(0n),
});
export type Fill = z.infer<typeof FillSchema>;

export const CheckpointSchema = z.object({
  txHash: zHex,
  block: zInt.optional(),
  timestamp: zTs.default(0),
  fromSample: zInt.default(0),
  toSample: zInt.default(0),
  processedThrough: zTs.default(0),
  lastRoundId: z.union([z.string(), z.number(), z.bigint()]).transform(String).default("0"),
  sumSquaredReturns: zWad.default(0n),
});
export type CheckpointRow = z.infer<typeof CheckpointSchema>;

export const FinalizationSchema = z.object({
  seriesId: zInt.optional(),
  txHash: zHex,
  block: zInt.optional(),
  timestamp: zTs.default(0),
  finalVariance: zWad.default(0n),
  cappedVariance: zWad.default(0n),
  payoutPerUnit: zUsdc.default(0n),
  outstandingUnits: zUnits.default(0n),
  releasedCollateral: zUsdc.default(0n),
});
export type Finalization = z.infer<typeof FinalizationSchema>;

export const PortfolioEventSchema = z.object({
  id: zInt.default(0),
  groupId: zInt,
  eventType: z.string(),
  actor: zAddr.nullable().optional(),
  side: z.string().nullable().optional(),
  units: zUnits.default(0n),
  amount: zUsdc.default(0n),
  newOutstanding: zUnits.nullable().optional(),
  newReserve: zUsdc.nullable().optional(),
  newBuffer: zUsdc.nullable().optional(),
  blockNumber: zInt.default(0),
  txHash: zHex,
  logIndex: zInt.default(0),
  timestamp: zTs.default(0),
});
export type PortfolioEvent = z.infer<typeof PortfolioEventSchema>;

export const PortfolioCheckpointSchema = z.object({
  txHash: zHex,
  logIndex: zInt.default(0),
  block: zInt.default(0),
  timestamp: zTs.default(0),
  groupId: zInt,
  fromSample: zInt.default(0),
  toSample: zInt.default(0),
  processedThrough: zTs.default(0),
  lastRoundId: z.union([z.string(), z.number(), z.bigint()]).transform(String).default("0"),
  sumSquaredReturns: zWad.default(0n),
});
export type PortfolioCheckpoint = z.infer<typeof PortfolioCheckpointSchema>;

/**
 * One point on the market chart.
 *
 * A replica of the on-chain pricing, reconstructed from indexed fills and checkpoints, because no
 * contract stores the historical path. The executable price is always the Lens's, which the same
 * response carries in `lens` so any divergence is visible rather than hidden.
 */
export const MarketPointSchema = z.object({
  t: zTs,
  processedThrough: zTs.default(0),
  realizedVariance: zWad.default(0n),
  realizedVol: zFraction.default(0),
  marketVariance: zWad.default(0n),
  marketVol: zFraction.default(0),
  projectedVariance: zWad.default(0n),
  projectedVol: zFraction.default(0),
  bidVariance: zWad.default(0n),
  askVariance: zWad.default(0n),
  bidPerUnit: zUsdc.default(0n),
  askPerUnit: zUsdc.default(0n),
  checkpointsFresh: zBool.default(false),
});
export type MarketPoint = z.infer<typeof MarketPointSchema>;

const toVaultState = (v: z.infer<typeof VaultStateSchema> | null | undefined): VaultState => ({
  vault: v?.vault ?? ZERO_ADDR,
  owner: v?.owner ?? ZERO_ADDR,
  balance: v?.balance ?? 0n,
  locked: v?.locked ?? 0n,
  free: v?.free ?? 0n,
  aquaAllowance: v?.aquaAllowance ?? 0n,
  allowanceSufficient: v?.allowanceSufficient ?? false,
});

const toSeriesState = (s: z.infer<typeof SeriesCore>): SeriesState => ({
  id: s.id,
  writer: s.writer,
  vault: s.vault,
  receipt: s.receipt,
  params: s.params as SeriesParams,
  issueOrderHash: s.issueOrderHash,
  exitOrderHash: s.exitOrderHash,
  settlementOrderHash: s.settlementOrderHash,
  status: s.status ?? 0,
  legs: {
    issuanceOpen: s.issuanceOpen ?? false,
    exitOpen: s.exitOpen ?? false,
    settleOpen: s.settleOpen ?? false,
    issueLegActive: s.issueLegActive ?? false,
    exitLegActive: s.exitLegActive ?? false,
    settleLegActive: s.settleLegActive ?? false,
  },
  quote: {
    marketVariance: s.marketVariance ?? 0n,
    projectedVariance: s.projectedVariance ?? 0n,
    realizedVarianceSoFar: s.realizedVarianceSoFar ?? 0n,
    bidVariance: s.bidVariance ?? 0n,
    askVariance: s.askVariance ?? 0n,
    bidPerUnit: s.bidPerUnit ?? 0n,
    askPerUnit: s.askPerUnit ?? 0n,
    maxPayoutPerUnit: s.maxPayoutPerUnit ?? 0n,
  },
  unitsOutstanding: s.unitsOutstanding ?? 0n,
  unitsAvailable: s.unitsAvailable ?? 0n,
  lockedLiability: s.lockedLiability ?? 0n,
  finalVariance: s.finalVariance ?? 0n,
  payoutPerUnit: s.payoutPerUnit ?? 0n,
  oracle: {
    samplesStored: s.samplesStored ?? 0,
    samplesAvailable: s.samplesAvailable ?? 0,
    samplesTotal: s.samplesTotal ?? 0,
    processedThrough: s.processedThrough ?? 0,
    checkpointsCurrent: s.checkpointsCurrent ?? false,
  },
  fullyCollateralized: s.fullyCollateralized ?? false,
  vaultState: toVaultState(s.vaultState),
  fillsCount: s.fillsCount,
  issueCount: s.issueCount,
  exitCount: s.exitCount,
  settleCount: s.settleCount,
  premiumQuote: s.premiumQuote,
  exitQuote: s.exitQuote,
  settlementQuote: s.settlementQuote,
  unitsIssued: s.unitsIssued,
  unitsExited: s.unitsExited,
  unitsSettled: s.unitsSettled,
  lastFillAt: s.lastFillAt ?? undefined,
  source: "api",
});

export const SeriesSummarySchema = z.preprocess(nestParams, SeriesCore).transform(toSeriesState);
export const SeriesListSchema = z.array(SeriesSummarySchema);

export const SeriesDetailSchema = z
  .preprocess(
    nestParams,
    SeriesCore.extend({
      fills: z.array(FillSchema).optional(),
      checkpoints: z.array(CheckpointSchema).optional(),
      finalization: FinalizationSchema.nullable().optional(),
      orders: z.array(z.object({ orderHash: zHex, leg: zLeg })).optional(),
    }),
  )
  .transform((d) => ({
    state: toSeriesState(d),
    fills: d.fills ?? [],
    checkpoints: d.checkpoints ?? [],
    finalization: d.finalization ?? undefined,
    orders: d.orders ?? [],
  }));
export type SeriesDetail = z.infer<typeof SeriesDetailSchema>;

export const MarketSchema = z.object({
  seriesId: zInt.optional(),
  from: zTs.default(0),
  to: zTs.default(0),
  start: zTs.default(0),
  expiry: zTs.default(0),
  saleEnd: zTs.default(0),
  sampleInterval: zInt.default(0),
  capVariance: zWad.default(0n),
  maxPayoutPerUnit: zUsdc.nullable().optional(),
  points: z.array(MarketPointSchema).default([]),
  lens: z.preprocess(nestParams, SeriesCore).transform(toSeriesState).nullable().optional(),
});
export type MarketResponse = z.infer<typeof MarketSchema>;

export const SampleSchema = z.object({
  t: zTs,
  price: zPrice,
  roundId: z.union([z.string(), z.number(), z.bigint()]).transform(String).nullable().optional(),
  phase: zInt.nullable().optional(),
  logReturn: zFraction.nullable().optional(),
});
export type Sample = z.infer<typeof SampleSchema>;

export const VarianceSchema = z.object({
  samples: z.array(SampleSchema).default([]),
  rvSoFar: zWad.default(0n),
  volSoFar: zWad.optional(),
  samplesElapsed: zInt.default(0),
  samplesTotal: zInt.default(0),
  phasesUsed: z.array(zInt).default([]),
  chainRealizedVarianceSoFar: zWad.nullable().optional(),
  chainFinalVariance: zWad.nullable().optional(),
  chainSamplesStored: zInt.nullable().optional(),
  chainSamplesAvailable: zInt.nullable().optional(),
  chainCheckpointsCurrent: zBool.nullable().optional(),
});
export type VarianceResponse = z.infer<typeof VarianceSchema>;

export const VaultEventSchema = z.object({
  txHash: zHex,
  timestamp: zTs.default(0),
  kind: z.string(),
  actor: zAddr.nullable().optional(),
  amount: zUsdc.nullable().optional(),
  balance: zUsdc.nullable().optional(),
  locked: zUsdc.nullable().optional(),
  reference: z.string().nullable().optional(),
});
export type VaultEvent = z.infer<typeof VaultEventSchema>;

export const VaultDetailSchema = z.object({
  requested: z.string(),
  vault: zAddr,
  exists: zBool.default(false),
  state: VaultStateSchema.nullable().optional(),
  indexed: z
    .object({
      writer: zAddr,
      totalDeposited: zUsdc.optional(),
      deposited: zUsdc.optional(),
      withdrawn: zUsdc.optional(),
      createdAt: zTs.optional(),
    })
    .nullable()
    .optional(),
  series: z
    .array(
      z.object({
        id: zInt,
        receipt: zAddr,
        expiry: zTs,
        saleEnd: zTs.optional(),
        maxUnits: zUnits.optional(),
        unitNotional: zUsdc.optional(),
        capVariance: zWad.optional(),
        issuanceStoppedAt: zTs.nullable().optional(),
        closedAt: zTs.nullable().optional(),
      }),
    )
    .default([]),
  events: z.array(VaultEventSchema).default([]),
});
export type VaultDetail = z.infer<typeof VaultDetailSchema>;

/**
 * A holder's indexed position.
 *
 * `costBasisKnown` is false when this address has no indexed buys — a receipt that arrived by plain
 * ERC-20 transfer has no entry price, and showing an invented one would be worse than showing a dash.
 */
export const PositionSchema = z.object({
  seriesId: zInt,
  receipt: zAddr,
  expiry: zTs.default(0),
  unitsBought: zUnits.default(0n),
  unitsExited: zUnits.default(0n),
  unitsSettled: zUnits.default(0n),
  indexedUnits: zUnits.default(0n),
  indexedCost: zUsdc.default(0n),
  indexedEntryPerUnit: zUsdc.nullable().optional(),
  exitProceeds: zUsdc.default(0n),
  settlementProceeds: zUsdc.default(0n),
  costBasisKnown: zBool.default(false),
  fills: zInt.default(0),
});
export type Position = z.infer<typeof PositionSchema>;

export const PortfolioSchema = z.object({
  holder: z.string(),
  positions: z.array(PositionSchema).default([]),
});
export type PortfolioResponse = z.infer<typeof PortfolioSchema>;

export const TrailingSchema = z
  .object({
    rv: zWad,
    vol: zWad.optional(),
    samples: zInt.default(0),
    from: zTs.default(0),
    to: zTs.default(0),
  })
  .transform((t) => ({ ...t, vol: t.vol ?? sqrtWad(t.rv) }));
export type Trailing = z.infer<typeof TrailingSchema>;

export const FeedPointSchema = z.object({ t: zTs, price: zPrice });
export const FeedHistorySchema = z.array(FeedPointSchema);
export type FeedPoint = z.infer<typeof FeedPointSchema>;

export const LvrSchema = z.object({
  sigma: zFraction.default(0),
  expectedLvrUsd: numLike.transform((v) => (typeof v === "number" ? v : Number(v))).default(0),
  hedgeUnitsFor: z.record(z.string(), zUnits).default({}),
  caveat: z.string().optional(),
});
export type LvrResponse = z.infer<typeof LvrSchema>;

// ---------------------------------------------------------------- fetch

interface Parser<T> {
  safeParse(data: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}

export async function apiGet<T>(
  path: string,
  schema: Parser<T>,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = new URL(env.apiUrl + path);
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url.toString(), { cache: "no-store", headers: { accept: "application/json" } });
  } catch {
    throw new ApiError(0, "API offline");
  }
  if (!res.ok) {
    let msg = res.statusText || `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg);
  }
  const json: unknown = await res.json();
  const parsed = schema.safeParse(camelizeDeep(json));
  if (!parsed.success) {
    const why = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.map(String).join(".")}: ${i.message}`)
      .join("; ");
    throw new ApiError(res.status, `Unexpected API shape at ${path}: ${why}`);
  }
  return parsed.data;
}

export const fetchHealth = () => apiGet("/health", HealthSchema);
export const fetchConfig = () => apiGet("/config", ConfigSchema);
export const fetchSeriesList = () => apiGet("/series", SeriesListSchema);
export const fetchSeriesDetail = (id: bigint) => apiGet(`/series/${id}`, SeriesDetailSchema);
export const fetchFills = (id: bigint, limit = 200, offset = 0) =>
  apiGet(`/series/${id}/fills`, z.array(FillSchema), { limit, offset });
export const fetchVariance = (id: bigint) => apiGet(`/series/${id}/variance`, VarianceSchema);
export const fetchMarket = (id: bigint, opts: { from?: number; to?: number; points?: number } = {}) =>
  apiGet(`/series/${id}/market`, MarketSchema, opts);
export const fetchVault = (address: string) => apiGet(`/vault/${address}`, VaultDetailSchema);
export const fetchPortfolio = (address: string) => apiGet(`/portfolio/${address}`, PortfolioSchema);
export type TrailingWindow = "1d" | "7d" | "30d";
export const WINDOW_SECONDS: Record<TrailingWindow, number> = { "1d": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400 };
/** Keep every request within the API's 256-sample contract and avoid needless cold-cache work. */
export const WINDOW_TRAILING_INTERVAL: Record<TrailingWindow, number> = { "1d": 3_600, "7d": 7_200, "30d": 86_400 };
export const WINDOW_SPARK_INTERVAL: Record<TrailingWindow, number> = { "1d": 1_800, "7d": 7_200, "30d": 86_400 };
export const fetchTrailing = (window: TrailingWindow, interval = WINDOW_TRAILING_INTERVAL[window]) =>
  apiGet("/variance/trailing", TrailingSchema, { window, interval });
export const fetchFeedHistory = (from: number, to: number, interval: number) =>
  apiGet("/feed/history", FeedHistorySchema, { from, to, interval });
export const fetchLvr = (poolValueUsd: number, horizonDays: number, window: TrailingWindow = "7d") =>
  apiGet("/lvr", LvrSchema, { pool_value_usd: poolValueUsd, horizon_days: horizonDays, window });
export const fetchPairsEvents = (id: bigint, limit = 200) =>
  apiGet(`/pairs/${id}/events`, z.array(PortfolioEventSchema), { limit });
export const fetchPairsCheckpoints = (id: bigint) =>
  apiGet(`/pairs/${id}/checkpoints`, z.array(PortfolioCheckpointSchema));

// ---------------------------------------------------------------- hooks

const livePolling = { retry: 1, refetchOnWindowFocus: true } as const;
const quiet = { retry: 0, refetchOnWindowFocus: true } as const;

export function useApiHealth() {
  return useQuery({ queryKey: ["api", "health"], queryFn: fetchHealth, refetchInterval: 10_000, staleTime: 5_000, ...quiet });
}
/** true / false / undefined (still probing). */
export function useApiOnline(): boolean | undefined {
  const q = useApiHealth();
  if (q.data) return q.data.ok;
  if (q.isError) return false;
  return undefined;
}
export function useApiConfig() {
  return useQuery({ queryKey: ["api", "config"], queryFn: fetchConfig, staleTime: 60_000, ...quiet });
}
export function useApiSeries(enabled = true) {
  return useQuery({ queryKey: ["api", "series"], queryFn: fetchSeriesList, refetchInterval: 8_000, enabled, ...quiet });
}
export function useApiSeriesDetail(id: bigint | undefined) {
  return useQuery({
    queryKey: ["api", "series", id?.toString() ?? "", "detail"],
    queryFn: () => fetchSeriesDetail(id as bigint),
    enabled: id !== undefined,
    refetchInterval: 8_000,
    ...quiet,
  });
}
export function useFills(id: bigint | undefined) {
  return useQuery({
    queryKey: ["api", "series", id?.toString() ?? "", "fills"],
    queryFn: () => fetchFills(id as bigint),
    enabled: id !== undefined,
    refetchInterval: 8_000,
    ...quiet,
  });
}
export function usePairsEvents(id: bigint | undefined, limit = 200) {
  return useQuery({
    queryKey: ["api", "pairs", id?.toString() ?? "", "events", limit],
    queryFn: () => fetchPairsEvents(id as bigint, limit),
    enabled: id !== undefined,
    refetchInterval: 6_000,
    ...quiet,
  });
}
export function usePairsCheckpoints(id: bigint | undefined) {
  return useQuery({
    queryKey: ["api", "pairs", id?.toString() ?? "", "checkpoints"],
    queryFn: () => fetchPairsCheckpoints(id as bigint),
    enabled: id !== undefined,
    refetchInterval: 8_000,
    ...quiet,
  });
}
/** The market chart: realized vol, the market's own quote vol, and the executable bid/ask band. */
export function useMarket(id: bigint | undefined, points = 200) {
  return useQuery({
    queryKey: ["api", "series", id?.toString() ?? "", "market", points],
    queryFn: () => fetchMarket(id as bigint, { points }),
    enabled: id !== undefined,
    refetchInterval: 15_000,
    ...quiet,
  });
}

export function useVault(address: string | undefined) {
  return useQuery({
    queryKey: ["api", "vault", address ?? ""],
    queryFn: () => fetchVault(address as string),
    enabled: !!address,
    refetchInterval: 10_000,
    ...quiet,
  });
}

export function usePortfolio(address: string | undefined) {
  return useQuery({
    queryKey: ["api", "portfolio", address ?? ""],
    queryFn: () => fetchPortfolio(address as string),
    enabled: !!address,
    refetchInterval: 3_000,
    ...livePolling,
  });
}
export function useVariance(id: bigint | undefined) {
  return useQuery({
    queryKey: ["api", "series", id?.toString() ?? "", "variance"],
    queryFn: () => fetchVariance(id as bigint),
    enabled: id !== undefined,
    refetchInterval: 15_000,
    ...quiet,
  });
}
export function useTrailing(window: TrailingWindow, interval = WINDOW_TRAILING_INTERVAL[window]) {
  return useQuery({
    queryKey: ["api", "trailing", window, interval],
    queryFn: () => fetchTrailing(window, interval),
    refetchInterval: 30_000,
    staleTime: 15_000,
    ...quiet,
  });
}

/** Feed history for a trailing window; `now` is bucketed to 5 minutes to keep query keys stable. */
export function useFeedWindow(window: TrailingWindow, enabled = true) {
  const [to, setTo] = useState(0);
  useEffect(() => {
    const update = () => setTo(Math.floor(Date.now() / 300_000) * 300);
    const initial = globalThis.window.setTimeout(update, 0);
    const timer = globalThis.window.setInterval(update, 300_000);
    return () => {
      globalThis.window.clearTimeout(initial);
      globalThis.window.clearInterval(timer);
    };
  }, []);
  const from = to - WINDOW_SECONDS[window];
  const interval = WINDOW_SPARK_INTERVAL[window];
  return useQuery({
    queryKey: ["api", "feed", from, to, interval],
    queryFn: () => fetchFeedHistory(from, to, interval),
    enabled: enabled && to > 0,
    staleTime: 60_000,
    ...quiet,
  });
}
export function useFeedHistory(from: number | undefined, to: number | undefined, interval: number) {
  return useQuery({
    queryKey: ["api", "feed", from ?? 0, to ?? 0, interval],
    queryFn: () => fetchFeedHistory(from as number, to as number, interval),
    enabled: from !== undefined && to !== undefined && to > from,
    staleTime: 60_000,
    ...quiet,
  });
}
export function useLvr(poolValueUsd: number, horizonDays: number, window: TrailingWindow, enabled = true) {
  return useQuery({
    queryKey: ["api", "lvr", poolValueUsd, horizonDays, window],
    queryFn: () => fetchLvr(poolValueUsd, horizonDays, window),
    enabled: enabled && poolValueUsd > 0 && horizonDays > 0,
    staleTime: 15_000,
    ...quiet,
  });
}
