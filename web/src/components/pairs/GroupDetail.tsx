"use client";

import { useMemo } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useGroupState } from "@/lib/portfolio-chain";
import { useRpcOnline } from "@/lib/chain";
import { useNow } from "@/lib/hooks";
import { deploymentError, isDeployed, isPortfolioDeployed } from "@/lib/contracts";
import { fmtDateTime, fmtDuration, fmtPriceUsdc, fmtRelative, fmtUnits, fmtUsdc, fmtVolPct, fmtWad } from "@/lib/format";
import {
  GROUP_STATUS_LABEL,
  groupStatus,
  groupSymbol,
  sideSymbol,
  type GroupState,
} from "@/lib/portfolio";
import { Card } from "@/components/ui/Card";
import { Tag } from "@/components/ui/Tag";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { usePairsEvents, useApiOnline } from "@/lib/api";
import { Address, TxHash } from "@/components/ui/Address";
import { LinkButton } from "@/components/ui/Button";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { PortfolioSummaryCard } from "./PortfolioSummaryCard";
import { ExitBufferCard } from "./ExitBufferCard";
import { GroupTradeRail } from "./GroupTradeRail";
import { LivePairPricingCard } from "./LivePairPricingCard";

const PairMarketChart = dynamic(() => import("./PairMarketChart").then((m) => m.PairMarketChart), { ssr: false });

function Header({ g, now }: { g: GroupState; now: number }) {
  const p = g.params;
  const status = groupStatus(g, now || p.start);
  return (
    <section className="market-terminal-head" aria-labelledby="pair-title">
      <div className="market-terminal-identity">
        <div className="min-w-0 flex-1">
          <Link href="/pairs" className="bracket bracket-muted">
            Paired markets
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 id="pair-title" className="h-page">{groupSymbol(g)}</h1>
            <Tag tone={g.finalized ? "default" : "up"}>{GROUP_STATUS_LABEL[status]}</Tag>
          </div>
          <p className="mt-2 max-w-2xl text-[14px] text-ink-2">
            One risk group, two complementary capped claims on the same ETH realized-variance window. HIGH pays
            more the more variance is realized; CALM pays the rest. Together a HIGH and a CALM unit always pay{" "}
            <span className="tnum">{fmtUsdc(p.capPayoutPerUnit)}</span> USDC.
          </p>
        </div>
        <dl className="market-terminal-dates">
          <div>
            <dt className="label">Expiry</dt>
            <dd className="m-0 text-[13px]">
              {fmtDateTime(p.expiry)}
              {now ? <span className="text-ink-3"> · {fmtRelative(p.expiry, now)}</span> : null}
            </dd>
          </div>
          <div>
            <dt className="label">Sale close</dt>
            <dd className="m-0 text-[13px]">{fmtDateTime(p.saleEnd)}</dd>
          </div>
        </dl>
      </div>

      <dl className="market-tape">
        <div className="market-tape-primary">
          <dt>HIGH {g.finalized ? "final payout" : "bid / ask"} per unit</dt>
          <dd>
            {g.finalized ? (
              <>{fmtPriceUsdc(g.highPpu)} <small>USDC</small></>
            ) : (
              <>{fmtPriceUsdc(p.bidHigh)} / {fmtPriceUsdc(p.askHigh)} <small>USDC</small></>
            )}
          </dd>
          <span>{g.finalized ? "exact on-chain payout at finalization" : "fixed by the writer — not a fair-value volatility model"}</span>
        </div>
        <div>
          <dt>CALM {g.finalized ? "final payout" : "bid / ask"} per unit</dt>
          <dd>
            {g.finalized ? (
              <>{fmtPriceUsdc(g.calmPpu)} <small>USDC</small></>
            ) : (
              <>{fmtPriceUsdc(p.bidCalm)} / {fmtPriceUsdc(p.askCalm)} <small>USDC</small></>
            )}
          </dd>
          <span>{g.finalized ? "exact on-chain payout at finalization" : "fixed by the writer"}</span>
        </div>
        <div>
          <dt>{g.finalized ? "Final realized vol" : "Volatility cap"}</dt>
          <dd>{g.finalized ? `${fmtVolPct(g.finalVariance)}%` : `${fmtVolPct(p.capVariance)}%`}</dd>
          <span>{g.finalized ? `x = ${fmtWad(g.xWad, 4)}` : "x = 1 at or above the cap"}</span>
        </div>
        <div>
          <dt>Portfolio reserve</dt>
          <dd>{fmtUsdc(g.reserveLocked, 0)}</dd>
          <span>
            {fmtUnits(g.highOutstanding, 0)} HIGH · {fmtUnits(g.calmOutstanding, 0)} CALM outstanding
          </span>
        </div>
      </dl>
      <details className="market-advanced">
        <summary>
          Advanced details <span className="mono">#{g.id.toString()}</span>
        </summary>
        <div className="market-advanced-grid">
          <span>
            Window start <b>{fmtDateTime(p.start)}</b>
          </span>
          <span>
            Sampling <b>{fmtDuration(p.sampleInterval)}</b>
          </span>
          <span>
            Writer <Address value={g.writer} />
          </span>
          <span>
            Maker vault <Address value={g.vault} />
          </span>
          <span>
            HIGH receipt <Address value={g.highReceipt} />
          </span>
          <span>
            CALM receipt <Address value={g.calmReceipt} />
          </span>
          <span>
            Max units / side <b>{fmtUnits(p.maxUnitsPerSide, 0)}</b>
          </span>
          <span>
            Cap payout / unit <b>{fmtUsdc(p.capPayoutPerUnit)} USDC</b>
          </span>
        </div>
      </details>
    </section>
  );
}

