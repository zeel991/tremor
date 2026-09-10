import { C } from "./theme";

export function ChartLegend({
  items,
}: {
  items: Array<{ label: string; swatch: "ink" | "dashed" | "hatch" | "lime" | "band" }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      {items.map((item) => (
        <span key={item.label} className="label inline-flex items-center gap-2">
          {item.swatch === "hatch" ? (
            <span aria-hidden="true" className="hatch inline-block h-3 w-4 border border-ink" />
          ) : item.swatch === "band" ? (
            <span
              aria-hidden="true"
              className="inline-block h-3 w-4 border border-line-2"
              style={{ background: C.line2, opacity: 0.55 }}
            />
          ) : (
            <span
              aria-hidden="true"
              style={{
                width: 18,
                height: 0,
                borderTop: `${item.swatch === "dashed" ? "1.5px dashed" : "1.5px solid"} ${item.swatch === "dashed" ? C.ink3 : item.swatch === "lime" ? C.lime : C.ink}`,
              }}
            />
          )}
          {item.label}
        </span>
      ))}
    </div>
  );
}
