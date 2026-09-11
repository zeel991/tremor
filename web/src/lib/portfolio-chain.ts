/**
 * viem reads against `TremorPortfolioMarket`, plus on-chain quote wrappers through the same official
 * router the v2 series legs use, and react-query hooks.
 *
 * The portfolio market has no Lens: `groupView`/`groupParams` are the executable authority, and every
 * price shown next to a signable button comes from `router.quote` against the group's own order —
 * the identical arithmetic a swap runs — never from the client-side fixed-quote helpers.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { zeroAddress, type Address, type ContractFunctionReturnType } from "viem";
import {
  ADDR,
  accumulatorAbi,
  vaultAbi,
  isPortfolioDeployed,
  portfolioMarketAbi,
  routerAbi,
  type Order,
  PORTFOLIO_MARKET_ABI_HR,
} from "./contracts";
import { buildTakerData, publicClient } from "./chain";
import {
  exitMode,
  issueMode,
  settleMode,
  type GroupParams,
  type GroupState,
  type PMode,
  type Side,
} from "./portfolio";

type WireGroupView = ContractFunctionReturnType<typeof PORTFOLIO_MARKET_ABI_HR, "view", "groupView">;
type WireGroupParams = ContractFunctionReturnType<typeof PORTFOLIO_MARKET_ABI_HR, "view", "groupParams">;

export function fromGroupParams(p: WireGroupParams): GroupParams {
  return {
    feed: p.feed,
    quoteToken: p.quoteToken,
    start: Number(p.start),
    expiry: Number(p.expiry),
    saleEnd: Number(p.saleEnd),
    sampleInterval: Number(p.sampleInterval),
    capVariance: p.capVariance,
    capPayoutPerUnit: p.capPayoutPerUnit,
    maxUnitsPerSide: p.maxUnitsPerSide,
    askHigh: p.askHigh,
    bidHigh: p.bidHigh,
    askCalm: p.askCalm,
    bidCalm: p.bidCalm,
  };
}

export function fromGroupView(id: bigint, v: WireGroupView, params: GroupParams): GroupState {
  return {
    id,
    writer: v.writer,
    vault: v.vault,
    highReceipt: v.highReceipt,
    calmReceipt: v.calmReceipt,
    highOutstanding: v.highOutstanding,
    calmOutstanding: v.calmOutstanding,
    reserveLocked: v.reserveLocked,
    exitBuffer: v.exitBuffer,
    standaloneCaps: v.standaloneCaps,
    finalized: v.finalized,
    finalVariance: v.finalVariance,
    xWad: v.xWad,
    highPpu: v.highPpu,
    calmPpu: v.calmPpu,
    params,
    source: "chain",
  };
}

// ---------------------------------------------------------------- reads

const market = () => ({ address: ADDR.portfolioMarket, abi: portfolioMarketAbi });

export const readGroupCount = (): Promise<bigint> =>
  publicClient.readContract({ ...market(), functionName: "groupCount" });

export async function readGroupParams(id: bigint): Promise<GroupParams> {
  const p = await publicClient.readContract({ ...market(), functionName: "groupParams", args: [id] });
  return fromGroupParams(p);
}

export async function readGroupState(id: bigint): Promise<GroupState> {
  const [v, p] = await Promise.all([
    publicClient.readContract({ ...market(), functionName: "groupView", args: [id] }),
    readGroupParams(id),
  ]);
  return fromGroupView(id, v, p);
}

/** All groups, per-id. Group ids are 1-based, matching the series controller. */
export async function readAllGroupStates(): Promise<GroupState[]> {
  const count = await readGroupCount();
  if (count === 0n) return [];
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  return Promise.all(ids.map(readGroupState));
}

export async function readOrderFor(id: bigint, mode: PMode): Promise<Order> {
  const o = await publicClient.readContract({ ...market(), functionName: "orderFor", args: [id, mode] });
  return { ...o };
}

export const readPortfolioVaultOf = (writer: Address): Promise<Address> =>
  publicClient.readContract({ ...market(), functionName: "vaultOf", args: [writer] });

// ---------------------------------------------------------------- on-chain quotes via the router

/**
 * `isAToB` for a portfolio leg is fixed by token-address ordering, the same rule the order builder
 * uses: ISSUE takes USDC in (A→B iff usdc < receipt); EXIT and SETTLE take the receipt in.
 */
export function portfolioIsAToB(mode: PMode, usdc: Address, receipt: Address): boolean {
  const u = usdc.toLowerCase();
  const r = receipt.toLowerCase();
  const isIssue = mode === 1 || mode === 2;
  return isIssue ? u < r : r < u;
}

const modeFor = (kind: "issue" | "exit" | "settle", side: Side): PMode =>
  kind === "issue" ? issueMode(side) : kind === "exit" ? exitMode(side) : settleMode(side);

export interface GroupQuote {
  amountIn: bigint;
  amountOut: bigint;
}

/**
 * Quote one leg through `router.quote` — the exact code path a swap runs, so a figure on screen and
 * the fill a taker gets cannot disagree. ISSUE supports exact-in (USDC) and exact-out (units); EXIT
 * and SETTLE are exact-in (units) only.
 */
