import type { ReactNode } from "react";
import { cx } from "@/lib/format";
import { Status, STATUS_LABEL } from "@/lib/series";

export type TagTone = "default" | "lime" | "ink" | "outline" | "muted" | "dim" | "up" | "down" | "dark";
const toneClass: Record<TagTone, string> = {
  default: "",
  lime: "tag-lime",
  ink: "tag-ink",
  outline: "tag-outline",
  muted: "tag-muted",
  dim: "tag-dim",
  up: "tag-up",
  down: "tag-down",
  dark: "tag-dark",
};

/** Square tag on --bg-3. */
export function Tag({ tone = "default", className, children, title }: { tone?: TagTone; className?: string; children: ReactNode; title?: string }) {
  return (
    <span className={cx("tag", toneClass[tone], className)} title={title}>
      {children}
    </span>
  );
}

const statusColor: Record<Status, string> = {
  [Status.Upcoming]: "text-ink-2",
  [Status.Live]: "text-lime-dark",
  [Status.ExpiredUnfinalized]: "text-ink",
  [Status.Finalized]: "text-up",
  [Status.Closed]: "text-ink-3",
};

/**
 * `■ Live` — square dot + text, coloured per status.
 *
 * `issuanceOpen` is a separate signal from the lifecycle state: a live series whose inventory has
 * sold out, or whose writer has stopped issuance, is still live for exits and redemptions. Saying
 * "sale closed" next to "Live" is the honest way to show that.
 */
export function StatusTag({
  status,
  issuanceOpen,
  compact,
  className,
  onDark,
}: {
  status: Status;
  issuanceOpen?: boolean;
  compact?: boolean;
  className?: string;
  onDark?: boolean;
}) {
  const showSaleClosed = issuanceOpen === false && (status === Status.Live || status === Status.Upcoming);
  const color = onDark && status === Status.Live ? "text-lime" : statusColor[status];
  return (
    <span className={cx("inline-flex items-center gap-2 whitespace-nowrap", className)}>
      <span className={cx("inline-flex items-center gap-1.5 text-[13px] font-medium", color)}>
        <span className="sdot" />
        {STATUS_LABEL[status]}
      </span>
      {showSaleClosed && !compact ? <span className="label">· sale closed</span> : null}
    </span>
  );
}
