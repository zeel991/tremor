import type { ReactNode } from "react";
import { cx } from "@/lib/format";

/**
 * White (or bg-2) card, 1px line, 2px radius, 24px padding.
 * Title row: 20/500 title left, small ink-3 meta right, hairline below.
 */
export function Card({
  title,
  meta,
  action,
  className,
  children,
  tone = "white",
  flush,
  as: Tag = "section",
}: {
  title?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
  tone?: "white" | "bg2";
  /** No padding on the body (tables). The head keeps its own padding. */
  flush?: boolean;
  as?: "section" | "div" | "article";
}) {
  const hasHead = title || meta || action;
  return (
    <Tag className={cx("card", tone === "bg2" && "card-2", flush && "card-flush", className)}>
      {hasHead ? (
        <header className="card-head">
          <div className="min-w-0">
            {typeof title === "string" ? <h2 className="h-card">{title}</h2> : title}
            {meta ? <div className="label mt-0.5">{meta}</div> : null}
          </div>
          {action ? <div className="flex flex-none items-center gap-2">{action}</div> : null}
        </header>
      ) : null}
      {children}
    </Tag>
  );
}

export function LineItems({
  items,
  className,
}: {
  items: Array<{ label: ReactNode; value: ReactNode; muted?: boolean; mono?: boolean }>;
  className?: string;
}) {
  return (
    <dl className={cx("m-0", className)}>
      {items.map((it, i) => (
        <div className="kv" key={i}>
          <dt className="text-[13px] text-ink-2">{it.label}</dt>
          <dd className={cx("m-0 text-right tnum", it.mono && "mono text-[13px]", it.muted ? "text-ink-2" : "text-ink font-medium")}>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Key-value rows on --panel-2 cards for the dark trade rail. */
export function DarkItems({ items, className }: { items: Array<{ label: ReactNode; value: ReactNode }>; className?: string }) {
  return (
    <dl className={cx("m-0", className)}>
      {items.map((it, i) => (
        <div className="kv-dark" key={i}>
          <dt>{it.label}</dt>
          <dd className="m-0">
            <b>{it.value}</b>
          </dd>
        </div>
      ))}
    </dl>
  );
}
