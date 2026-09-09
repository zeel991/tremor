"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useAccount } from "wagmi";
import { useApiOnline, useMarket, usePortfolio, useVariance } from "@/lib/api";
import { useRpcOnline, useTokenBalance } from "@/lib/chain";
import { useSeries, useNow } from "@/lib/hooks";
import { isDeployed } from "@/lib/contracts";
import { fmtDateTime, fmtDuration, fmtRelative, fmtUnits, fmtUsdc, fmtVolPct, fmtWad, usdcNumber, volPctNumber, WAD } from "@/lib/format";
import {
  Status,
  breakEvenVariance,
  checkpointsBehind,
  effectiveVariance,
  isFinalized,
  marketVolPct,
  maxPayoutPerUnit,
  payoutFor,
  perUnitPrice,
  realizedVolPct,
  receiptSymbol,
  type SeriesState,
} from "@/lib/series";
import { Card } from "@/components/ui/Card";
import { StatusTag } from "@/components/ui/Tag";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Address } from "@/components/ui/Address";
import { LinkButton } from "@/components/ui/Button";
import type { TimeRange, VolPoint } from "@/components/charts/VolatilityChart";
import { ChartLegend } from "@/components/charts/ChartLegend";
import { TradeRail } from "./TradeRail";
import { CollateralCard } from "./CollateralCard";
import { FillsFeed } from "./FillsFeed";
import { ProgramViewer } from "./ProgramViewer";
import { MoneyFlow } from "./MoneyFlow";
import { GraphHistoryCard } from "./GraphHistoryCard";

const VolatilityChart = dynamic(() => import("@/components/charts/VolatilityChart").then((m) => m.VolatilityChart), {
  ssr: false,
});
const PricePathChart = dynamic(() => import("@/components/charts/PricePathChart").then((m) => m.PricePathChart), { ssr: false });
const PayoffChart = dynamic(() => import("@/components/charts/PayoffChart").then((m) => m.PayoffChart), { ssr: false });

function Header({ s, now }: { s: SeriesState; now: number }) {
  const p = s.params;
  const upcoming = s.status === Status.Upcoming;
  return (
    <section className="market-terminal-head" aria-labelledby="market-title">
      <div className="market-terminal-identity">
        <div className="min-w-0 flex-1">
          <Link href="/markets" className="bracket bracket-muted">
            Markets
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 id="market-title" className="h-page">{receiptSymbol(s)}</h1>
            <StatusTag status={s.status} issuanceOpen={s.legs.issuanceOpen} />
          </div>
          <p className="mt-2 max-w-2xl text-[14px] text-ink-2">
            Capped ETH realized-variance receipt · pays{" "}
            <span className="tnum">{fmtUsdc(s.params.unitNotional)}</span> USDC per unit per 1.0 of realized
            variance, up to a {fmtVolPct(s.params.capVariance)}% volatility cap.
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
          {s.legs.issuanceOpen ? (
            <div>
              <dt className="label">Sale close</dt>
              <dd className="m-0 text-[13px]">{fmtDateTime(p.saleEnd)}</dd>
            </div>
          ) : null}
        </dl>
      </div>

      <dl className="market-tape">
        <div className="market-tape-primary">
          <dt>Bid / ask per unit</dt>
          <dd>
            {fmtUsdc(s.quote.bidPerUnit)} / {fmtUsdc(s.quote.askPerUnit)} <small>USDC</small>
          </dd>
          <span>executable, both sides</span>
        </div>
        <div>
          <dt>{isFinalized(s) ? "Final realized vol" : "Realized vol so far"}</dt>
          <dd>{upcoming || (s.oracle.samplesStored <= 1 && !isFinalized(s)) ? "—" : `${realizedVolPct(s)}%`}</dd>
          <span>
            {upcoming
              ? "window not started"
              : isFinalized(s)
                ? "fixed on chain at finalization"
                : `${s.oracle.samplesStored} of ${s.oracle.samplesTotal} samples`}
          </span>
        </div>
        <div>
          <dt>Market vol</dt>
          <dd>{marketVolPct(s)}%</dd>
          <span>this market&apos;s quote, not a fair value</span>
        </div>
        <div>
          <dt>Locked backing</dt>
          <dd>{fmtUsdc(s.lockedLiability, 0)}</dd>
          <span>{fmtUnits(s.unitsOutstanding, 0)} units outstanding</span>
        </div>
      </dl>
      {checkpointsBehind(s) > 0 ? (
        <p className="mt-3 border border-line bg-bg-2 p-3 text-[13px] text-ink-2" role="status">
          {checkpointsBehind(s)} Chainlink sample{checkpointsBehind(s) === 1 ? "" : "s"} have passed without
          being stored, so this market cannot quote until somebody updates it. Anyone can, from the Oracle
          tab in the ticket.
        </p>
      ) : null}
      <details className="market-advanced">
        <summary>
          Advanced details <span className="mono">#{s.id.toString()}</span>
        </summary>
        <div className="market-advanced-grid">
          <span>
            Window start <b>{fmtDateTime(p.start)}</b>
          </span>
          <span>
            Sampling <b>{fmtDuration(p.sampleInterval)}</b>
          </span>
          <span>
            Writer <Address value={s.writer} />
          </span>
          <span>
            Maker vault <Address value={s.vault} />
          </span>
          <span>
            Receipt contract <Address value={s.receipt} />
          </span>
          <span>
            Volatility cap <b>{fmtVolPct(p.capVariance)}%</b>
          </span>
          <span>
            Samples{" "}
            <b>
              {s.oracle.samplesStored}/{s.oracle.samplesTotal}
            </b>
          </span>
          <span>
            Half-spread <b>{p.halfSpreadBps} bps</b>
          </span>
        </div>
      </details>
    </section>
  );
}

