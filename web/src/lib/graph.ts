"use client";

import { useQuery } from "@tanstack/react-query";
import { env } from "@/config/env";
import type { ApiLeg, CheckpointRow, Fill, Finalization } from "@/lib/api";

// The checked-in public subgraph targets Base Sepolia. Never mix that history into a local Anvil
// deployment just because a developer happens to have a Graph URL in .env.local.
const GRAPH_CHAIN_ID = 84532;
const graphEnabled = Boolean(env.subgraphUrl) && env.chainId === GRAPH_CHAIN_ID;

type GraphFill = { id: string; orderHash: string; leg: string; makerVault: string; taker: string; amountIn: string; amountOut: string; units: string; quoteAmount: string; timestamp: string; block: string; transactionHash: string };
type GraphCheckpoint = { id: string; fromSample: string; toSample: string; processedThrough: string; lastRoundId: string; sumSquaredReturns: string; timestamp: string; block: string; transactionHash: string };
type GraphFinalization = { id: string; finalVariance: string; cappedVariance: string; payoutPerUnit: string; outstandingUnits: string; releasedCollateral: string; timestamp: string; block: string; transactionHash: string };
type GraphHistoryResponse = { series?: { fills?: GraphFill[]; checkpoints?: GraphCheckpoint[]; finalization?: GraphFinalization | null } | null };

const HISTORY_QUERY = `query TremorSeriesHistory($id: ID!) {
  series(id: $id) {
    fills(orderBy: timestamp, orderDirection: desc, first: 100) { id orderHash leg makerVault taker amountIn amountOut units quoteAmount timestamp block transactionHash }
    checkpoints(orderBy: processedThrough, orderDirection: asc, first: 1000) { id fromSample toSample processedThrough lastRoundId sumSquaredReturns timestamp block transactionHash }
    finalization { id finalVariance cappedVariance payoutPerUnit outstandingUnits releasedCollateral timestamp block transactionHash }
  }
}`;

async function graphRequest<T>(query: string, id: bigint): Promise<T> {
  const response = await fetch(env.subgraphUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables: { id: id.toString() } }) });
  if (!response.ok) throw new Error(`Graph request failed (${response.status})`);
  const body = (await response.json()) as { data?: T; errors?: unknown[] };
  if (body.errors?.length || !body.data) throw new Error("Graph query failed");
  return body.data;
}

function mapFill(fill: GraphFill): Fill {
  const units = BigInt(fill.units);
  const quote = BigInt(fill.quoteAmount);
  const leg: ApiLeg = fill.leg === "exit" ? "exit" : fill.leg === "settle" ? "settle" : "issue";
  return { txHash: fill.transactionHash as `0x${string}`, block: Number(fill.block), timestamp: Number(fill.timestamp), leg, orderHash: fill.orderHash as `0x${string}`, makerVault: fill.makerVault as `0x${string}`, taker: fill.taker as `0x${string}`, units, quoteAmount: quote, amountIn: BigInt(fill.amountIn), amountOut: BigInt(fill.amountOut), pricePerUnit: units > 0n ? (quote * 10n ** 18n) / units : 0n } satisfies Fill;
}

function mapCheckpoint(row: GraphCheckpoint): CheckpointRow {
  return { txHash: row.transactionHash as `0x${string}`, block: Number(row.block), timestamp: Number(row.timestamp), fromSample: Number(row.fromSample), toSample: Number(row.toSample), processedThrough: Number(row.processedThrough), lastRoundId: row.lastRoundId, sumSquaredReturns: BigInt(row.sumSquaredReturns) };
}

function mapFinalization(row: GraphFinalization): Finalization {
  return { txHash: row.transactionHash as `0x${string}`, block: Number(row.block), timestamp: Number(row.timestamp), finalVariance: BigInt(row.finalVariance), cappedVariance: BigInt(row.cappedVariance), payoutPerUnit: BigInt(row.payoutPerUnit), outstandingUnits: BigInt(row.outstandingUnits), releasedCollateral: BigInt(row.releasedCollateral) };
}

export type GraphHistory = { fills: Fill[]; checkpoints: CheckpointRow[]; finalization?: Finalization };

async function fetchGraphHistory(id: bigint): Promise<GraphHistory> {
  const body = await graphRequest<GraphHistoryResponse>(HISTORY_QUERY, id);
  const series = body.series;
  if (!series) return { fills: [], checkpoints: [] };
  return { fills: (series.fills ?? []).map(mapFill), checkpoints: (series.checkpoints ?? []).map(mapCheckpoint), finalization: series.finalization ? mapFinalization(series.finalization) : undefined };
}

/** Indexed historical protocol events. Live/executable state remains chain/API-owned. */
export function useGraphHistory(id: bigint | undefined) {
  return useQuery({ queryKey: ["graph", "history", id?.toString()], queryFn: () => fetchGraphHistory(id as bigint), enabled: graphEnabled && id !== undefined, staleTime: 30_000, retry: 1 });
}

export function useGraphFills(id: bigint | undefined) {
  const history = useGraphHistory(id);
  return { ...history, data: history.data?.fills };
}

export const isGraphConfigured = graphEnabled;
