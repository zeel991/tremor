import type { ReactNode } from "react";
import { cx } from "@/lib/format";

/**
 * Landing section: `■ Label` in the left column, heading + body in the right (1:2 grid),
 * content full-width below.
 */
export function SectionRow({
  label,
  title,
  body,
  action,
  children,
  id,
  className,
}: {
  label: string;
  title?: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section aria-labelledby={id ? `${id}-title` : undefined} className={cx("flex flex-col gap-8", className)}>
      <div className="grid gap-6 md:grid-cols-3">
        <div className="flex items-center gap-3 self-start">
          <span className="sq" />
          <span className="text-[16px] font-medium leading-5">{label}</span>
        </div>
        <div className="flex flex-col gap-4 md:col-span-2">
          {title ? (
            <h2 id={id ? `${id}-title` : undefined} className="h-section text-ink-2">
              {title}
            </h2>
          ) : null}
          {body ? <p className="body max-w-2xl">{body}</p> : null}
          {action ? <div className="flex flex-wrap gap-3 pt-2">{action}</div> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

/** App-page header: bracketed label, 32px title, one-line description. */
export function PageHeader({ label, title, body, action }: { label: string; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 border-b border-line pb-6 md:flex-row md:items-end md:justify-between">
      <div className="flex flex-col gap-2">
        <span className="bracket bracket-muted self-start">{label}</span>
        <h1 className="h-page">{title}</h1>
        {body ? <p className="max-w-2xl text-[14px] leading-5 text-ink-2">{body}</p> : null}
      </div>
      {action ? <div className="flex flex-none flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  );
}
