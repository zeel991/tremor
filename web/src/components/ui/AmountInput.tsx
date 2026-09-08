"use client";

import { useId } from "react";
import { cx } from "@/lib/format";

/** Square input on --bg-3 with a 13px label row and an optional unit tag. */
export function AmountInput({
  label,
  value,
  onChange,
  unit,
  placeholder = "0.00",
  disabled,
  error,
  hint,
  right,
  mono = false,
  type = "text",
  inputMode = "decimal",
  min,
  step,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  placeholder?: string;
  disabled?: boolean;
  error?: string;
  hint?: React.ReactNode;
  right?: React.ReactNode;
  mono?: boolean;
  type?: "text" | "number" | "datetime-local";
  inputMode?: "decimal" | "numeric" | "text";
  min?: string | number;
  step?: string | number;
}) {
  const id = useId();
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="label">
          {label}
        </label>
        {right ? <span className="small text-ink-2">{right}</span> : null}
      </div>
      <div className={cx(unit && "input-wrap")}>
        <input
          id={id}
          className={cx("input", mono && "input-mono", error && "!border-down")}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          inputMode={type === "text" ? inputMode : undefined}
          type={type}
          min={min}
          step={step}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!error}
          aria-describedby={error || hint ? `${id}-help` : undefined}
        />
        {unit ? <span className="input-unit tag tag-outline bg-bg">{unit}</span> : null}
      </div>
      {error || hint ? (
        <p id={`${id}-help`} className={cx("small mt-1.5 mb-0", error ? "text-down" : "text-ink-3")}>
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}

export function SelectInput<T extends string>({
  label,
  value,
  onChange,
  options,
  hint,
  disabled,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  hint?: React.ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="label mb-1.5 block">
        {label}
      </label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value as T)} disabled={disabled}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <p className="small mt-1.5 mb-0 text-ink-3">{hint}</p> : null}
    </div>
  );
}
