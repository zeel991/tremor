"use client";

import { useMemo } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useGroupState } from "@/lib/portfolio-chain";
import { useRpcOnline } from "@/lib/chain";
import { useNow } from "@/lib/hooks";
import { deploymentError, isDeployed, isPortfolioDeployed } from "@/lib/contracts";
import { fmtDateTime, fmtDuration, fmtRelative, fmtUnits, fmtUsdc, fmtVolPct, fmtWad } from "@/lib/format";
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
import { Address } from "@/components/ui/Address";
import { LinkButton } from "@/components/ui/Button";
import { PortfolioSummaryCard } from "./PortfolioSummaryCard";
import { ExitBufferCard } from "./ExitBufferCard";
import { GroupTradeRail } from "./GroupTradeRail";

const PairPayoffChart = dynamic(() => import("./PairPayoffChart").then((m) => m.PairPayoffChart), { ssr: false });

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
          <dt>HIGH bid / ask per unit</dt>
          <dd>
            {fmtUsdc(p.bidHigh)} / {fmtUsdc(p.askHigh)} <small>USDC</small>
          </dd>
          <span>fixed by the writer — not a fair-value volatility model</span>
        </div>
        <div>
          <dt>CALM bid / ask per unit</dt>
          <dd>
            {fmtUsdc(p.bidCalm)} / {fmtUsdc(p.askCalm)}
          </dd>
          <span>fixed by the writer</span>
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

        <Card
          title="HIGH vs CALM"
          meta="Two complementary capped claims that always sum to the cap payout"
        >
          <p className="mt-0 text-[13px] leading-5 text-ink-2">
            At finalization, x = min(final variance / cap variance, 1). A HIGH unit pays{" "}
            <b className="tnum">S·x</b> and a CALM unit pays <b className="tnum">S·(1−x)</b>, with S ={" "}
            <b className="tnum">{fmtUsdc(g.params.capPayoutPerUnit)} USDC</b>. Because the two payouts sum to S
            at every outcome, one reserve of max(HIGH, CALM)·S backs both sides — never the sum of the caps.
          </p>
          <PairPayoffChart g={g} />
          <p className="mb-0 mt-3 text-[12px] text-ink-3">
            {sideSymbol(g, "high")} and {sideSymbol(g, "calm")} share one observation window (
            {fmtDateTime(g.params.start)} → {fmtDateTime(g.params.expiry)}, sampled every{" "}
            {fmtDuration(g.params.sampleInterval)}) and one {fmtVolPct(g.params.capVariance)}% volatility cap.
          </p>
        </Card>

        <PortfolioSummaryCard g={g} />
        <ExitBufferCard g={g} />

        <Card title="Fills and history" meta="Not yet indexed">
          <p className="m-0 text-[13px] text-ink-2">
            Paired markets are read straight from the chain for now — the indexer does not cover them yet, so
            there is no fill feed or price history here. Everything above is live contract state.
          </p>
        </Card>
      </div>

      <GroupTradeRail g={g} />
    </div>
  );
}