export async function quoteGroup(
  g: Pick<GroupState, "id" | "highReceipt" | "calmReceipt" | "params">,
  kind: "issue" | "exit" | "settle",
  side: Side,
  isExactIn: boolean,
  amount: bigint,
  taker: Address = zeroAddress,
): Promise<GroupQuote> {
  if (kind !== "issue" && !isExactIn) throw new Error(`${kind.toUpperCase()} is exact-in only`);
  const mode = modeFor(kind, side);
  const receipt = side === "high" ? g.highReceipt : g.calmReceipt;
  const isAToB = portfolioIsAToB(mode, g.params.quoteToken, receipt);
  const order = await readOrderFor(g.id, mode);
  // Thresholds are inert for a static quote: 0 min-out for exact-in, an unreachable max-in otherwise.
  const threshold = isExactIn ? 0n : 1n << 160n;
  const deadline = Math.floor(Date.now() / 1000) + 20 * 60;
  const takerData = await buildTakerData(taker, isExactIn, isAToB, threshold, deadline, true);
  const [amountIn, amountOut] = await publicClient.readContract({
    address: ADDR.router,
    abi: routerAbi,
    functionName: "quote",
    args: [order, amount, takerData],
  });
  return { amountIn, amountOut };
}

// ---------------------------------------------------------------- portfolio accumulator

export async function readGroupCheckpointProgress(id: bigint): Promise<{ stored: number; available: number; total: number }> {
  const [stored, available, total] = await publicClient.readContract({
    address: ADDR.portfolioAccumulator,
    abi: accumulatorAbi,
    functionName: "progress",
    args: [id],
  });
  return { stored: Number(stored), available: Number(available), total: Number(total) };
}

export async function readGroupRealized(id: bigint): Promise<{ variance: bigint; elapsed: number; processedThrough: number }> {
  const [variance, elapsed, processedThrough] = await publicClient.readContract({
    address: ADDR.portfolioAccumulator,
    abi: accumulatorAbi,
    functionName: "realizedSoFar",
    args: [id],
  });
  return { variance, elapsed: Number(elapsed), processedThrough: Number(processedThrough) };
}

// ---------------------------------------------------------------- hooks

const livePolling = { retry: 1, refetchOnWindowFocus: true } as const;
const k = (v: bigint | undefined) => (v === undefined ? "" : v.toString());

export function useGroupList(enabled = true) {
  return useQuery({
    queryKey: ["chain", "groups"],
    queryFn: readAllGroupStates,
    enabled: isPortfolioDeployed && enabled,
    refetchInterval: 3_000,
    ...livePolling,
  });
}

export function useGroupState(id: bigint | undefined) {
  return useQuery({
    queryKey: ["chain", "group", k(id)],
    queryFn: () => readGroupState(id as bigint),
    enabled: isPortfolioDeployed && id !== undefined,
    refetchInterval: 3_000,
    ...livePolling,
  });
}

export function useGroupQuote(
  g: GroupState | undefined,
  kind: "issue" | "exit" | "settle",
  side: Side,
  isExactIn: boolean,
  amount: bigint | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ["chain", "groupQuote", k(g?.id), kind, side, isExactIn, amount?.toString() ?? ""],
    queryFn: () => quoteGroup(g as GroupState, kind, side, isExactIn, amount as bigint),
    enabled: enabled && isPortfolioDeployed && g !== undefined && amount !== null && amount > 0n,
    refetchInterval: 4_000,
    ...livePolling,
  });
}

export function useGroupCheckpointProgress(id: bigint | undefined) {
  return useQuery({
    queryKey: ["chain", "groupCheckpoints", k(id)],
    queryFn: () => readGroupCheckpointProgress(id as bigint),
    enabled: isPortfolioDeployed && id !== undefined,
    refetchInterval: 3_000,
    ...livePolling,
  });
}

export function useGroupRealized(id: bigint | undefined) {
  return useQuery({
    queryKey: ["chain", "groupRealized", k(id)],
    queryFn: () => readGroupRealized(id as bigint),
    enabled: isPortfolioDeployed && id !== undefined,
    refetchInterval: 3_000,
    ...livePolling,
  });
}

export interface VaultBalances {
  balance: bigint;
  locked: bigint;
  free: bigint;
}

/** Direct reads against the maker vault itself — no Lens exists for the portfolio market. */
export async function readVaultBalances(vault: Address): Promise<VaultBalances> {
  const [balance, locked, free] = await Promise.all([
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "quoteBalance" }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "lockedQuote" }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "freeQuote" }),
  ]);
  return { balance, locked, free };
}

export function useVaultBalances(vault: Address | undefined) {
  return useQuery({
    queryKey: ["chain", "vaultBalances", vault ?? ""],
    queryFn: () => readVaultBalances(vault as Address),
    enabled: isPortfolioDeployed && !!vault && !/^0x0{40}$/i.test(vault),
    refetchInterval: 3_000,
    ...livePolling,
  });
}

export function usePortfolioVault(writer: Address | undefined) {
  return useQuery({
    queryKey: ["chain", "portfolioVault", writer ?? ""],
    queryFn: () => readPortfolioVaultOf(writer as Address),
    enabled: isPortfolioDeployed && !!writer,
    refetchInterval: 3_000,
    ...livePolling,
  });
}
