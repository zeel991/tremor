import type { ReactNode } from "react";
import { cx } from "@/lib/format";
import { Skeleton } from "./Skeleton";
import { AllocBar } from "./Hatch";

/** label 13 ink-3 · value 40/400 · delta 13 up/down · optional hatched mini-bar. */
export function StatTile({
  label,
  value,
  sub,
  delta,
  bar,
  children,
  loading,
  size = "md",
  className,
  valueClassName,
}: {
  label: ReactNode;
  value?: ReactNode;
  sub?: ReactNode;
  /** Signed number rendered in --up / --down. */
  delta?: number;
  /** 0–100: solid segment + hatched remainder under the value. */
  bar?: number;
  children?: ReactNode;
  loading?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
  valueClassName?: string;
}) {
  const valueCls = size === "lg" ? "num-lg md:text-[56px] md:leading-[60px]" : size === "md" ? "num-lg" : "text-[28px] leading-8 font-normal";
  return (
    <div className={cx("card flex flex-col", className)} aria-busy={loading || undefined}>
      <div className="label">{label}</div>
      {loading ? (
        <Skeleton className="mt-3 h-10 w-32" />
      ) : (
        <div className={cx("mt-3 tnum text-ink", valueCls, valueClassName)}>{value ?? "—"}</div>
      )}
      {delta !== undefined || sub ? (
        <div className="mt-1 flex items-baseline gap-2 text-[13px]">
          {delta !== undefined ? (
            <span className={cx("font-medium", delta >= 0 ? "text-up" : "text-down")}>
              {delta >= 0 ? "+" : ""}
              {delta.toFixed(1)}%
            </span>
          ) : null}
          {sub ? <span className="text-ink-3">{sub}</span> : null}
        </div>
      ) : null}
      {bar !== undefined ? <AllocBar pct={bar} className="alloc-sm mt-4" /> : null}
      {children ? <div className="mt-auto pt-4">{children}</div> : null}
    </div>
  );
}
