"use client";

import { useId, useMemo } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { C, axisProps, cursorProps } from "./theme";
import { InkTooltip } from "./ChartTooltip";
import { HatchPattern, SquareDot, hatchUrl } from "./hatch";
import { fmtUsd, fmtUnits, usdcNumber, volPctNumber, WAD } from "@/lib/format";
import { ChartDataTable } from "./ChartDataTable";

/**
 * Payout (USDC, for `units`) vs realized vol %. Cap is a flat segment; break-even vol is a dashed
 * vertical marker; current RV-so-far is a square marker.
 */
export function PayoffChart({
  unitNotional,
  capVariance,
  breakEvenVariance,
  realizedVariance,
  units = WAD,
  premiumUsdc,
  height = 240,
}: {
  unitNotional: bigint;
  capVariance: bigint;
  breakEvenVariance?: bigint;
  realizedVariance?: bigint;
  units?: bigint;
  premiumUsdc?: bigint;
  height?: number;
}) {
  const uid = useId().replace(/:/g, "");
  const capVol = volPctNumber(capVariance);
  const notionalPerUnit = usdcNumber(unitNotional); // USD per unit per 1.0 variance
  const unitsN = Number(units) / 1e18;
  const beVol = breakEvenVariance !== undefined && breakEvenVariance > 0n ? volPctNumber(breakEvenVariance) : undefined;
  const rvVol = realizedVariance !== undefined && realizedVariance > 0n ? volPctNumber(realizedVariance) : undefined;
  const maxX = Math.max(capVol * 1.35, (beVol ?? 0) * 1.2, (rvVol ?? 0) * 1.2, 10);

  const data = useMemo(() => {
    const pts: Array<{ x: number; y: number }> = [];
    const n = 80;
    for (let i = 0; i <= n; i++) {
      const x = (maxX * i) / n;
      const variance = Math.min((x / 100) ** 2, capVol > 0 ? (capVol / 100) ** 2 : Infinity);
      pts.push({ x: +x.toFixed(2), y: unitsN * notionalPerUnit * variance });
    }
    // make sure the cap knee is an exact vertex
    if (capVol > 0 && capVol < maxX) pts.push({ x: +capVol.toFixed(2), y: unitsN * notionalPerUnit * (capVol / 100) ** 2 });
    return pts.sort((a, b) => a.x - b.x);
  }, [maxX, capVol, notionalPerUnit, unitsN]);

  const payoutAt = (vol: number) => unitsN * notionalPerUnit * Math.min((vol / 100) ** 2, (capVol / 100) ** 2);
  const hatchId = `hatch-payoff-${uid}`;
  const currentPayout = rvVol !== undefined ? payoutAt(rvVol) : undefined;
  const maxPayout = payoutAt(capVol);

  return (
    <div style={{ height }} role="img" aria-label="Receipt payout by realized volatility, including cap and break-even markers">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: -4 }}>
          <defs>
            <HatchPattern id={hatchId} />
          </defs>
          <CartesianGrid stroke={C.line} vertical={false} />
          <XAxis dataKey="x" type="number" domain={[0, maxX]} tickFormatter={(v: number) => `${v.toFixed(0)}%`} {...axisProps} minTickGap={30} />
          <YAxis tickFormatter={(v: number) => fmtUsd(v, true)} {...axisProps} width={64} />
          <Tooltip
            cursor={cursorProps}
            content={<InkTooltip labelFormat={(l) => (typeof l === "number" ? `σ ${l.toFixed(1)}%` : undefined)} format={(it) => `payout ${fmtUsd(Number(it.value))}`} />}
          />
          {premiumUsdc !== undefined && premiumUsdc > 0n ? (
            <ReferenceLine y={usdcNumber(premiumUsdc)} stroke={C.ink3} strokeDasharray="2 4" label={{ value: "premium paid / required", fill: C.ink3, fontSize: 11, position: "insideBottomRight" }} />
          ) : null}
          {beVol !== undefined ? (
            <ReferenceLine x={+beVol.toFixed(2)} stroke={C.ink2} strokeDasharray="5 4" label={{ value: `Break-even ${beVol.toFixed(0)}%`, fill: C.ink2, fontSize: 11, position: "insideBottomLeft" }} />
          ) : null}
          {capVol > 0 ? (
            <ReferenceLine x={+capVol.toFixed(2)} stroke={C.limeDark} strokeDasharray="2 3" label={{ value: `Cap ${capVol.toFixed(0)}%`, fill: C.limeDark, fontSize: 11, position: "insideTopRight" }} />
          ) : null}
          {rvVol !== undefined ? (
            <ReferenceArea x1={0} x2={+rvVol.toFixed(2)} fill={C.lime} fillOpacity={0.1} label={{ value: "Realized so far", fill: C.limeDark, fontSize: 11, position: "insideTopLeft" }} />
          ) : null}
          <Area type="linear" dataKey="y" name="payout" stroke={C.ink} strokeWidth={1.5} fill={hatchUrl(hatchId)} fillOpacity={1} dot={false} activeDot={<SquareDot />} isAnimationActive={false} />
          {rvVol !== undefined ? <ReferenceDot x={+rvVol.toFixed(2)} y={payoutAt(rvVol)} r={4} label={{ value: "Realized so far", fill: C.limeDark, fontSize: 11, position: "top" }} shape={<SquareDot fill={C.lime} stroke={C.ink} size={8} />} /> : null}
        </AreaChart>
      </ResponsiveContainer>
      <ChartDataTable
        caption="Receipt payout curve"
        headers={["Realized volatility percent", "Payout in USDC"]}
        rows={data.map((point) => [point.x, point.y.toFixed(6)])}
      />
      <div className="payoff-readout" aria-label="Payoff summary">
        <div><span>Selected units</span><b>{fmtUnits(units, 4)}</b></div>
        <div><span>At realized so far</span><b>{currentPayout !== undefined ? `${fmtUsd(currentPayout)} USDC` : "—"}</b></div>
        <div><span>Maximum payout</span><b>{fmtUsd(maxPayout)} USDC</b></div>
      </div>
    </div>
  );
}
