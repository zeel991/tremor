"use client";

import { ApiError, useApiOnline, useFeedWindow, useTrailing, type TrailingWindow } from "@/lib/api";
import { fmtVolPct, volPctNumber } from "@/lib/format";
import { StatTile } from "@/components/ui/StatTile";
import { Sparkline } from "@/components/charts/Sparkline";

const WINDOWS: Array<{ w: TrailingWindow; label: string }> = [
  { w: "1d", label: "Realized vol · 1d" },
  { w: "7d", label: "Realized vol · 7d" },
  { w: "30d", label: "Realized vol · 30d" },
];

function Tile({ w, label }: { w: TrailingWindow; label: string }) {
  const trailing = useTrailing(w);
  // Fetch the sparkline only after the volatility request has warmed the shared Chainlink cache.
  // Starting both cold requests together duplicates thousands of RPC reads on longer windows.
  const feed = useFeedWindow(w, Boolean(trailing.data));
  const online = useApiOnline();
  const spark = (feed.data ?? []).map((p) => ({ t: p.t, v: p.price }));
  const apiError = trailing.error instanceof ApiError ? trailing.error : undefined;
  const offline = online === false || apiError?.offline === true;
  const waiting = !trailing.data && (trailing.isPending || trailing.isFetching);
  const unavailable = trailing.isError && !offline;
  const vol = trailing.data ? volPctNumber(trailing.data.rv) : undefined;
  const stateMessage = offline
    ? "API offline"
    : trailing.data
      ? `${trailing.data.samples} samples · Chainlink ETH/USD`
      : unavailable
        ? "Loading deep history · retrying"
        : "Loading Chainlink history…";
  return (
    <StatTile
      label={label}
      loading={waiting && !offline}
      value={trailing.data ? `${fmtVolPct(trailing.data.rv)}%` : "—"}
      valueClassName={trailing.data ? undefined : "text-ink-3"}
      sub={<span role="status">{stateMessage}</span>}
      bar={vol !== undefined ? Math.min(100, vol) : undefined}
    >
      {spark.length > 1 ? <Sparkline id={w} data={spark} /> : <div style={{ height: 56 }} />}
    </StatTile>
  );
}

export function TrailingTiles() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {WINDOWS.map((x) => (
        <Tile key={x.w} w={x.w} label={x.label} />
      ))}
    </div>
  );
}
