/** Literal colors for SVG attributes (recharts). Mirrors DESIGN.md v2 tokens. */
export const C = {
  ink: "#0D0D0D",
  ink2: "#5F6368",
  ink3: "#9AA0A6",
  line: "#E6E8EA",
  line2: "#D5D8DB",
  lime: "#BAFE4E",
  limeDark: "#2E5A00",
  up: "#2FB344",
  down: "#E5484D",
  white: "#FFFFFF",
} as const;

export const axisProps = {
  tick: { fill: C.ink3, fontSize: 11 },
  axisLine: false,
  tickLine: false,
} as const;

export const cursorProps = { stroke: C.ink3, strokeDasharray: "3 3" } as const;

export const fmtTimeTick = (t: number, spanSeconds: number): string => {
  const d = new Date(t * 1000);
  if (spanSeconds <= 2 * 86400) return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

/** Show square markers only when the series is sparse enough to read them. */
export const MARKER_MAX_POINTS = 40;
