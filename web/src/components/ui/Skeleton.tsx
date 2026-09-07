import { cx } from "@/lib/format";

export function Skeleton({ className, style, dark }: { className?: string; style?: React.CSSProperties; dark?: boolean }) {
  return <div className={cx("skeleton", dark && "skeleton-dark", className)} style={style} aria-hidden="true" />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cx("flex flex-col gap-2", className)} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-3.5" style={{ width: `${100 - (i % 3) * 18}%` }} />
      ))}
    </div>
  );
}

export function SkeletonRows({ rows = 4, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <tbody aria-hidden="true">
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c}>
              <Skeleton className="h-3.5" style={{ width: c === 0 ? 120 : 64 }} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}
