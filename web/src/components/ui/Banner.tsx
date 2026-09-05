import type { ReactNode } from "react";
import { cx } from "@/lib/format";
import { IconInfo, IconWarning } from "./Icons";

export function Banner({
  tone = "info",
  children,
  className,
  action,
}: {
  tone?: "info" | "warning" | "negative";
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const color = tone === "warning" ? "text-lime-dark" : tone === "negative" ? "text-down" : "text-ink";
  return (
    <div role={tone === "info" ? "status" : "alert"} className={cx("banner", tone === "warning" && "banner-warning", tone === "negative" && "banner-negative", className)}>
      <span className={cx(color, "mt-px flex-none")}>{tone === "info" ? <IconInfo width={16} height={16} /> : <IconWarning width={16} height={16} />}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}
