/** viem reads against the Lens, controller, accumulator, programs and tokens, plus react-query hooks. */
"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createPublicClient, http, type Address, type ContractFunctionReturnType, type Hex } from "viem";
import { activeChain } from "@/config/chains";
import { env } from "@/config/env";
import {
  ADDR,
  FEED_ABI,
  accumulatorAbi,
  aquaAbi,
  controllerAbi,
  erc20Abi,
  isDeployed,
  lensAbi,
  programsAbi,
  vaultAbi,
  type Order,
} from "./contracts";
import { Leg, statusFrom, type SeriesState, type VaultState } from "./series";

export const publicClient = createPublicClient({
  chain: activeChain,
  transport: http(env.rpcUrl, { batch: true, retryCount: 1, timeout: 10_000 }),
});

type LensState = ContractFunctionReturnType<typeof lensAbi, "view", "state">;
type LensVaultState = ContractFunctionReturnType<typeof lensAbi, "view", "vaultState">;

export function fromLensVaultState(v: LensVaultState): VaultState {
  return {
    vault: v.vault,
    owner: v.owner,
    balance: v.balance,
    locked: v.locked,
    free: v.free,
    aquaAllowance: v.aquaAllowance,
    allowanceSufficient: v.allowanceSufficient,
  };
}

export function fromLensState(s: LensState): SeriesState {
  return {
    id: s.id,
    writer: s.writer,
    vault: s.vault,
    receipt: s.receipt,
    params: {
      feed: s.params.feed,
      quoteToken: s.params.quoteToken,
      start: Number(s.params.start),
      expiry: Number(s.params.expiry),
      saleEnd: Number(s.params.saleEnd),
      sampleInterval: Number(s.params.sampleInterval),
      unitNotional: s.params.unitNotional,
      capVariance: s.params.capVariance,
      anchorVariance: s.params.anchorVariance,
      impactPerUnit: s.params.impactPerUnit,
      halfLife: Number(s.params.halfLife),
      halfSpreadBps: Number(s.params.halfSpreadBps),
      maxUnits: s.params.maxUnits,
    },
    issueOrderHash: s.issueOrderHash,
    exitOrderHash: s.exitOrderHash,
    settlementOrderHash: s.settlementOrderHash,
    status: statusFrom(s.status),
    legs: {
      issuanceOpen: s.legs.issuanceOpen,
      exitOpen: s.legs.exitOpen,
      settleOpen: s.legs.settleOpen,
      issueLegActive: s.legs.issueLegActive,
      exitLegActive: s.legs.exitLegActive,
      settleLegActive: s.legs.settleLegActive,
    },
    quote: {
      marketVariance: s.quote.marketVariance,
      projectedVariance: s.quote.projectedVariance,
      realizedVarianceSoFar: s.quote.realizedVarianceSoFar,
      bidVariance: s.quote.bidVariance,
      askVariance: s.quote.askVariance,
      bidPerUnit: s.quote.bidPerUnit,
      askPerUnit: s.quote.askPerUnit,
      maxPayoutPerUnit: s.quote.maxPayoutPerUnit,
    },
    unitsOutstanding: s.unitsOutstanding,
    unitsAvailable: s.unitsAvailable,
    lockedLiability: s.lockedLiability,
    finalVariance: s.finalVariance,
    payoutPerUnit: s.payoutPerUnit,
    oracle: {
      samplesStored: Number(s.oracle.samplesStored),
      samplesAvailable: Number(s.oracle.samplesAvailable),
      samplesTotal: Number(s.oracle.samplesTotal),
      processedThrough: Number(s.oracle.processedThrough),
      checkpointsCurrent: s.oracle.checkpointsCurrent,
    },
    fullyCollateralized: s.fullyCollateralized,
    vaultState: fromLensVaultState(s.vaultState),
    source: "chain",
  };
}

// ---------------------------------------------------------------- reads

export const readSeriesCount = (): Promise<bigint> =>
  publicClient.readContract({ address: ADDR.seriesFactory, abi: controllerAbi, functionName: "seriesCount" });

