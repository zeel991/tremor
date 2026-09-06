"use client";

import type { ReactNode } from "react";

interface Item {
  value?: number | string;
  name?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}
export interface InkTooltipProps {
  active?: boolean;
  payload?: Item[];
  label?: string | number;
  /** Format one entry to text, or null to leave it out (geometry keys a reader should not see). */
  format?: (item: Item) => string | null;
  labelFormat?: (label: string | number | undefined, payload: Item[]) => string | undefined;
  details?: (payload: Item[]) => ReactNode;
}

/** Square white tooltip, 1px ink border. Passed as `content={<InkTooltip … />}`. */
export function InkTooltip({ active, payload, label, format, labelFormat, details }: InkTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const items = payload.filter((p) => p.value !== undefined && p.value !== null);
  if (items.length === 0) return null;
  const head = labelFormat ? labelFormat(label, items) : undefined;
  return (
    <div className="border border-ink bg-bg px-2.5 py-1.5 text-[12px] leading-4 text-ink">
      {head ? <div className="label mb-0.5">{head}</div> : null}
      {items.map((it, i) => {
        const text = format ? format(it) : `${it.name ?? it.dataKey}: ${it.value}`;
        if (text === null) return null;
        return (
          <div key={i} className="tnum font-medium">
            {text}
          </div>
        );
      })}
      {details ? details(items) : null}
    </div>
  );
}
