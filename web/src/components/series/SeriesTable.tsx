"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useSeriesList, useNow } from "@/lib/hooks";
import { isDeployed } from "@/lib/contracts";
import { cx, fmtDate, fmtRelative, fmtUnits, fmtUsdc } from "@/lib/format";
import {
  MARKET_FILTER_LABEL,
  Status,
  isFinalized,
  marketVolPct,
  matchesFilter,
  realizedVolPct,
  receiptSymbol,
  type MarketFilter,
  type SeriesState,
} from "@/lib/series";
import { StatusTag } from "@/components/ui/Tag";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { LinkButton } from "@/components/ui/Button";

const FILTERS: Array<{ value: MarketFilter; label: string }> = (
  ["all", "live", "upcoming", "finalizing", "finalized", "closed"] as MarketFilter[]
).map((value) => ({ value, label: MARKET_FILTER_LABEL[value] }));

/**
 * Locked backing: the collateral the writer's vault has reserved for this series' outstanding
 * receipts, and whether all three enforceable conditions currently hold.
 *
 * v1 had a "coverage ratio" built from a wallet balance and an allowance the seller could change at
 * any time. This is the reservation itself.
 */
export function LockedBackingCell({ s }: { s: SeriesState }) {
  const ok = s.fullyCollateralized;
  return (
    <span
      className={cx("inline-flex items-center gap-1.5 text-[13px] font-medium tnum", ok ? "text-up" : "text-down")}
      title={
        ok
          ? "The vault holds every dollar it has reserved, Aqua can still move it, and a burn leg is still shipped"
          : "One of the three conditions does not currently hold: vault balance, Aqua allowance, or a shipped burn leg"
      }
    >
      <span className="sdot" />
      {fmtUsdc(s.lockedLiability, 0)}
    </span>
  );
}

/** White table with --bg-3 header, square status dots and tertiary action buttons. */
export function SeriesTable({ compact, limit, initialSaleOnly = false }: { compact?: boolean; limit?: number; initialSaleOnly?: boolean }) {
  const { data, isLoading, source, chainError, apiError } = useSeriesList();
  const [filter, setFilter] = useState<MarketFilter>("all");
  const [saleOnly, setSaleOnly] = useState(initialSaleOnly);
  const now = useNow(30_000);

  const rows = useMemo(() => {
    let list = data ?? [];
    if (filter !== "all") list = list.filter((s) => matchesFilter(s, filter));
    if (saleOnly) list = list.filter((s) => matchesFilter(s, "issuanceOpen"));
    if (limit) list = list.slice(0, limit);
    return list;
  }, [data, filter, saleOnly, limit]);

  const cols = compact ? 8 : 10;

  return (
    <div className="flex flex-col gap-4">
      {!compact ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented label="Status filter" options={FILTERS} value={filter} onChange={setFilter} />
          <div className="flex items-center gap-3">
            <button type="button" className={cx("btn btn-sm", saleOnly ? "btn-secondary" : "btn-tertiary")} aria-pressed={saleOnly} onClick={() => setSaleOnly((v) => !v)}>
              <span className={cx("sdot", saleOnly ? "text-lime" : "text-ink-3")} />
              {MARKET_FILTER_LABEL.issuanceOpen}
            </button>
            {source ? <span className="bracket bracket-muted">{source === "chain" ? "live from Lens" : "from API cache"}</span> : null}
          </div>
        </div>
      ) : null}
      <div className="card card-flush">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Series</th>
                <th>Status</th>
                <th>Expiry</th>
                <th className="num">Realized vol</th>
                <th className="num">Market vol</th>
                <th className="num">Bid</th>
                <th className="num">Ask</th>
                {!compact ? <th className="num">Available units</th> : null}
                {!compact ? <th className="num">Locked backing</th> : null}
                <th className="num"></th>
              </tr>
            </thead>
            {isLoading ? (
              <SkeletonRows rows={4} cols={cols} />
            ) : (
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={cols} style={{ height: "auto" }}>
                      <EmptyState
                        action={
                          data && data.length === 0 && isDeployed ? (
                            <LinkButton href="/write" size="sm" variant="secondary">
                              Write a series
                            </LinkButton>
                          ) : undefined
                        }
                      >
                        {!isDeployed
                          ? "Contracts are not deployed on this chain yet."
                          : chainError && apiError
                            ? "Neither the RPC nor the API answered."
                            : data && data.length > 0
                              ? "No series match this filter."
                              : "No series yet. Write the first one."}
                      </EmptyState>
                    </td>
                  </tr>
                ) : (
                  rows.map((s) => (
                    <tr key={s.id.toString()}>
                      <td>
                        <Link href={`/series/${s.id.toString()}`} className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                          <span className="flex h-7 w-7 flex-none items-center justify-center bg-ink text-[11px] font-medium text-lime">σ²</span>
                          <span>
                            <span className="block font-medium">{receiptSymbol(s)}</span>
                            <span className="mono block text-[11px] text-ink-3">#{s.id.toString()}</span>
                          </span>
                        </Link>
                      </td>
                      <td>
                        <StatusTag status={s.status} issuanceOpen={s.legs.issuanceOpen} compact={compact} />
                      </td>
                      <td>
                        <span className="block">{fmtDate(s.params.expiry)}</span>
                        <span className="block text-[11px] text-ink-3">{now ? fmtRelative(s.params.expiry, now) : ""}</span>
                      </td>
                      <td className="num font-medium">
                        {s.status === Status.Upcoming
                          ? "Awaiting start"
                          : s.oracle.samplesStored <= 1 && !isFinalized(s)
                            ? "—"
                            : `${realizedVolPct(s)}%`}
                      </td>
                      <td className="num text-ink-2" title="This market's own quote, not a fair value">
                        {marketVolPct(s)}%
                      </td>
                      <td className="num">{s.quote.bidPerUnit > 0n ? `${fmtUsdc(s.quote.bidPerUnit)}` : "—"}</td>
                      <td className="num">{s.quote.askPerUnit > 0n ? `${fmtUsdc(s.quote.askPerUnit)}` : "—"}</td>
                      {!compact ? (
                        <td className="num">
                          {fmtUnits(s.unitsAvailable, 0)}
                          <span className="text-ink-3"> / {fmtUnits(s.params.maxUnits, 0)}</span>
                        </td>
                      ) : null}
                      {!compact ? (
                        <td className="num">
                          <LockedBackingCell s={s} />
                        </td>
                      ) : null}
                      <td className="num">
                        <Link href={`/series/${s.id.toString()}`} className="btn btn-tertiary btn-sm" onClick={(e) => e.stopPropagation()}>
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
