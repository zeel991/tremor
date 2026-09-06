"use client";

import { Card } from "@/components/ui/Card";
import { useApiSeriesDetail } from "@/lib/api";
import { fmtDateTime, fmtUsdc, fmtVolPct } from "@/lib/format";
import { isGraphConfigured, useGraphHistory } from "@/lib/graph";
import type { SeriesState } from "@/lib/series";

export function GraphHistoryCard({ s }: { s: SeriesState }) {
  const graph = useGraphHistory(s.id);
  const api = useApiSeriesDetail(s.id);
  const checkpoints = graph.data?.checkpoints ?? api.data?.checkpoints ?? [];
  const finalization = graph.data?.finalization ?? api.data?.finalization;
  const source = graph.data ? "The Graph" : api.data ? "backend indexer fallback" : "loading";

  return (
    <Card title="Indexed protocol history" meta={`${source} · checkpoints and settlement events`}>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="border border-line bg-paper-2 p-3">
          <div className="eyebrow">Checkpoints</div>
          <div className="mt-1 text-xl font-medium tnum">{checkpoints.length}</div>
          <div className="small text-ink-3">{checkpoints.length ? `through ${fmtDateTime(checkpoints[checkpoints.length - 1].processedThrough)}` : "No indexed rounds yet"}</div>
        </div>
        <div className="border border-line bg-paper-2 p-3">
          <div className="eyebrow">Indexed fills</div>
          <div className="mt-1 text-xl font-medium tnum">{graph.data?.fills.length ?? api.data?.fills.length ?? "—"}</div>
          <div className="small text-ink-3">historical execution events</div>
        </div>
        <div className="border border-line bg-paper-2 p-3">
          <div className="eyebrow">Finalization</div>
          <div className="mt-1 text-xl font-medium tnum">{finalization ? fmtVolPct(finalization.finalVariance) : "—"}</div>
          <div className="small text-ink-3">{finalization ? `${fmtUsdc(finalization.payoutPerUnit)} / unit` : "not indexed"}</div>
        </div>
      </div>
      <p className="mt-4 small text-ink-3">
        The Graph supplies historical on-chain events; the live chain remains authoritative for executable quotes and balances.
        {graph.isError && isGraphConfigured ? " The configured subgraph did not answer, so the backend indexer is being used." : ""}
      </p>
    </Card>
  );
}
