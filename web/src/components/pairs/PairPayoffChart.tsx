"use client";

import { useId, useMemo } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { C, axisProps, cursorProps } from "@/components/charts/theme";
import { InkTooltip } from "@/components/charts/ChartTooltip";
import { HatchPattern, SquareDot, hatchUrl } from "@/components/charts/hatch";
import { ChartDataTable } from "@/components/charts/ChartDataTable";
import { fmtUsd, usdcNumber, volPctNumber } from "@/lib/format";
import type { GroupState } from "@/lib/portfolio";

/**
 * The two complementary capped payoffs of a risk group vs realized vol %:
 * HIGH pays S·x and CALM pays S·(1−x), so at every point the two lines sum to S — that identity is
 * the whole reason one reserve of max(high, calm)·S backs both sides.
 */
export function PairPayoffChart({ g, height = 320 }: { g: GroupState; height?: number }) {
  const uid = useId().replace(/:/g, "");
  const capVol = volPctNumber(g.params.capVariance);
  const S = usdcNumber(g.params.capPayoutPerUnit);
  const rvVol = g.finalized && g.finalVariance > 0n ? volPctNumber(g.finalVariance) : undefined;
  const maxX = Math.max(capVol * 1.35, (rvVol ?? 0) * 1.2, 10);

  const data = useMemo(() => {
    const pts: Array<{ x: number; high: number; calm: number }> = [];
    const n = 80;
    const capVar = (capVol / 100) ** 2;
    for (let i = 0; i <= n; i++) {
      const x = (maxX * i) / n;
      const frac = capVar > 0 ? Math.min((x / 100) ** 2 / capVar, 1) : 0;
      pts.push({ x: +x.toFixed(2), high: S * frac, calm: S * (1 - frac) });
    }
    if (capVol > 0 && capVol < maxX) pts.push({ x: +capVol.toFixed(2), high: S, calm: 0 });
    return pts.sort((a, b) => a.x - b.x);
  }, [maxX, capVol, S]);

  const hatchHigh = `hatch-pair-high-${uid}`;
  const hatchCalm = `hatch-pair-calm-${uid}`;

  return (
    <div style={{ height }} role="img" aria-label="HIGH and CALM payouts by realized volatility; the two capped lines sum to the shared payout scale">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: -4 }}>
          <defs>
            <HatchPattern id={hatchHigh} />
            <HatchPattern id={hatchCalm} color={C.limeDark} spacing={5} />
          </defs>
          <CartesianGrid stroke={C.line} vertical={false} />
          <XAxis dataKey="x" type="number" domain={[0, maxX]} tickFormatter={(v: number) => `${v.toFixed(0)}%`} {...axisProps} minTickGap={30} />
          <YAxis tickFormatter={(v: number) => fmtUsd(v, true)} {...axisProps} width={64} />
          <Tooltip
            cursor={cursorProps}
            content={
              <InkTooltip
                labelFormat={(l) => (typeof l === "number" ? `σ ${l.toFixed(1)}%` : undefined)}
                format={(it) => `${it.name === "high" ? "HIGH" : "CALM"} ${fmtUsd(Number(it.value))} / unit`}
              />
            }
          />
          {capVol > 0 ? (
            <ReferenceLine x={+capVol.toFixed(2)} stroke={C.limeDark} strokeDasharray="2 3" label={{ value: `Cap ${capVol.toFixed(0)}%`, fill: C.limeDark, fontSize: 11, position: "insideTopRight" }} />
          ) : null}
          {rvVol !== undefined ? (
            <ReferenceLine x={+rvVol.toFixed(2)} stroke={C.ink2} strokeDasharray="5 4" label={{ value: `Final ${rvVol.toFixed(0)}%`, fill: C.ink2, fontSize: 11, position: "insideBottomLeft" }} />
          ) : null}
          <Area type="linear" dataKey="high" name="high" stroke={C.ink} strokeWidth={1.5} fill={hatchUrl(hatchHigh)} fillOpacity={1} dot={false} activeDot={<SquareDot />} isAnimationActive={false} />
          <Area type="linear" dataKey="calm" name="calm" stroke={C.limeDark} strokeWidth={1.5} fill={hatchUrl(hatchCalm)} fillOpacity={0.5} dot={false} activeDot={<SquareDot fill={C.limeDark} />} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
      <ChartDataTable
        caption="HIGH and CALM payout curves per unit"
        headers={["Realized volatility percent", "HIGH payout in USDC", "CALM payout in USDC"]}
        rows={data.map((p) => [p.x, p.high.toFixed(6), p.calm.toFixed(6)])}
      />
      <div className="payoff-readout" aria-label="Payoff identity">
        <div><span>HIGH pays</span><b>S · x</b></div>
        <div><span>CALM pays</span><b>S · (1 − x)</b></div>
        <div><span>Together, always</span><b>{fmtUsd(S)} / unit</b></div>
      </div>
    </div>
  );
}