export async function readState(id: bigint): Promise<SeriesState> {
  const s = await publicClient.readContract({ address: ADDR.lens, abi: lensAbi, functionName: "state", args: [id] });
  return fromLensState(s);
}

/** All series. Tries `states(0, count)` and falls back to per-id `state(i)`. */
export async function readAllStates(): Promise<SeriesState[]> {
  const count = await readSeriesCount();
  if (count === 0n) return [];
  try {
    const list = await publicClient.readContract({
      address: ADDR.lens,
      abi: lensAbi,
      functionName: "states",
      args: [0n, count],
    });
    const mapped = list.map(fromLensState).filter((s) => s.id >= 1n && s.id <= count);
    if (BigInt(mapped.length) === count) return mapped;
  } catch {
    /* fall through to per-id reads */
  }
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  return Promise.all(ids.map(readState));
}

// ---- quotes. Every one of these is the same engine the router calls, so a figure on screen and the
// ---- fill a taker gets cannot disagree.

export const quoteIssueExactIn = async (id: bigint, quoteIn: bigint): Promise<{ units: bigint; premium: bigint }> => {
  const [units, premium] = await publicClient.readContract({
    address: ADDR.lens,
    abi: lensAbi,
    functionName: "quoteIssueExactIn",
    args: [id, quoteIn],
  });
  return { units, premium };
};

export const quoteIssueExactOut = async (
  id: bigint,
  units: bigint,
): Promise<{ filledUnits: bigint; premium: bigint }> => {
  const [filledUnits, premium] = await publicClient.readContract({
    address: ADDR.lens,
    abi: lensAbi,
    functionName: "quoteIssueExactOut",
    args: [id, units],
  });
  return { filledUnits, premium };
};

export const quoteExitExactIn = async (
  id: bigint,
  units: bigint,
): Promise<{ filledUnits: bigint; quoteOut: bigint }> => {
  const [filledUnits, quoteOut] = await publicClient.readContract({
    address: ADDR.lens,
    abi: lensAbi,
    functionName: "quoteExitExactIn",
    args: [id, units],
  });
  return { filledUnits, quoteOut };
};

export const quoteSettleExactIn = async (
  id: bigint,
  units: bigint,
): Promise<{ filledUnits: bigint; quoteOut: bigint }> => {
  const [filledUnits, quoteOut] = await publicClient.readContract({
    address: ADDR.lens,
    abi: lensAbi,
    functionName: "quoteSettleExactIn",
    args: [id, units],
  });
  return { filledUnits, quoteOut };
};

export const legDirection = (id: bigint, leg: Leg): Promise<boolean> =>
  publicClient.readContract({ address: ADDR.lens, abi: lensAbi, functionName: "legDirection", args: [id, leg] });

/**
 * `allowPartialFill` is what makes the engine's clamps reachable: without it TakerTraits requires
 * `takerAmount == amountIn/amountOut`, so a fill clamped to receipt inventory, the vault's free
 * collateral, the cap, outstanding units or released liability reverts instead of filling small. With
 * it on the threshold is a limit *rate* — TakerTraits pro-rates it by the fraction filled — so it must
 * be quoted against the taker amount sent, not against the clamped result.
 */
export const buildTakerData = (
  taker: Address,
  isExactIn: boolean,
  isAToB: boolean,
  threshold: bigint,
  deadline: number,
  allowPartialFill = false,
): Promise<Hex> =>
  publicClient.readContract({
    address: ADDR.lens,
    abi: lensAbi,
    functionName: "buildTakerData",
    args: [taker, isExactIn, isAToB, threshold, deadline, allowPartialFill],
  });

export const lvrHedgeUnits = (id: bigint, poolValueQuote: bigint, horizonSeconds: number): Promise<bigint> =>
  publicClient.readContract({
    address: ADDR.lens,
    abi: lensAbi,
    functionName: "lvrHedgeUnits",
    args: [id, poolValueQuote, horizonSeconds],
  });

// ---- vaults

export async function readVaultState(vault: Address): Promise<VaultState> {
  const v = await publicClient.readContract({
    address: ADDR.lens,
    abi: lensAbi,
    functionName: "vaultState",
    args: [vault],
  });
  return fromLensVaultState(v);
}

