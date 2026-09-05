/** Composite hooks: merge chain + API series views, time helpers. */
"use client";

import { useEffect, useMemo, useState } from "react";
import { useApiSeries, useApiSeriesDetail } from "./api";
import { useChainSeries, useChainSeriesState } from "./chain";
import { isDeployed } from "./contracts";
import { sortSeries, type SeriesState } from "./series";

/** Unix seconds, 0 until mounted (hydration-safe). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const initial = setTimeout(() => setNow(Math.floor(Date.now() / 1000)), 0);
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => {
      clearTimeout(initial);
      clearInterval(t);
    };
  }, [intervalMs]);
  return now;
}

export function useMounted(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setM(true), 0);
    return () => clearTimeout(timer);
  }, []);
  return m;
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export interface SeriesListView {
  data: SeriesState[] | undefined;
  isLoading: boolean;
  source: "chain" | "api" | undefined;
  chainError: boolean;
  apiError: boolean;
  refetch: () => void;
}

/**
 * Chain state wins for everything live; the backend contributes only its per-leg fill statistics.
 *
 * The split matters: the Lens is the executable authority for prices, locked collateral and the final
 * payout, and the indexer is minutes behind by construction. Merging the other way round would put a
 * stale bid in a trade ticket.
 */
function mergeExtras(chain: SeriesState, api: SeriesState | undefined): SeriesState {
  if (!api) return chain;
  return {
    ...chain,
    fillsCount: api.fillsCount,
    issueCount: api.issueCount,
    exitCount: api.exitCount,
    settleCount: api.settleCount,
    premiumQuote: api.premiumQuote,
    exitQuote: api.exitQuote,
    settlementQuote: api.settlementQuote,
    unitsIssued: api.unitsIssued,
    unitsExited: api.unitsExited,
    unitsSettled: api.unitsSettled,
    lastFillAt: api.lastFillAt,
  };
}

/** Series list: chain (Lens) is authoritative for live fields; backend adds fill stats. */
export function useSeriesList(): SeriesListView {
  const chain = useChainSeries();
  const api = useApiSeries();
  const data = useMemo(() => {
    if (chain.data) {
      const byId = new Map((api.data ?? []).map((s) => [s.id.toString(), s]));
      return sortSeries(chain.data.map((s) => mergeExtras(s, byId.get(s.id.toString()))));
    }
    if (api.data) return sortSeries(api.data);
    return undefined;
  }, [chain.data, api.data]);
  const chainPending = isDeployed && chain.isPending;
  return {
    data,
    isLoading: data === undefined && (chainPending || api.isPending),
    source: chain.data ? "chain" : api.data ? "api" : undefined,
    chainError: chain.isError,
    apiError: api.isError,
    refetch: () => {
      void chain.refetch();
      void api.refetch();
    },
  };
}

export interface SeriesView {
  data: SeriesState | undefined;
  isLoading: boolean;
  notFound: boolean;
  source: "chain" | "api" | undefined;
  chainError: boolean;
  apiError: boolean;
  refetch: () => void;
}

export function useSeries(id: bigint | undefined): SeriesView {
  const chain = useChainSeriesState(id);
  const api = useApiSeriesDetail(id);
  const data = useMemo(() => {
    if (chain.data) return mergeExtras(chain.data, api.data?.state);
    if (api.data) return api.data.state;
    return undefined;
  }, [chain.data, api.data]);
  const chainPending = isDeployed && chain.isPending;
  const settled = !chainPending && !api.isPending;
  return {
    data,
    isLoading: data === undefined && (chainPending || api.isPending),
    notFound: data === undefined && settled,
    source: chain.data ? "chain" : api.data ? "api" : undefined,
    chainError: chain.isError,
    apiError: api.isError,
    refetch: () => {
      void chain.refetch();
      void api.refetch();
    },
  };
}
