"use client";

import { Area, AreaChart, ReferenceDot, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { C } from "./theme";
import { HatchPattern, SquareDot, hatchUrl } from "./hatch";

/** Hatched mini area with an ink stroke and a thin lime "current" marker on the last point. */
export function Sparkline({ data, id, height = 56 }: { data: Array<{ t: number; v: number }>; id: string; height?: number }) {
  if (data.length < 2) return <div style={{ height }} />;
  const hatchId = `spark-${id}`;
  const last = data[data.length - 1];
  return (
    <div style={{ height }} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <HatchPattern id={hatchId} spacing={5} opacity={0.3} />
          </defs>
          <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} hide />
          <YAxis domain={["dataMin", "dataMax"]} hide />
          <Area type="linear" dataKey="v" stroke={C.ink} strokeWidth={1.25} fill={hatchUrl(hatchId)} fillOpacity={1} isAnimationActive={false} dot={false} />
          <ReferenceLine x={last.t} stroke={C.lime} strokeWidth={1.5} />
          <ReferenceDot x={last.t} y={last.v} r={3} shape={<SquareDot fill={C.lime} stroke={C.ink} size={7} />} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