/**
 * A writer's vault, or the address the one they create will have.
 *
 * The address is a pure function of the deployer's, so the writer page can show it before anything is
 * deployed — which is what lets "create or load your vault" be one step instead of a branch.
 */
export async function readWriterVault(
  writer: Address,
): Promise<{ vault: Address; exists: boolean; state: VaultState }> {
  const [vault, exists, vs] = await publicClient.readContract({
    address: ADDR.lens,
    abi: lensAbi,
    functionName: "writerVault",
    args: [writer],
  });
  return { vault, exists, state: fromLensVaultState(vs) };
}

export const readVaultLocked = (vault: Address): Promise<bigint> =>
  publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "lockedQuote" });

// ---- orders and programs

export async function readOrders(id: bigint): Promise<{ issue: Order; exit: Order; settlement: Order }> {
  const [issue, exit, settlement] = await publicClient.readContract({
    address: ADDR.programs,
    abi: programsAbi,
    functionName: "orders",
    args: [id],
  });
  return { issue: { ...issue }, exit: { ...exit }, settlement: { ...settlement } };
}

export const readOrder = async (id: bigint, leg: Leg): Promise<Order> => {
  const o = await publicClient.readContract({
    address: ADDR.programs,
    abi: programsAbi,
    functionName: "order",
    args: [id, leg],
  });
  return { ...o };
};

export interface ShipPlan {
  /** ISSUE, EXIT, SETTLE, in that order. */
  strategies: readonly Hex[];
  tokens: readonly Address[];
  amounts: readonly (readonly bigint[])[];
}
export async function readShipPlan(id: bigint): Promise<ShipPlan> {
  const [strategies, tokens, amounts] = await publicClient.readContract({
    address: ADDR.programs,
    abi: programsAbi,
    functionName: "shipPlan",
    args: [id],
  });
  return { strategies, tokens, amounts };
}

export const readProgram = (id: bigint, leg: Leg): Promise<Hex> =>
  publicClient.readContract({ address: ADDR.programs, abi: programsAbi, functionName: "program", args: [id, leg] });

// ---- accumulator

export interface CheckpointProgress {
  stored: number;
  available: number;
  total: number;
}
export async function readCheckpointProgress(id: bigint): Promise<CheckpointProgress> {
  const [stored, available, total] = await publicClient.readContract({
    address: ADDR.accumulator,
    abi: accumulatorAbi,
    functionName: "progress",
    args: [id],
  });
  return { stored: Number(stored), available: Number(available), total: Number(total) };
}

export const readMaxSamplesPerCheckpoint = (): Promise<number> =>
  publicClient
    .readContract({ address: ADDR.accumulator, abi: accumulatorAbi, functionName: "MAX_SAMPLES_PER_CALL" })
    .then(Number);

// ---- tokens and feed

export const erc20BalanceOf = (token: Address, owner: Address): Promise<bigint> =>
  publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
export const erc20Allowance = (token: Address, owner: Address, spender: Address): Promise<bigint> =>
  publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
export async function erc20Meta(token: Address): Promise<{ symbol: string; decimals: number; name: string }> {
  const [symbol, decimals, name] = await Promise.all([
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
  ]);
  return { symbol, decimals, name };
}
export const readReceiptBalances = (owner: Address, receipts: Address[]): Promise<bigint[]> =>
  Promise.all(receipts.map((r) => erc20BalanceOf(r, owner)));

export async function aquaRawBalance(maker: Address, strategyHash: Hex, token: Address): Promise<bigint> {
  const [balance] = await publicClient.readContract({
    address: ADDR.aqua,
    abi: aquaAbi,
    functionName: "rawBalances",
    args: [maker, ADDR.router, strategyHash, token],
  });
  return balance;
}

export async function readFeedLatest(): Promise<{ price: number; updatedAt: number; answer: bigint; decimals: number }> {
  const [[, answer, , updatedAt], decimals] = await Promise.all([
    publicClient.readContract({ address: ADDR.feed, abi: FEED_ABI, functionName: "latestRoundData" }),
    publicClient.readContract({ address: ADDR.feed, abi: FEED_ABI, functionName: "decimals" }),
  ]);
  return { answer, decimals, updatedAt: Number(updatedAt), price: Number(answer) / 10 ** decimals };
}

