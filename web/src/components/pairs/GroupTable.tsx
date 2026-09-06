"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useGroupList } from "@/lib/portfolio-chain";
import { useNow } from "@/lib/hooks";
import { deploymentError, isDeployed, isPortfolioDeployed } from "@/lib/contracts";
import { fmtDate, fmtRelative, fmtUnits, fmtUsdc } from "@/lib/format";
import {
  GROUP_STATUS_LABEL,
  groupStatus,
  groupSymbol,
  sortGroups,
  standaloneCapsFor,
  type GroupState,
} from "@/lib/portfolio";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { LinkButton } from "@/components/ui/Button";
import { Tag } from "@/components/ui/Tag";

function ReserveCell({ g }: { g: GroupState }) {
  const standalone =
    g.standaloneCaps > 0n
      ? g.standaloneCaps
      : standaloneCapsFor(g.highOutstanding, g.calmOutstanding, g.params.capPayoutPerUnit);
  return (
    <span className="tnum">
      {fmtUsdc(g.reserveLocked, 0)}
      <span className="text-ink-3" title="What two separately backed series would lock — a baseline, not actual simultaneous debt">
        {" "}
        / {fmtUsdc(standalone, 0)} if separate
      </span>
    </span>
  );
}

/** White table of risk groups: both sides' outstanding, reserve vs standalone caps, status. */
export function GroupTable({ limit }: { limit?: number }) {
  const list = useGroupList();
  const now = useNow(30_000);

  const rows = useMemo(() => {
    let l = list.data ?? [];
    if (now) l = sortGroups(l, now);
    if (limit) l = l.slice(0, limit);
    return l;
  }, [list.data, now, limit]);

  const cols = 8;

  return (
    <div className="card card-flush">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Group</th>
              <th>Status</th>
              <th>Expiry</th>
              <th className="num">HIGH outstanding</th>
              <th className="num">CALM outstanding</th>
              <th className="num">Reserve / if separate</th>
              <th className="num">Exit buffer</th>
              <th className="num"></th>
            </tr>
          </thead>
          {list.isPending && isPortfolioDeployed ? (
            <SkeletonRows rows={4} cols={cols} />
          ) : (
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={cols} style={{ height: "auto" }}>
                    <EmptyState
                      action={
                        isPortfolioDeployed && (list.data?.length ?? 0) === 0 && !list.isError ? (
                          <LinkButton href="/pairs/new" size="sm" variant="secondary">
                            Write a paired market
                          </LinkButton>
                        ) : undefined
                      }
                    >
                      {!isDeployed
                        ? deploymentError
                          ? `Deployment manifest rejected: ${deploymentError}`
                          : "Contracts are not deployed on this chain yet."
                        : !isPortfolioDeployed
                          ? "This deployment manifest has no portfolio market — paired markets are unavailable here."
                          : list.isError
                            ? "The RPC did not answer."
                            : "No paired markets yet. Write the first one."}
                    </EmptyState>
                  </td>
                </tr>
              ) : (
                rows.map((g) => {
                  const status = groupStatus(g, now || g.params.start);
                  return (
                    <tr key={g.id.toString()}>
                      <td>
                        <Link href={`/pairs/${g.id.toString()}`} className="flex items-center gap-3">
                          <span className="flex h-7 w-7 flex-none items-center justify-center bg-ink text-[11px] font-medium text-lime">
                            ⇄
                          </span>
                          <span>
                            <span className="block font-medium">{groupSymbol(g)}</span>
                            <span className="mono block text-[11px] text-ink-3">#{g.id.toString()}</span>
                          </span>
                        </Link>
                      </td>
                      <td>
                        <Tag tone={g.finalized ? "default" : "up"}>{GROUP_STATUS_LABEL[status]}</Tag>
                      </td>
                      <td>
                        <span className="block">{fmtDate(g.params.expiry)}</span>
                        <span className="block text-[11px] text-ink-3">{now ? fmtRelative(g.params.expiry, now) : ""}</span>
                      </td>
                      <td className="num">
                        {fmtUnits(g.highOutstanding, 0)}
                        <span className="text-ink-3"> / {fmtUnits(g.params.maxUnitsPerSide, 0)}</span>
                      </td>
                      <td className="num">
                        {fmtUnits(g.calmOutstanding, 0)}
                        <span className="text-ink-3"> / {fmtUnits(g.params.maxUnitsPerSide, 0)}</span>
                      </td>
                      <td className="num">
                        <ReserveCell g={g} />
                      </td>
                      <td className="num">{fmtUsdc(g.exitBuffer, 0)}</td>
                      <td className="num">
                        <Link href={`/pairs/${g.id.toString()}`} className="btn btn-tertiary btn-sm">
                          Open
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}
