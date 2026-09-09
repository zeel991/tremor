"use client";

import { C } from "./theme";

/**
 * SVG diagonal-hatch pattern: 1px ink lines at 45°, 6px spacing, 35% opacity.
 * Render inside a chart's `<defs>` and fill with `hatchUrl(id)`.
 */
export function HatchPattern({
  id,
  color = C.ink,
  opacity = 0.35,
  spacing = 6,
}: {
  id: string;
  color?: string;
  opacity?: number;
  spacing?: number;
}) {
  return (
    <pattern id={id} patternUnits="userSpaceOnUse" width={spacing} height={spacing} patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2={spacing} stroke={color} strokeOpacity={opacity} strokeWidth="1" />
    </pattern>
  );
}

export const hatchUrl = (id: string): string => `url(#${id})`;

/** 6px square marker for recharts `dot` / `activeDot` / `shape` props. */
export function SquareDot(props: { cx?: number; cy?: number; fill?: string; stroke?: string; size?: number; payload?: unknown; value?: unknown }) {
  const { cx, cy, fill = C.ink, stroke = C.white, size = 6 } = props;
  if (cx === undefined || cy === undefined || Number.isNaN(cx) || Number.isNaN(cy)) return null;
  return <rect x={cx - size / 2} y={cy - size / 2} width={size} height={size} fill={fill} stroke={stroke} strokeWidth={1} />;
}