// ---------------------------------------------------------------- hooks

const livePolling = { retry: 1, refetchOnWindowFocus: true } as const;
const quiet = { retry: 0, refetchOnWindowFocus: true } as const;
const k = (v: bigint | undefined) => (v === undefined ? "" : v.toString());

export function useRpcStatus() {
  return useQuery({
    queryKey: ["rpc", "block", env.rpcUrl],
    queryFn: async () => {
      const b = await publicClient.getBlock({ blockTag: "latest" });
      return { number: b.number, timestamp: Number(b.timestamp) };
    },
    refetchInterval: 6_000,
    staleTime: 3_000,
    ...livePolling,
  });
}

/** true / false / undefined (probing). */
export function useRpcOnline(): boolean | undefined {
  const q = useRpcStatus();
  if (q.data) return true;
  if (q.isError) return false;
  return undefined;
}

export function useChainSeries(enabled = true) {
  return useQuery({
    queryKey: ["chain", "series"],
    queryFn: readAllStates,
    enabled: isDeployed && enabled,
    refetchInterval: 3_000,
    ...livePolling,
  });
}

export function useChainSeriesState(id: bigint | undefined) {
  return useQuery({
    queryKey: ["chain", "series", k(id)],
    queryFn: () => readState(id as bigint),
    enabled: isDeployed && id !== undefined,
    refetchInterval: 3_000,
    ...livePolling,
  });
}

export function useQuoteIssueExactIn(id: bigint | undefined, quoteIn: bigint | null) {
  return useQuery({
    queryKey: ["chain", "quoteIssueIn", k(id), quoteIn?.toString() ?? ""],
    queryFn: () => quoteIssueExactIn(id as bigint, quoteIn as bigint),
    enabled: isDeployed && id !== undefined && quoteIn !== null && quoteIn > 0n,
    refetchInterval: 4_000,
    ...livePolling,
  });
}

export function useQuoteIssueExactOut(id: bigint | undefined, units: bigint | null) {
  return useQuery({
    queryKey: ["chain", "quoteIssueOut", k(id), units?.toString() ?? ""],
    queryFn: () => quoteIssueExactOut(id as bigint, units as bigint),
    enabled: isDeployed && id !== undefined && units !== null && units > 0n,
    refetchInterval: 4_000,
    ...livePolling,
  });
}

export function useQuoteExit(id: bigint | undefined, units: bigint | null, enabled = true) {
  return useQuery({
    queryKey: ["chain", "quoteExit", k(id), units?.toString() ?? ""],
    queryFn: () => quoteExitExactIn(id as bigint, units as bigint),
    enabled: enabled && isDeployed && id !== undefined && units !== null && units > 0n,
    refetchInterval: 4_000,
    ...livePolling,
  });
}

export function useQuoteSettle(id: bigint | undefined, units: bigint | null, enabled = true) {
  return useQuery({
    queryKey: ["chain", "quoteSettle", k(id), units?.toString() ?? ""],
    queryFn: () => quoteSettleExactIn(id as bigint, units as bigint),
    enabled: enabled && isDeployed && id !== undefined && units !== null && units > 0n,
    refetchInterval: 5_000,
    ...livePolling,
  });
}

export function useOrders(id: bigint | undefined) {
  return useQuery({
    queryKey: ["chain", "orders", k(id)],
    queryFn: () => readOrders(id as bigint),
    enabled: isDeployed && id !== undefined,
    staleTime: Infinity,
    ...quiet,
  });
}

export function useWriterVault(writer: Address | undefined) {
  return useQuery({
    queryKey: ["chain", "writerVault", writer ?? ""],
    queryFn: () => readWriterVault(writer as Address),
    enabled: isDeployed && !!writer,
    refetchInterval: 3_000,
    ...livePolling,
  });
}

export function useCheckpointProgress(id: bigint | undefined) {
  return useQuery({
    queryKey: ["chain", "checkpoints", k(id)],
    queryFn: () => readCheckpointProgress(id as bigint),
    enabled: isDeployed && id !== undefined,
    refetchInterval: 3_000,
    ...livePolling,
  });
}