type ChartView = "volatility" | "price" | "payoff";

/**
 * The reading under the chart: what volatility actually did, what this market is quoting, and the
 * spread between the two executable prices. Deliberately not labelled "implied volatility" — nothing
 * here comes from an option surface.
 */
function VolatilityQuote({ points, s }: { points: VolPoint[]; s: SeriesState }) {
  const realized = [...points].reverse().find((point) => point.realized !== undefined)?.realized;
  const market = [...points].reverse().find((point) => point.market !== undefined)?.market ?? volPctNumber(s.quote.marketVariance);
  const realizedStart = points.find((point) => point.realized !== undefined)?.realized;
  const change = realized !== undefined && realizedStart !== undefined ? realized - realizedStart : undefined;
  const spreadPct = volPctNumber(s.quote.askVariance) - volPctNumber(s.quote.bidVariance);
  return (
    <div className="volatility-quote" aria-label="Current volatility reading">
      <div className="volatility-quote-current">
        <span>Realized volatility</span>
        <b>
          {realized !== undefined
            ? `${realized.toFixed(1)}%`
            : s.oracle.samplesStored > 1 || isFinalized(s)
              ? `${realizedVolPct(s)}%`
              : "—"}
        </b>
        <small>{isFinalized(s) ? "fixed on chain" : `${s.oracle.samplesStored}/${s.oracle.samplesTotal} samples stored`}</small>
      </div>
      <div>
        <span>Market volatility</span>
        <b>{market.toFixed(1)}%</b>
        <small>this market&apos;s quote</small>
      </div>
      <div>
        <span>Spread</span>
        <b>{spreadPct >= 0 ? `${spreadPct.toFixed(1)}%` : "—"}</b>
        <small>
          {fmtUsdc(s.quote.bidPerUnit)} / {fmtUsdc(s.quote.askPerUnit)} per unit
        </small>
      </div>
      <div>
        <span>Change</span>
        <b className={change !== undefined && change >= 0 ? "text-up" : "text-ink"}>
          {change !== undefined ? `${change >= 0 ? "+" : ""}${change.toFixed(1)}%` : "—"}
        </b>
        <small>visible range</small>
      </div>
    </div>
  );
}

/**
 * The connected holder's position.
 *
 * `indexedEntry` covers only fills this indexer saw for this address. A receipt that arrived by plain
 * ERC-20 transfer has no entry price, so the cost basis and the P&L show an em dash rather than a
 * number that would be made up. Before expiry the live value is the executable exit bid; after
 * finalization it is the fixed redemption value. Neither is a mark-to-model.
 */
