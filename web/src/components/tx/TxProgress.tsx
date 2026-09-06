"use client";

import type { StepState } from "@/lib/tx";
import { cx } from "@/lib/format";
import { IconCheck, IconSpinner, IconX } from "@/components/ui/Icons";
import { TxHash } from "@/components/ui/Address";
import { Tooltip } from "@/components/ui/Tooltip";

function StepIcon({ step, index }: { step: StepState; index: number }) {
  switch (step.phase) {
    case "confirmed":
      return (
        <span className="step-icon !border-lime !bg-lime !text-ink">
          <IconCheck width={13} height={13} />
        </span>
      );
    case "skipped":
      return (
        <span className="step-icon">
          <IconCheck width={13} height={13} />
        </span>
      );
    case "failed":
    case "rejected":
      return (
        <span className="step-icon !border-down !text-down">
          <IconX width={13} height={13} />
        </span>
      );
    case "preparing":
    case "confirm":
    case "pending":
      return (
        <span className="step-icon !border-current">
          <IconSpinner width={13} height={13} />
        </span>
      );
    default:
      return <span className="step-icon">{index + 1}</span>;
  }
}

const phaseText: Record<StepState["phase"], string> = {
  todo: "",
  preparing: "Preparing…",
  confirm: "Confirm in wallet",
  pending: "Waiting for inclusion",
  confirmed: "Confirmed",
  skipped: "Skipped",
  failed: "Failed",
  rejected: "Rejected in wallet",
};

/**
 * Step list; `dark` for the trade rail. `compact` is the order-ticket form: one line per step,
 * the detail moves into a hover tooltip on the label, status sits on the right.
 */
export function TxProgress({ steps, className, dark, compact }: { steps: StepState[]; className?: string; dark?: boolean; compact?: boolean }) {
  const fg = dark ? "text-white" : "text-ink";
  const dimFg = dark ? "text-white/40" : "text-ink-3";
  const subFg = dark ? "text-white/60" : "text-ink-2";

  if (compact) {
    return (
      <ol className={cx("m-0 flex list-none flex-col p-0", className)} aria-label="Transaction progress">
        {steps.map((s, i) => {
          const active = s.phase === "preparing" || s.phase === "confirm" || s.phase === "pending";
          const dim = s.phase === "todo";
          const failed = s.phase === "failed" || s.phase === "rejected";
          return (
            <li key={s.key} className={cx("tk-step", fg)} aria-current={active ? "step" : undefined}>
              <StepIcon step={s} index={i} />
              <Tooltip content={s.detail} tone={dark ? "white" : "ink"} className="min-w-0 flex-1">
                <span className={cx("truncate font-medium", dim ? dimFg : fg)} tabIndex={0}>
                  {s.label}
                </span>
              </Tooltip>
              {s.hash ? (
                <TxHash value={s.hash} />
              ) : (
                <span className={cx("flex-none tnum", failed ? "text-down" : dim ? dimFg : subFg)}>
                  {phaseText[s.phase]}
                  {s.note ? ` · ${s.note}` : ""}
                </span>
              )}
            </li>
          );
        })}
        {steps.some((s) => s.error && (s.phase === "failed" || s.phase === "rejected")) ? (
          <li className="small mt-1 break-words text-down">{steps.find((s) => s.error && (s.phase === "failed" || s.phase === "rejected"))?.error}</li>
        ) : null}
      </ol>
    );
  }

  return (
    <ol className={cx("m-0 flex list-none flex-col gap-3 p-0", className)} aria-label="Transaction progress">
      {steps.map((s, i) => {
        const active = s.phase === "preparing" || s.phase === "confirm" || s.phase === "pending";
        const dim = s.phase === "todo";
        return (
          <li key={s.key} className={cx("flex items-start gap-3", fg)} aria-current={active ? "step" : undefined}>
            <StepIcon step={s} index={i} />
            <div className="min-w-0 flex-1">
              <div className={cx("text-[13px] font-medium", dim ? dimFg : fg)}>{s.label}</div>
              <div className={cx("small", dimFg)}>
                {s.phase === "todo" ? s.detail : phaseText[s.phase]}
                {s.note ? <span className={subFg}> · {s.note}</span> : null}
                {s.error && (s.phase === "failed" || s.phase === "rejected") ? <span className="block break-words text-down">{s.error}</span> : null}
              </div>
            </div>
            {s.hash ? <TxHash value={s.hash} /> : null}
          </li>
        );
      })}
    </ol>
  );
}
