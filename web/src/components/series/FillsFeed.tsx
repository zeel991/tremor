"use client";

import { useApiOnline, useFills } from "@/lib/api";
import { fmtDateTime, fmtUnits, fmtUsdc, shortAddr } from "@/lib/format";
import type { SeriesState } from "@/lib/series";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { TxHash } from "@/components/ui/Address";
import { isGraphConfigured, useGraphFills } from "@/lib/graph";

/** Buy, Exit or Redeem — the words the trade rail uses, not the contract's leg names. */
const LEG_TITLE: Record<"issue" | "exit" | "settle", string> = {
  issue: "Buy",
  exit: "Exit",
  settle: "Redeem",
};

export function FillsFeed({ s }: { s: SeriesState }) {
  const fills = useFills(s.id);
  const graphFills = useGraphFills(s.id);
  const online = useApiOnline();
  const list = [...(graphFills.data?.length ? graphFills.data : fills.data ?? [])].sort((a, b) => b.timestamp - a.timestamp);
  const offline = online === false || fills.isError;
  return (
    <Card title="Fills" meta={s.fillsCount !== undefined ? `${s.fillsCount} total · ${graphFills.data?.length ? "The Graph" : "indexed by the backend"}` : isGraphConfigured ? "The Graph with backend fallback" : "indexed by the backend"} flush>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Side</th>
              <th>Time</th>
              <th className="num">Units</th>
              <th className="num">USDC</th>
              <th className="num">Price / unit</th>
              <th>Taker</th>
              <th className="num">Tx</th>
            </tr>
          </thead>
          {fills.isPending && !offline ? (
            <SkeletonRows rows={3} cols={7} />
          ) : (
            <tbody>
              {offline || list.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ height: "auto" }}>
                    <EmptyState>{offline ? "API offline — fills are indexed by the backend." : "No fills yet."}</EmptyState>
                  </td>
                </tr>
              ) : (
                list.slice(0, 25).map((f) => (
                  <tr key={`${f.txHash}-${f.timestamp}`}>
                    <td>
                      <span
                        className={`inline-flex items-center gap-1.5 text-[13px] font-medium ${
                          f.leg === "issue" ? "text-lime-dark" : f.leg === "exit" ? "text-ink" : "text-up"
                        }`}
                      >
                        <span className="sdot" />
                        {LEG_TITLE[f.leg]}
                      </span>
                    </td>
                    <td className="text-ink-2">{fmtDateTime(f.timestamp)}</td>
                    <td className="num font-medium">{fmtUnits(f.units, 2)}</td>
                    <td className="num">{fmtUsdc(f.quoteAmount)}</td>
                    <td className="num text-ink-2">{fmtUsdc(f.pricePerUnit)}</td>
                    <td className="mono text-[12.5px] text-ink-2">{shortAddr(f.taker)}</td>
                    <td className="num">
                      <TxHash value={f.txHash} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          )}
        </table>
      </div>
    </Card>
  );
}
