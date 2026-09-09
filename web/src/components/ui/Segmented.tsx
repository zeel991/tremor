"use client";

import { cx } from "@/lib/format";
import { Disabled } from "./Tooltip";

/**
 * Rectangular cells, 1px line-2; selected cell ink with white text (lime on dark).
 * A disabled option with a `disabledReason` explains itself on hover and keyboard focus.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  dark,
  block,
}: {
  options: Array<{ value: T; label: string; disabled?: boolean; disabledReason?: string }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
  dark?: boolean;
  block?: boolean;
}) {
  const cell = (o: (typeof options)[number], key?: string) => (
    <button key={key} type="button" aria-pressed={o.value === value} disabled={o.disabled} onClick={() => onChange(o.value)}>
      {o.label}
    </button>
  );
  return (
    <div className={cx("segmented", dark && "segmented-dark", block && "segmented-block", className)} role="group" aria-label={label}>
      {options.map((o) =>
        o.disabled && o.disabledReason ? (
          <Disabled key={o.value} reason={o.disabledReason} tone={dark ? "white" : "ink"}>
            {cell(o)}
          </Disabled>
        ) : (
          cell(o, o.value)
        ),
      )}
    </div>
  );
}
