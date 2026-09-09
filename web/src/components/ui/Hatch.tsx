import { cx } from "@/lib/format";

/** Allocation / coverage bar: solid segment + hatched remainder (reference "Asset Allocation"). */
export function AllocBar({
  pct,
  tone = "lime",
  className,
  label,
}: {
  pct: number;
  tone?: "lime" | "ink" | "up" | "down";
  className?: string;
  label?: string;
}) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div
      className={cx("alloc", tone !== "lime" && `alloc-${tone}`, className)}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(w)}
      aria-label={label}
    >
      <div className="alloc-fill" style={{ width: `${w}%` }} />
    </div>
  );
}

/** Striped ring ornament used by principle cards and empty states. */
export function Ring({ size = "md", dark, className }: { size?: "sm" | "md"; dark?: boolean; className?: string }) {
  return <div aria-hidden="true" className={cx("ring", size === "sm" && "ring-sm", dark && "ring-dark", className)} />;
}