export function useMaxSamplesPerCheckpoint() {
  return useQuery({
    queryKey: ["chain", "maxSamples", ADDR.accumulator],
    queryFn: readMaxSamplesPerCheckpoint,
    enabled: isDeployed,
    staleTime: Infinity,
    ...quiet,
  });
}

export function useTokenBalance(token: Address | undefined, owner: Address | undefined) {
  return useQuery({
    queryKey: ["chain", "balance", token ?? "", owner ?? ""],
    queryFn: () => erc20BalanceOf(token as Address, owner as Address),
    enabled: !!token && !!owner && !/^0x0{40}$/.test(token),
    refetchInterval: 3_000,
    ...livePolling,
  });
}

export function useAllowance(token: Address | undefined, owner: Address | undefined, spender: Address | undefined) {
  return useQuery({
    queryKey: ["chain", "allowance", token ?? "", owner ?? "", spender ?? ""],
    queryFn: () => erc20Allowance(token as Address, owner as Address, spender as Address),
    enabled: !!token && !!owner && !!spender && !/^0x0{40}$/.test(token),
    refetchInterval: 3_000,
    ...livePolling,
  });
}

export function useReceiptBalances(owner: Address | undefined, list: SeriesState[] | undefined) {
  const receipts = (list ?? []).map((s) => s.receipt);
  return useQuery({
    queryKey: ["chain", "receiptBalances", owner ?? "", receipts.join(",")],
    queryFn: async () => {
      const bals = await readReceiptBalances(owner as Address, receipts);
      const out = new Map<string, bigint>();
      receipts.forEach((r, i) => out.set(r.toLowerCase(), bals[i]));
      return out;
    },
    enabled: !!owner && receipts.length > 0,
    refetchInterval: 3_000,
    ...livePolling,
  });
}

export function useFeedLatest() {
  return useQuery({
    queryKey: ["chain", "feed", ADDR.feed],
    queryFn: readFeedLatest,
    enabled: !/^0x0{40}$/.test(ADDR.feed),
    refetchInterval: 8_000,
    ...livePolling,
  });
}

/**
 * Trailing realized variance straight from the Lens — the fallback the `/write` price anchor uses when
 * the backend is down, so a dead API can never leave the form unpriceable. `end` is interval-aligned
 * and the window is a whole number of intervals, so the sample grid is exact.
 */
export async function readTrailingVariance(
  windowSeconds: number,
  interval = 3600,
): Promise<{ rv: bigint; samples: number }> {
  const end = Math.floor(Date.now() / 1000 / interval) * interval;
  const [rv, samples] = await publicClient.readContract({
    address: ADDR.lens,
    abi: lensAbi,
    functionName: "realizedVariance",
    args: [ADDR.feed, end - windowSeconds, end, interval],
  });
  return { rv, samples: Number(samples) };
}

export function useTrailingOnchain(windowSeconds: number, interval = 3600, enabled = true) {
  const [bucket, setBucket] = useState(0);
  useEffect(() => {
    const update = () => setBucket(Math.floor(Date.now() / 1000 / interval));
    const initial = window.setTimeout(update, 0);
    const timer = window.setInterval(update, interval * 1000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [interval]);
  return useQuery({
    queryKey: ["chain", "trailingRv", windowSeconds, interval, bucket],
    queryFn: () => readTrailingVariance(windowSeconds, interval),
    enabled: enabled && isDeployed && bucket > 0,
    staleTime: 60_000,
    ...quiet,
  });
}

export function useLvrHedgeUnits(id: bigint | undefined, poolValueQuote: bigint, horizonSeconds: number) {
  return useQuery({
    queryKey: ["chain", "lvrHedge", k(id), poolValueQuote.toString(), horizonSeconds],
    queryFn: () => lvrHedgeUnits(id as bigint, poolValueQuote, horizonSeconds),
    enabled: isDeployed && id !== undefined && poolValueQuote > 0n && horizonSeconds > 0,
    ...quiet,
  });
}