function PositionSummary({ s, now, indexedEntry }: { s: SeriesState; now: number; indexedEntry?: bigint }) {
  const { address } = useAccount();
  const balance = useTokenBalance(s.receipt, address);
  const units = balance.data ?? 0n;
  if (!address || (balance.data !== undefined && units === 0n)) return null;

  const costBasisKnown = indexedEntry !== undefined && indexedEntry > 0n;
  const indexedCost = costBasisKnown ? (indexedEntry * units) / WAD : undefined;
  const exitValue = s.legs.exitOpen ? perUnitPrice(s.params.unitNotional, s.quote.bidVariance) * units / WAD : undefined;
  const redemptionValue = isFinalized(s) ? payoutFor(units, s.payoutPerUnit) : undefined;
  const liveValue = redemptionValue ?? exitValue;
  const pnl = liveValue !== undefined && indexedCost !== undefined ? liveValue - indexedCost : undefined;
  const maxPayout = (units * maxPayoutPerUnit(s.params)) / WAD;

  return (
    <Card
      className="position-summary"
      title="Your position"
      meta={
        isFinalized(s)
          ? "Final redemption value at the variance fixed on chain"
          : s.legs.exitOpen
            ? "Live value is the exit bid you can actually hit"
            : "No exit market open right now"
      }
    >
      <div className="position-summary-grid">
        <div>
          <span>Units held</span>
          <b>{fmtUnits(units, 4)}</b>
        </div>
        <div>
          <span>Indexed average entry</span>
          <b>{costBasisKnown ? `${fmtUsdc(indexedEntry)} USDC` : "—"}</b>
        </div>
        <div>
          <span>Indexed cost</span>
          <b>{indexedCost !== undefined ? `${fmtUsdc(indexedCost)} USDC` : "—"}</b>
        </div>
        <div>
          <span>{isFinalized(s) ? "Redemption value" : "Executable exit value"}</span>
          <b>{liveValue !== undefined ? `${fmtUsdc(liveValue)} USDC` : "—"}</b>
        </div>
        <div>
          <span>Unrealized P&amp;L</span>
          <b className={pnl === undefined ? undefined : pnl >= 0n ? "text-up" : "text-down"}>
            {pnl !== undefined ? `${pnl < 0n ? "−" : "+"}${fmtUsdc(pnl < 0n ? -pnl : pnl)} USDC` : "—"}
          </b>
        </div>
        <div>
          <span>Maximum payout</span>
          <b>{fmtUsdc(maxPayout)} USDC</b>
        </div>
        <div>
          <span>Expiry</span>
          <b>
            {fmtDateTime(s.params.expiry)}
            {now ? ` · ${fmtRelative(s.params.expiry, now)}` : ""}
          </b>
        </div>
      </div>
      {!costBasisKnown ? (
        <p className="mt-3 text-[12px] text-ink-3">
          No indexed buys for this address, so the entry price is unknown. Receipts that arrived by
          transfer carry no cost basis, and inventing one would be worse than leaving it blank.
        </p>
      ) : null}
    </Card>
  );
}

