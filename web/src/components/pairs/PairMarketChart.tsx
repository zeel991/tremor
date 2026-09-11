"use client";

import { useId, useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  Area,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { C, axisProps, cursorProps, fmtTimeTick, MARKER_MAX_POINTS } from "@/components/charts/theme";
import { InkTooltip } from "@/components/charts/ChartTooltip";
import { SquareDot, HatchPattern, hatchUrl } from "@/components/charts/hatch";
import { Segmented } from "@/components/ui/Segmented";
import { Card } from "@/components/ui/Card";
import {
  fmtPriceUsdc,
  fmtVolPct,
  fmtWad,
  minBig,
  usdcNumber,
  volPctNumber,
  WAD,
  YEAR_SECONDS,
} from "@/lib/format";
import { type GroupState, sideSymbol } from "@/lib/portfolio";
import { usePairsCheckpoints } from "@/lib/api";
import { useGroupRealized } from "@/lib/portfolio-chain";
import { useNow } from "@/lib/hooks";
import { PairPayoffChart } from "./PairPayoffChart";

export interface PairChartPoint {
  t: number;
  /** HIGH indicative / settlement price in USDC per unit */
  highPrice: number;
  /** CALM indicative / settlement price in USDC per unit */
  calmPrice: number;
  /** Realized annualized volatility so far, in percent */
  realizedVol?: number;
  /** Raw variance in WAD */
  varianceWad?: bigint;
}

type PairChartView = "prices" | "volatility" | "payoff";

export function PairMarketChart({ g }: { g: GroupState }) {
  const uid = useId().replace(/:/g, "");
  const [view, setView] = useState<PairChartView>("prices");
  const now = useNow(30_000);

  const checkpointsQuery = usePairsCheckpoints(g.id);
  const realizedQuery = useGroupRealized(g.id);

  const p = g.params;
  const S_num = usdcNumber(p.capPayoutPerUnit);
  const capVol = volPctNumber(p.capVariance);

  // Construct continuous trajectory points from checkpoints & live status
  const points = useMemo<PairChartPoint[]>(() => {
    const pts: PairChartPoint[] = [];
    const tStart = p.start;
    const tExpiry = p.expiry;

    // 1. Initial point at window start: variance = 0
    pts.push({
      t: tStart,
      highPrice: 0,
      calmPrice: S_num,
      realizedVol: 0,
      varianceWad: 0n,
    });

    // 2. Checkpoints from indexer
    const cps = checkpointsQuery.data ?? [];
    for (const cp of cps) {
      const t = cp.processedThrough;
      if (t <= tStart) continue;
      const elapsed = BigInt(t - tStart);
      const sum = cp.sumSquaredReturns;
      let varWad = 0n;
      if (elapsed > 0n && sum > 0n) {
        varWad = (sum * YEAR_SECONDS) / elapsed;
      }
      const x = p.capVariance > 0n ? minBig((varWad * WAD) / p.capVariance, WAD) : 0n;
      const hp = (p.capPayoutPerUnit * x) / WAD;
      const cpVal = p.capPayoutPerUnit - hp;
      const vol = volPctNumber(varWad);

      pts.push({
        t,
        highPrice: usdcNumber(hp),
        calmPrice: usdcNumber(cpVal),
        realizedVol: +vol.toFixed(2),
        varianceWad: varWad,
      });
    }

    // 3. Live or Final point
    if (g.finalized) {
      const hp = usdcNumber(g.highPpu);
      const cpVal = usdcNumber(g.calmPpu);
      const vol = volPctNumber(g.finalVariance);
      pts.push({
        t: tExpiry,
        highPrice: hp,
        calmPrice: cpVal,
        realizedVol: +vol.toFixed(2),
        varianceWad: g.finalVariance,
      });
    } else if (now && now > tStart) {
      const tNow = Math.min(now, tExpiry);
      const curVar = realizedQuery.data?.variance ?? 0n;
      const x = p.capVariance > 0n ? minBig((curVar * WAD) / p.capVariance, WAD) : 0n;
      const hp = (p.capPayoutPerUnit * x) / WAD;
      const cpVal = p.capPayoutPerUnit - hp;
      const vol = volPctNumber(curVar);

      pts.push({
        t: tNow,
        highPrice: usdcNumber(hp),
        calmPrice: usdcNumber(cpVal),
        realizedVol: +vol.toFixed(2),
        varianceWad: curVar,
      });
    }

    // Sort uniquely by timestamp
    const seen = new Set<number>();
    const unique: PairChartPoint[] = [];
    for (const pt of pts.sort((a, b) => a.t - b.t)) {
      if (!seen.has(pt.t)) {
        seen.add(pt.t);
        unique.push(pt);
      }
    }

    // If only 1 point, synthesize an end point so chart renders line
    if (unique.length === 1) {
      unique.push({
        t: tExpiry,
        highPrice: unique[0].highPrice,
        calmPrice: unique[0].calmPrice,
        realizedVol: unique[0].realizedVol,
        varianceWad: unique[0].varianceWad,
      });
    }

    return unique;
  }, [p, S_num, checkpointsQuery.data, realizedQuery.data, g, now]);

  const t0 = p.start;
  const t1 = p.expiry;
  const span = Math.max(1, t1 - t0);
  const showDots = points.length <= MARKER_MAX_POINTS;
  const hatchId = `hatch-vol-pair-${uid}`;

  const latest = points[points.length - 1];

  return (
    <Card
      className="market-chart-card"
      title={
        view === "prices"
          ? "Live HIGH & CALM Trajectory"
          : view === "volatility"
            ? "Realized Volatility Path"
            : "HIGH vs CALM Payoff Curves"
      }
      meta={
        view === "prices"
          ? "Live unit value across the observation window vs writer quotes"
          : view === "volatility"
            ? "Annualized realized volatility from oracle checkpoints vs cap"
            : "Complementary payout curves summing to cap payout S"
      }
      action={
        <Segmented
          label="Chart view"
          value={view}
          onChange={setView}
          options={[
            { value: "prices", label: "Live Prices" },
            { value: "volatility", label: "Realized Vol" },
            { value: "payoff", label: "Payoff Curves" },
          ]}
        />
      }
    >
      {view === "payoff" ? (
        <PairPayoffChart g={g} />
      ) : view === "prices" ? (
        <div>
          {/* Price reading header */}
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-4 border-b border-line pb-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 bg-lime inline-block" />
                <span className="text-[13px] font-medium text-ink">
                  HIGH: <b className="font-mono">${fmtPriceUsdc(g.finalized ? g.highPpu : p.askHigh)}</b>
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 bg-ink inline-block" />
                <span className="text-[13px] font-medium text-ink">
                  CALM: <b className="font-mono">${fmtPriceUsdc(g.finalized ? g.calmPpu : p.askCalm)}</b>
                </span>
              </div>
            </div>
            <div className="text-[12px] text-ink-3">
              Cap payout: <b className="font-mono text-ink">${fmtPriceUsdc(p.capPayoutPerUnit)} USDC</b>
            </div>
          </div>

          <div style={{ height: 280 }} role="img" aria-label="HIGH and CALM prices over time">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={points} margin={{ top: 12, right: 12, bottom: 0, left: -4 }}>
                <CartesianGrid stroke={C.line} vertical={false} />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={[t0, t1]}
                  tickFormatter={(t: number) => fmtTimeTick(t, span)}
                  {...axisProps}
                  minTickGap={40}
                />
                <YAxis
                  domain={[0, S_num * 1.05]}
                  tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                  {...axisProps}
                  width={56}
                />
                <Tooltip
                  cursor={cursorProps}
                  content={
                    <InkTooltip
                      labelFormat={(l) =>
                        typeof l === "number"
                          ? new Date(l * 1000).toLocaleString("en-US", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: false,
                            })
                          : undefined
                      }
                      format={(it) => {
                        if (it.dataKey === "highPrice") return `HIGH: $${Number(it.value).toFixed(6)} USDC`;
                        if (it.dataKey === "calmPrice") return `CALM: $${Number(it.value).toFixed(6)} USDC`;
                        return `${it.name}: ${it.value}`;
                      }}
                      details={(items) => {
                        const pt = items[0]?.payload as PairChartPoint | undefined;
                        if (!pt) return null;
                        return (
                          <div className="mt-1 border-t border-line pt-1 text-[11px] text-ink-2">
                            <div>Realized vol: {pt.realizedVol?.toFixed(1) ?? "—"}%</div>
                            <div>Sum (H + C): ${(pt.highPrice + pt.calmPrice).toFixed(4)} USDC</div>
                          </div>
                        );
                      }}
                    />
                  }
                />
                <ReferenceLine
                  y={S_num}
                  stroke={C.ink3}
                  strokeDasharray="2 4"
                  label={{ value: `Cap $${S_num.toFixed(2)}`, fill: C.ink3, fontSize: 11, position: "insideTopRight" }}
                />
                {/* Fixed ask benchmarks */}
                {!g.finalized && (
                  <>
                    <ReferenceLine
                      y={usdcNumber(p.askHigh)}
                      stroke={C.limeDark}
                      strokeDasharray="3 3"
                      label={{ value: `Ask H $${usdcNumber(p.askHigh).toFixed(2)}`, fill: C.limeDark, fontSize: 10, position: "insideTopLeft" }}
                    />
                    <ReferenceLine
                      y={usdcNumber(p.askCalm)}
                      stroke={C.ink2}
                      strokeDasharray="3 3"
                      label={{ value: `Ask C $${usdcNumber(p.askCalm).toFixed(2)}`, fill: C.ink2, fontSize: 10, position: "insideBottomLeft" }}
                    />
                  </>
                )}
                <Line
                  type="stepAfter"
                  dataKey="highPrice"
                  name="HIGH"
                  stroke={C.limeDark}
                  strokeWidth={2.5}
                  dot={showDots ? <SquareDot fill={C.lime} stroke={C.ink} size={6} /> : false}
                  activeDot={<SquareDot fill={C.lime} stroke={C.ink} size={8} />}
                  isAnimationActive={false}
                />
                <Line
                  type="stepAfter"
                  dataKey="calmPrice"
                  name="CALM"
                  stroke={C.ink}
                  strokeWidth={2}
                  dot={showDots ? <SquareDot fill={C.ink} stroke={C.ink} size={6} /> : false}
                  activeDot={<SquareDot fill={C.ink} stroke={C.ink} size={8} />}
                  isAnimationActive={false}
                />
                {latest ? (
                  <>
                    <ReferenceDot x={latest.t} y={latest.highPrice} r={4} shape={<SquareDot fill={C.lime} stroke={C.ink} size={8} />} />
                    <ReferenceDot x={latest.t} y={latest.calmPrice} r={4} shape={<SquareDot fill={C.ink} stroke={C.white} size={8} />} />
                  </>
                ) : null}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-[12px] text-ink-3">
            <span>
              Real-time trajectory of 1 unit of HIGH and CALM as ETH variance checkpoints accumulate.
            </span>
            <span className="font-mono">
              Identity: HIGH + CALM = ${fmtPriceUsdc(p.capPayoutPerUnit)} USDC
            </span>
          </div>
        </div>
      ) : (
        <div>
          {/* Volatility reading header */}
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-4 border-b border-line pb-3">
            <div>
              <span className="text-[12px] uppercase text-ink-3">Realized Volatility</span>
              <div className="mt-0.5 text-[22px] font-mono font-medium text-ink">
                {g.finalized ? `${fmtVolPct(g.finalVariance)}%` : `${latest?.realizedVol?.toFixed(1) ?? "0.0"}%`}
              </div>
            </div>
            <div className="text-right">
              <span className="text-[12px] uppercase text-ink-3">Volatility Cap</span>
              <div className="mt-0.5 text-[22px] font-mono font-medium text-ink-2">
                {capVol.toFixed(1)}%
              </div>
            </div>
          </div>

          <div style={{ height: 280 }} role="img" aria-label="Realized volatility path over time">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={points} margin={{ top: 12, right: 12, bottom: 0, left: -4 }}>
                <defs>
                  <HatchPattern id={hatchId} />
                </defs>
                <CartesianGrid stroke={C.line} vertical={false} />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={[t0, t1]}
                  tickFormatter={(t: number) => fmtTimeTick(t, span)}
                  {...axisProps}
                  minTickGap={40}
                />
                <YAxis
                  domain={[0, Math.max(capVol * 1.15, (latest?.realizedVol ?? 0) * 1.2, 10)]}
                  tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                  {...axisProps}
                  width={56}
                />
                <Tooltip
                  cursor={cursorProps}
                  content={
                    <InkTooltip
                      labelFormat={(l) =>
                        typeof l === "number"
                          ? new Date(l * 1000).toLocaleString("en-US", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: false,
                            })
                          : undefined
                      }
                      format={(it) => `Realized vol: ${Number(it.value).toFixed(1)}%`}
                    />
                  }
                />
                <ReferenceLine
                  y={capVol}
                  stroke={C.ink3}
                  strokeDasharray="2 4"
                  label={{ value: `Cap ${capVol.toFixed(0)}%`, fill: C.ink3, fontSize: 11, position: "insideTopRight" }}
                />
                <Area
                  type="stepAfter"
                  dataKey="realizedVol"
                  name="Realized vol"
                  stroke={C.ink}
                  strokeWidth={2}
                  fill={hatchUrl(hatchId)}
                  fillOpacity={1}
                  dot={showDots ? <SquareDot /> : false}
                  activeDot={<SquareDot />}
                  isAnimationActive={false}
                />
                {latest?.realizedVol !== undefined ? (
                  <ReferenceDot
                    x={latest.t}
                    y={latest.realizedVol}
                    r={4}
                    shape={<SquareDot fill={C.lime} stroke={C.ink} size={8} />}
                  />
                ) : null}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-[12px] text-ink-3">
            <span>
              Annualized variance measured from Chainlink ETH/USD oracle updates across the observation window.
            </span>
            <span>
              Cap: {capVol.toFixed(0)}% vol ({fmtWad(p.capVariance, 2)} WAD)
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
