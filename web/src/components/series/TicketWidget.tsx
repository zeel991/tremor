"use client";

import type { ReactNode } from "react";
import { cx } from "@/lib/format";
import { IconChevron, IconSwap } from "@/components/ui/Icons";

export interface TicketHalf {
  /** "Balance 1,000.00 USDC" */
  label: ReactNode;
  /** MAX button; omitted when undefined. */
  onMax?: () => void;
  /** Controlled input (top half) or display value (bottom half). */
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  /** Token / units selector chip under the amount. */
  unit: string;
  unitIcon?: string;
  onUnitClick?: () => void;
  disabled?: boolean;
  dim?: boolean;
  inputId?: string;
  inputLabel?: string;
}

function Half({ h }: { h: TicketHalf }) {
  return (
    <div className="amt">
      <div className="amt-head">
        <span className="truncate">{h.label}</span>
        {h.onMax ? (
          <button type="button" className="amt-max" onClick={h.onMax} disabled={h.disabled}>
            MAX
          </button>
        ) : null}
      </div>
      <div className="amt-body">
        {h.onChange ? (
          <input
            id={h.inputId}
            aria-label={h.inputLabel}
            className="amt-input"
            value={h.value}
            onChange={(e) => h.onChange?.(e.target.value)}
            placeholder={h.placeholder ?? "0.00"}
            disabled={h.disabled}
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
          />
        ) : (
          <div className={cx("amt-value", h.dim && "dim")} title={h.value}>
            {h.value}
          </div>
        )}
        <button type="button" className="amt-select" onClick={h.onUnitClick} disabled={!h.onUnitClick} aria-label={h.onUnitClick ? "Switch input side" : undefined}>
          <span className="amt-select-icon">{h.unitIcon ?? h.unit.slice(0, 1).toUpperCase()}</span>
          {h.unit}
          {h.onUnitClick ? <IconChevron width={14} height={14} className="opacity-70" /> : null}
        </button>
      </div>
    </div>
  );
}

/**
 * The gray two-half amount widget from the reference: in on top, out below, a square swap
 * button on the seam. Frame color (dark rail vs. light preview) comes from `--amt-frame`.
 */
export function TicketWidget({ top, bottom, onSwap, swapDisabled }: { top: TicketHalf; bottom: TicketHalf; onSwap?: () => void; swapDisabled?: boolean }) {
  return (
    <div>
      <Half h={top} />
      <div className="amt-seam">
        {onSwap ? (
          <button type="button" className="amt-swap" onClick={onSwap} disabled={swapDisabled} aria-label="Swap input and output">
            <IconSwap width={16} height={16} />
          </button>
        ) : null}
      </div>
      <Half h={bottom} />
    </div>
  );
}
