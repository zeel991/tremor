"use client";

import { useId, useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { C, MARKER_MAX_POINTS, axisProps, cursorProps, fmtTimeTick } from "./theme";
import { InkTooltip } from "./ChartTooltip";
import { HatchPattern, SquareDot, hatchUrl } from "./hatch";
import { EmptyState } from "@/components/ui/EmptyState";
import { ChartDataTable } from "./ChartDataTable";

/**
 * One point on the volatility terminal.
 *
 * `realized` is what the Chainlink samples actually did. `market` is this market's own quote, not a
 * fair value and not an options-implied volatility — nothing here is derived from an option surface.
 * `bid` and `ask` are executable prices expressed in volatility terms, so the band is the spread a
 * holder would actually cross.
 */
export interface VolPoint {
  t: number;
  /** Annualized realized volatility so far, in percent. */
  realized?: number;
  /** This market's quote volatility, in percent. */
  market?: number;
  /** The projection: realized-so-far blended with the market's forward view, in percent. */
  projected?: number;
  /** The executable band, in percent. */
  bid?: number;
  ask?: number;
  /** Extras for the crosshair. */
  realizedVariance?: number;
  bidPerUnit?: number;
  askPerUnit?: number;
  checkpointsFresh?: boolean;
}

export type TimeRange = "PAST" | "1D" | "1W" | "1M" | "3M" | "ALL";

/**
 * Stock-style volatility chart.
 *
 *   realized     solid ink step area with a hatched fill — the measured path
 *   market quote dashed ink-3 line — what this market is quoting
 *   bid/ask      a flat-filled band between the two executable prices, no gradient
 *
 * Markers for the window start, the last checkpoint, the sale close and expiry, plus a crosshair that
 * reports every series at once including whether the window is currently checkpointed. The band is
 * drawn as `bid` plus the difference stacked on top, which is how a recharts area chart expresses a
 * band without inventing a second axis.
 */
export function VolatilityChart({
  points,
  capVolPct,
  height = 260,
  start,
  expiry,
  saleEnd,
  processedThrough,
  now,
  timeRange = "ALL",
  showBand = true,
}: {
  points: VolPoint[];
  capVolPct?: number;
  height?: number;
  start?: number;
  expiry?: number;
  saleEnd?: number;
  processedThrough?: number;
  now?: number;
  timeRange?: TimeRange;
  showBand?: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  const allData = useMemo(() => [...points].sort((a, b) => a.t - b.t), [points]);
  const data = useMemo(() => {
    const sliced =
      allData.length === 0 || timeRange === "ALL"
        ? allData
        : (() => {
            const end = now ?? allData[allData.length - 1].t;
            if (timeRange === "PAST") return allData.filter((point) => point.t <= end);
            const seconds = { "1D": 86400, "1W": 604800, "1M": 2_592_000, "3M": 7_776_000 }[timeRange];
            const cutoff = Math.max(allData[0].t, end - seconds);
            return allData.filter((point) => point.t >= cutoff && point.t <= end);
          })();
    // The band is stacked, so it needs the lower edge and the height rather than two absolute levels.
    return sliced.map((p) => ({
      ...p,
      bandLow: p.bid,
      bandHeight: p.bid !== undefined && p.ask !== undefined ? Math.max(0, p.ask - p.bid) : undefined,
    }));
  }, [allData, now, timeRange]);

  if (data.length === 0) return <EmptyState>No volatility history yet.</EmptyState>;

  const rangeStart = data[0].t;
  const t0 = timeRange === "ALL" ? (start ?? rangeStart) : rangeStart;
  const t1 =
    timeRange === "ALL"
      ? expiry ?? data[data.length - 1].t
      : Math.min(expiry ?? Number.MAX_SAFE_INTEGER, now ?? data[data.length - 1].t);
  const span = Math.max(1, t1 - t0);
  const hatchId = `hatch-vol-${uid}`;
  const realizedCount = data.filter((d) => d.realized !== undefined).length;
  const showDots = realizedCount > 0 && realizedCount <= MARKER_MAX_POINTS;
  const currentTime = now !== undefined ? Math.min(now, t1) : undefined;
  const latest = [...data].reverse().find((point) => point.realized !== undefined);

  return (
    <div
      style={{ height }}
      role="img"
      aria-label="Realized annualized volatility, this market's quote volatility, and the executable bid/ask band over time"
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
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
          <YAxis tickFormatter={(v: number) => `${v.toFixed(0)}%`} {...axisProps} width={56} domain={[0, "auto"]} />
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
                  if (it.dataKey === "realized") return `Realized vol: ${Number(it.value).toFixed(1)}%`;
                  if (it.dataKey === "market") return `Market vol: ${Number(it.value).toFixed(1)}%`;
                  if (it.dataKey === "projected") return `Projected vol: ${Number(it.value).toFixed(1)}%`;
                  // The stacked band's two keys are geometry, not values a reader wants.
                  if (it.dataKey === "bandLow" || it.dataKey === "bandHeight") return null;
                  return `${it.name}: ${Number(it.value).toFixed(1)}%`;
                }}
                details={(items) => {
                  const point = items[0]?.payload as VolPoint | undefined;
                  if (!point) return null;
                  return (
                    <div className="mt-1 border-t border-line pt-1 text-[11px] text-ink-2">
                      {point.bid !== undefined && point.ask !== undefined ? (
                        <div>
                          Band: {point.bid.toFixed(1)}% / {point.ask.toFixed(1)}% vol
                        </div>
                      ) : null}
                      {point.bidPerUnit !== undefined && point.askPerUnit !== undefined ? (
                        <div>
                          Bid {point.bidPerUnit.toFixed(2)} · ask {point.askPerUnit.toFixed(2)} USDC / unit
                        </div>
                      ) : null}
                      {typeof point.realizedVariance === "number" ? (
                        <div>Realized variance: {point.realizedVariance.toFixed(4)}</div>
                      ) : null}
                      {point.checkpointsFresh === false ? (
                        <div className="text-down">Window not checkpointed at this point</div>
                      ) : null}
                    </div>
                  );
                }}
              />
            }
          />
          {capVolPct ? (
            <ReferenceLine
              y={capVolPct}
              stroke={C.ink3}
              strokeDasharray="2 4"
              label={{ value: "cap", fill: C.ink3, fontSize: 11, position: "insideTopRight" }}
            />
          ) : null}
          {start !== undefined && start >= t0 && start <= t1 ? (
            <ReferenceLine
              x={start}
              stroke={C.ink3}
              strokeDasharray="2 4"
              label={{ value: "Start", fill: C.ink3, fontSize: 11, position: "insideBottomLeft" }}
            />
          ) : null}
          {saleEnd !== undefined && saleEnd > t0 && saleEnd < t1 ? (
            <ReferenceLine
              x={saleEnd}
              stroke={C.ink3}
              strokeDasharray="1 4"
              label={{ value: "Sale ends", fill: C.ink3, fontSize: 11, position: "insideTop" }}
            />
          ) : null}
          {processedThrough !== undefined && processedThrough > t0 && processedThrough <= t1 ? (
            <ReferenceLine
              x={processedThrough}
              stroke={C.ink2}
              strokeDasharray="3 3"
              label={{ value: "Checkpointed", fill: C.ink2, fontSize: 11, position: "insideBottom" }}
            />
          ) : null}
          {currentTime !== undefined && currentTime >= t0 && currentTime <= t1 ? (
            <ReferenceLine
              x={currentTime}
              stroke={C.limeDark}
              strokeDasharray="2 3"
              label={{ value: "Now", fill: C.limeDark, fontSize: 11, position: "insideTopLeft" }}
            />
          ) : null}
          {expiry !== undefined && expiry >= t0 && expiry <= t1 ? (
            <ReferenceLine
              x={expiry}
              stroke={C.ink2}
              strokeDasharray="2 4"
              label={{ value: "Expiry", fill: C.ink2, fontSize: 11, position: "insideBottomRight" }}
            />
          ) : null}
          {showBand ? (
            <>
              <Area
                type="monotone"
                dataKey="bandLow"
                stackId="band"
                name="Bid"
                stroke="none"
                fill="none"
                isAnimationActive={false}
                connectNulls
              />
              <Area
                type="monotone"
                dataKey="bandHeight"
                stackId="band"
                name="Executable band"
                stroke="none"
                fill={C.line2}
                fillOpacity={0.55}
                isAnimationActive={false}
                connectNulls
              />
            </>
          ) : null}
          <Area
            type="stepAfter"
            dataKey="realized"
            name="Realized vol"
            stroke={C.ink}
            strokeWidth={1.5}
            fill={hatchUrl(hatchId)}
            fillOpacity={1}
            dot={showDots ? <SquareDot /> : false}
            activeDot={<SquareDot />}
            connectNulls
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="market"
            name="Market vol"
            stroke={C.ink3}
            strokeWidth={1.5}
            strokeDasharray="4 4"
            dot={false}
            activeDot={<SquareDot fill={C.ink3} />}
            connectNulls
            isAnimationActive={false}
          />
          {latest?.realized !== undefined ? (
            <ReferenceDot x={latest.t} y={latest.realized} r={4} shape={<SquareDot fill={C.lime} stroke={C.ink} size={9} />} />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
      <ChartDataTable
        caption="Realized volatility, market quote volatility and the executable bid/ask band"
        headers={[
          "Unix time",
          "Realized volatility percent",
          "Market quote volatility percent",
          "Bid volatility percent",
          "Ask volatility percent",
        ]}
        rows={data.map((point) => [
          point.t,
          point.realized ?? "Unavailable",
          point.market ?? "Unavailable",
          point.bid ?? "Unavailable",
          point.ask ?? "Unavailable",
        ])}
      />
    </div>
  );
}
