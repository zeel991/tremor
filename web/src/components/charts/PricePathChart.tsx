"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { C, MARKER_MAX_POINTS, axisProps, cursorProps, fmtTimeTick } from "./theme";
import { InkTooltip } from "./ChartTooltip";
import { HatchPattern, SquareDot, hatchUrl } from "./hatch";
import { EmptyState } from "@/components/ui/EmptyState";
import { fmtUsd } from "@/lib/format";
import { ChartDataTable } from "./ChartDataTable";

export function PricePathChart({ data, height = 200, id = "price" }: { data: Array<{ t: number; price: number }>; height?: number; id?: string }) {
  if (data.length < 2) return <EmptyState>No sampled prices yet.</EmptyState>;
  const span = Math.max(1, data[data.length - 1].t - data[0].t);
  const hatchId = `hatch-${id}`;
  const showDots = data.length <= MARKER_MAX_POINTS;
  return (
    <div style={{ height }} role="img" aria-label="Sampled Chainlink ETH to USD price path">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
          <defs>
            <HatchPattern id={hatchId} />
          </defs>
          <CartesianGrid stroke={C.line} vertical={false} />
          <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(t: number) => fmtTimeTick(t, span)} {...axisProps} minTickGap={40} />
          <YAxis domain={["auto", "auto"]} tickFormatter={(v: number) => fmtUsd(v, true)} {...axisProps} width={64} />
          <Tooltip
            cursor={cursorProps}
            content={<InkTooltip labelFormat={(l) => (typeof l === "number" ? fmtTimeTick(l, 3600) : undefined)} format={(it) => fmtUsd(Number(it.value))} />}
          />
          <Area
            type="linear"
            dataKey="price"
            name="ETH/USD"
            stroke={C.ink}
            strokeWidth={1.5}
            fill={hatchUrl(hatchId)}
            fillOpacity={1}
            dot={showDots ? <SquareDot /> : false}
            activeDot={<SquareDot />}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
      <ChartDataTable
        caption="Sampled Chainlink ETH to USD prices"
        headers={["Unix time", "ETH price in USD"]}
        rows={data.map((point) => [point.t, point.price])}
      />
    </div>
  );
}