export function SeriesDetail({ idStr }: { idStr: string }) {
  const id = useMemo(() => {
    try {
      return BigInt(idStr);
    } catch {
      return undefined;
    }
  }, [idStr]);
  const view = useSeries(id);
  const now = useNow(30_000);
  const market = useMarket(id);
  const variance = useVariance(id);
  const apiOnline = useApiOnline();
  const { address } = useAccount();
  const portfolio = usePortfolio(address);
  const [ticket, setTicket] = useState<{ units: bigint; premium: bigint }>({ units: WAD, premium: 0n });
  const [chartView, setChartView] = useState<ChartView>("volatility");
  const [timeRange, setTimeRange] = useState<TimeRange>("PAST");
  const onUnitsChange = useCallback((units: bigint, premium: bigint) => setTicket({ units, premium }), []);

  const s = view.data;

  /**
   * The chart's series.
   *
   * The backend reconstructs the historical path — realized volatility, this market's quote, and the
   * executable band at each point — from indexed fills and checkpoints, because no contract stores it.
   * The live point is always appended from the chain so the chart still says something true with the
   * API offline.
   */
  const volPoints = useMemo<VolPoint[]>(() => {
    if (!s) return [];
    const pts: VolPoint[] = (market.data?.points ?? []).map((p) => ({
      t: p.t,
      realized: p.realizedVol * 100,
      market: p.marketVol * 100,
      projected: p.projectedVol * 100,
      bid: volPctNumber(p.bidVariance),
      ask: volPctNumber(p.askVariance),
      realizedVariance: Number(p.realizedVariance) / 1e18,
      bidPerUnit: usdcNumber(p.bidPerUnit),
      askPerUnit: usdcNumber(p.askPerUnit),
      checkpointsFresh: p.checkpointsFresh,
    }));
    if (now) {
      pts.push({
        t: Math.min(now, s.params.expiry),
        realized: s.oracle.samplesStored > 1 || isFinalized(s) ? volPctNumber(effectiveVariance(s)) : undefined,
        market: volPctNumber(s.quote.marketVariance),
        projected: volPctNumber(s.quote.projectedVariance),
        bid: volPctNumber(s.quote.bidVariance),
        ask: volPctNumber(s.quote.askVariance),
        realizedVariance: Number(effectiveVariance(s)) / 1e18,
        bidPerUnit: usdcNumber(s.quote.bidPerUnit),
        askPerUnit: usdcNumber(s.quote.askPerUnit),
        checkpointsFresh: s.oracle.checkpointsCurrent,
      });
    }
    return pts;
  }, [s, market.data, now]);

  /** The holder's indexed entry price, or undefined when this address has no indexed buys. */
  const indexedEntry = useMemo(() => {
    if (!s || !portfolio.data) return undefined;
    const pos = portfolio.data.positions.find((p) => BigInt(p.seriesId) === s.id);
    if (!pos || !pos.costBasisKnown || !pos.indexedEntryPerUnit) return undefined;
    return pos.indexedEntryPerUnit;
  }, [s, portfolio.data]);

  const prices = useMemo(() => (variance.data?.samples ?? []).map((x) => ({ t: x.t, price: x.price })), [variance.data]);
  const rpcOnline = useRpcOnline();

  if (id === undefined) return <EmptyState>Invalid series id.</EmptyState>;

  if (view.isLoading || (!s && !view.notFound)) {
    return (
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(360px,1fr)]">
        <div className="flex flex-col gap-6">
          <div className="card">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="mt-3 h-4 w-80" />
          </div>
          <div className="grid gap-4 md:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="card">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-3 h-10 w-24" />
              </div>
            ))}
          </div>
        </div>
        <div className="panel p-4">
          <Skeleton dark className="h-6 w-40" />
          <Skeleton dark className="mt-4 h-40 w-full" />
        </div>
      </div>
    );
  }

  if (!s) {
    return (
      <Card>
        <EmptyState action={<LinkButton href="/markets" variant="tertiary" size="sm">Back to markets</LinkButton>}>
          {/*
            A missing series and an outage look identical from here — both sources error — so the
            distinguishing signal is whether the RPC answers at all. A `SeriesNotFound` revert is an
            answer, and telling the user the node is down when it is not would send them debugging
            the wrong thing.
          */}
          {!isDeployed
            ? "Contracts are not deployed on this chain."
            : rpcOnline === false && view.apiError
              ? "Neither the RPC nor the API answered."
              : `Series #${idStr} was not found.`}
        </EmptyState>
      </Card>
    );
  }

  const rv = effectiveVariance(s);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(360px,1fr)] xl:items-start">
      {/* left 2/3: white workspace */}
      <div className="flex min-w-0 flex-col gap-6">
        <Header s={s} now={now} />
        <PositionSummary s={s} now={now} indexedEntry={indexedEntry} />

        <Card
          className="market-chart-card"
          title={chartView === "volatility" ? "Realized vs market volatility" : chartView === "price" ? "Oracle samples" : "Receipt payoff"}
          meta={
            chartView === "volatility"
              ? "What volatility did, what this market quotes, and the band you can actually trade"
              : chartView === "price"
                ? "The Chainlink rounds the settlement window samples"
                : "The final payout depends on realized ETH volatility at expiry."
          }
          action={
            <Segmented
              label="Chart view"
              value={chartView}
              onChange={setChartView}
              options={[
                { value: "volatility", label: "Volatility" },
                { value: "price", label: "Price" },
                { value: "payoff", label: "Payoff" },
              ]}
            />
          }
        >
          {chartView === "volatility" ? (
            <>
              <VolatilityQuote points={volPoints} s={s} />
              <div className="volatility-chart-controls">
                <span className="micro">Annualized volatility</span>
                <Segmented
                  label="Time range"
                  value={timeRange}
                  onChange={setTimeRange}
                  options={["PAST", "1D", "1W", "1M", "3M", "ALL"].map((value) => ({
                    value: value as TimeRange,
                    label: value === "PAST" ? "Past" : value,
                  }))}
                />
              </div>
              <ChartLegend
                items={[
                  { label: "Realized volatility", swatch: "hatch" },
                  { label: "Market quote volatility", swatch: "dashed" },
                  { label: "Executable bid/ask band", swatch: "band" },
                ]}
              />
              {apiOnline === false && volPoints.length <= 1 ? (
                <p className="small mb-2 text-ink-3">API offline — showing the live on-chain point only.</p>
              ) : null}
              <VolatilityChart
                points={volPoints}
                capVolPct={volPctNumber(s.params.capVariance)}
                start={s.params.start}
                expiry={s.params.expiry}
                saleEnd={s.params.saleEnd}
                processedThrough={s.oracle.processedThrough}
                now={now}
                timeRange={timeRange}
                height={440}
              />
            </>
          ) : chartView === "payoff" ? (
            <PayoffChart
              unitNotional={s.params.unitNotional}
              capVariance={s.params.capVariance}
              breakEvenVariance={
                ticket.premium > 0n ? breakEvenVariance(ticket.premium, ticket.units, s.params.unitNotional) : s.quote.askVariance
              }
              realizedVariance={rv > 0n ? rv : undefined}
              units={ticket.units}
              premiumUsdc={ticket.premium > 0n ? ticket.premium : s.quote.askPerUnit}
              height={480}
            />
          ) : chartView === "price" ? (
            apiOnline === false ? <EmptyState>API offline — sampled prices are served by the backend.</EmptyState> : <PricePathChart data={prices} id={`p${idStr}`} height={320} />
          ) : null}
        </Card>

        <details className="terminal-advanced">
          <summary>
            Advanced details <span>Programs, fills, locked collateral, and immutable terms</span>
          </summary>
          <div className="flex flex-col gap-6 pt-6">
            <MoneyFlow />
            <FillsFeed s={s} />
            <GraphHistoryCard s={s} />
            <ProgramViewer s={s} />
            <div className="grid gap-6 lg:grid-cols-2">
              <CollateralCard s={s} />
              <Card title="Parameters" meta="Immutable series terms">
            <dl className="m-0">
              {[
                ["Unit notional", `${fmtUsdc(s.params.unitNotional)} USDC`],
                ["Cap", `${fmtVolPct(s.params.capVariance)}% vol`],
                ["Anchor variance", `${fmtVolPct(s.params.anchorVariance)}% vol`],
                ["Impact / unit", `${fmtWad(s.params.impactPerUnit, 4)} var / unit`],
                ["Half-spread", `${s.params.halfSpreadBps} bps`],
                ["Skew half-life", s.params.halfLife ? fmtDuration(s.params.halfLife) : "none"],
                ["Sampling", fmtDuration(s.params.sampleInterval)],
                ["Max units", fmtUnits(s.params.maxUnits, 0)],
                ["Max payout / unit", `${fmtUsdc(s.quote.maxPayoutPerUnit)} USDC`],
                ["Payout / unit", isFinalized(s) ? `${fmtUsdc(s.payoutPerUnit)} USDC` : "not yet fixed"],
              ].map(([k, v]) => (
                <div key={k} className="kv">
                  <dt className="text-[13px] text-ink-2">{k}</dt>
                  <dd className="m-0 text-right tnum font-medium">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 flex flex-col gap-1 text-[11px] text-ink-3">
              <span className="mono break-all">issue {s.issueOrderHash}</span>
              <span className="mono break-all">exit {s.exitOrderHash}</span>
              <span className="mono break-all">settle {s.settlementOrderHash}</span>
            </div>
              </Card>
            </div>
          </div>
        </details>
      </div>

      {/* right 1/3: inverted trade rail */}
      <TradeRail s={s} indexedEntry={indexedEntry} onUnitsChange={onUnitsChange} />
    </div>
  );
}