export function GroupDetail({ idStr }: { idStr: string }) {
  const id = useMemo(() => {
    try {
      return BigInt(idStr);
    } catch {
      return undefined;
    }
  }, [idStr]);
  const view = useGroupState(id);
  const now = useNow(30_000);
  const rpcOnline = useRpcOnline();
  const g = view.data;

  if (id === undefined) return <EmptyState>Invalid group id.</EmptyState>;

  if (!isPortfolioDeployed) {
    return (
      <Card>
        <EmptyState action={<LinkButton href="/pairs" variant="tertiary" size="sm">Back to paired markets</LinkButton>}>
          {!isDeployed && deploymentError
            ? `Deployment manifest rejected: ${deploymentError}`
            : "This deployment manifest has no portfolio market — paired markets are unavailable here."}
        </EmptyState>
      </Card>
    );
  }

  if (view.isPending) {
    return (
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(360px,1fr)]">
        <div className="flex flex-col gap-6">
          <div className="card">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="mt-3 h-4 w-80" />
          </div>
          <div className="card">
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
        <div className="panel p-4">
          <Skeleton dark className="h-6 w-40" />
          <Skeleton dark className="mt-4 h-40 w-full" />
        </div>
      </div>
    );
  }

  if (!g) {
    return (
      <Card>
        <EmptyState action={<LinkButton href="/pairs" variant="tertiary" size="sm">Back to paired markets</LinkButton>}>
          {rpcOnline === false ? "The RPC did not answer." : `Group #${idStr} was not found.`}
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(360px,1fr)] xl:items-start">
      <div className="flex min-w-0 flex-col gap-6">
        <Header g={g} now={now} />
        <LivePairPricingCard g={g} />
        <PairMarketChart g={g} />

        <PortfolioSummaryCard g={g} />
        <ExitBufferCard g={g} />
        <GroupEventsCard g={g} />
      </div>

      <GroupTradeRail g={g} />
    </div>
  );
}

function GroupEventsCard({ g }: { g: GroupState }) {
  const events = usePairsEvents(g.id);
  const online = useApiOnline();
  const list = events.data ?? [];
  const offline = online === false || events.isError;

  return (
    <Card
      title="Fills and history"
      meta={list.length > 0 ? `${list.length} events · indexed by backend` : "indexed by backend"}
      flush
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Side</th>
              <th>Time</th>
              <th className="num">Units</th>
              <th className="num">Amount (USDC)</th>
              <th>Actor</th>
              <th className="num">Tx</th>
            </tr>
          </thead>
          {events.isPending && !offline ? (
            <SkeletonRows rows={3} cols={7} />
          ) : (
            <tbody>
              {offline || list.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ height: "auto" }}>
                    <EmptyState>
                      {offline
                        ? "API offline — portfolio events are indexed by the backend."
                        : "No portfolio events recorded yet."}
                    </EmptyState>
                  </td>
                </tr>
              ) : (
                list.map((e) => {
                  const label =
                    e.eventType === "issued"
                      ? "Buy"
                      : e.eventType === "exited"
                        ? "Exit"
                        : e.eventType === "settled"
                          ? "Redeem"
                          : e.eventType === "finalized"
                            ? "Finalize"
                            : e.eventType === "buffer_funded"
                              ? "Fund Buffer"
                              : e.eventType === "buffer_withdrawn"
                                ? "Withdraw Buffer"
                                : e.eventType;
                  return (
                    <tr key={`${e.txHash}-${e.logIndex}`}>
                      <td>
                        <span
                          className={`inline-flex items-center gap-1.5 text-[13px] font-medium ${
                            e.eventType === "issued"
                              ? "text-lime-dark"
                              : e.eventType === "settled"
                                ? "text-up"
                                : "text-ink"
                          }`}
                        >
                          <span className="sdot" />
                          {label}
                        </span>
                      </td>
                      <td>
                        {e.side ? (
                          <Tag tone={e.side === "high" ? "lime" : "muted"}>
                            {e.side.toUpperCase()}
                          </Tag>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                      <td className="text-ink-2">{e.timestamp > 0 ? fmtDateTime(e.timestamp) : "—"}</td>
                      <td className="num font-medium">
                        {e.units > 0n ? fmtUnits(e.units, 2) : "—"}
                      </td>
                      <td className="num">
                        {e.amount > 0n ? fmtUsdc(e.amount) : "—"}
                      </td>
                      <td>
                        {e.actor ? <Address value={e.actor} /> : <span className="text-ink-3">—</span>}
                      </td>
                      <td className="num">
                        <TxHash value={e.txHash} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          )}
        </table>
      </div>
    </Card>
  );
}
