import { cx } from "@/lib/format";
import { Ring } from "./Hatch";

/** One line of ink-3 text, centered, with the hatched ring ornament. */
export function EmptyState({
  children,
  className,
  ornament = true,
  action,
}: {
  children: React.ReactNode;
  className?: string;
  ornament?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className={cx("flex flex-col items-center gap-4 py-8 text-center", className)}>
      {ornament ? <Ring size="sm" /> : null}
      <p className="m-0 max-w-sm text-[13px] text-ink-3">{children}</p>
      {action}
    </div>
  );
}
