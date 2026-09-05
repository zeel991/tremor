"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { isPortfolioDeployed } from "@/lib/contracts";
import { fmtUsdc, tryParseDecimal, USDC_DECIMALS } from "@/lib/format";
import type { GroupState } from "@/lib/portfolio";
import {
  ALLOCATE_EXIT_BUFFER_PLAN,
  FUND_EXIT_BUFFER_PLAN,
  WITHDRAW_EXIT_BUFFER_PLAN,
  runAllocateExitBuffer,
  runFundExitBuffer,
  runWithdrawExitBuffer,
  useTxFlow,
} from "@/lib/tx";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { TxProgress } from "@/components/tx/TxProgress";

type Action = "allocate" | "fund" | "withdraw";

function Row({
  label,
  detail,
  cta,
  disabled,
  disabledReason,
  running,
  onSubmit,
}: {
  label: string;
  detail: string;
  cta: string;
  disabled?: boolean;
  disabledReason?: string;
  running: boolean;
  onSubmit: (amount: bigint) => void;
}) {
  const [value, setValue] = useState("");
  const parsed = value.trim() === "" ? null : tryParseDecimal(value, USDC_DECIMALS);
  const valid = parsed !== null && parsed > 0n;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium">{label}</span>
        <span className="text-[12px] text-ink-3">{detail}</span>
      </div>
      <div className="flex gap-2">
        <input
          className="input flex-1"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0.00 USDC"
          inputMode="decimal"
          aria-label={`${label} amount in USDC`}
          disabled={disabled}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!valid || disabled || running}
          loading={running}
          onClick={() => valid && onSubmit(parsed as bigint)}
          title={disabled ? disabledReason : undefined}
        >
          {cta}
        </Button>
      </div>
      {disabled && disabledReason ? <span className="text-[12px] text-ink-3">{disabledReason}</span> : null}
    </div>
  );
}

/**
 * Early-exit liquidity, disclosed for what it is.
 *
 * Settlement backing is protected and locked in the vault; early-exit liquidity is a separate,
 * writer-managed buffer; the writer can withdraw the unused part at any time; therefore an early-exit
 * quote can become unavailable before execution, while settlement backing remains protected.
 */
export function ExitBufferCard({ g }: { g: GroupState }) {
  const { address } = useAccount();
  const toast = useToast();
  const qc = useQueryClient();
  const allocateFlow = useTxFlow<`0x${string}`>(ALLOCATE_EXIT_BUFFER_PLAN);
  const fundFlow = useTxFlow<`0x${string}`>(FUND_EXIT_BUFFER_PLAN);
  const withdrawFlow = useTxFlow<`0x${string}`>(WITHDRAW_EXIT_BUFFER_PLAN);
  const [last, setLast] = useState<Action | undefined>();

  const isWriter = !!address && address.toLowerCase() === g.writer.toLowerCase();
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["chain"] });
  const done = (label: string) => {
    toast.success(label);
    invalidate();
  };

  const submit = (action: Action) => async (amount: bigint) => {
    setLast(action);
    if (action === "allocate") {
      const hash = await allocateFlow.run((ctx) => runAllocateExitBuffer(ctx, g.id, g.vault, amount));
      if (hash) done("Exit buffer allocated");
      else if (allocateFlow.error) toast.error("Allocate failed", allocateFlow.error);
    } else if (action === "fund") {
      const hash = await fundFlow.run((ctx) => runFundExitBuffer(ctx, g.id, amount));
      if (hash) done("Exit buffer funded");
      else if (fundFlow.error) toast.error("Fund failed", fundFlow.error);
    } else {
      const hash = await withdrawFlow.run((ctx) => runWithdrawExitBuffer(ctx, g.id, amount));
      if (hash) done("Exit buffer withdrawn");
      else if (withdrawFlow.error) toast.error("Withdraw failed", withdrawFlow.error);
    }
  };

  const activeSteps =
    last === "allocate" ? allocateFlow.steps : last === "fund" ? fundFlow.steps : last === "withdraw" ? withdrawFlow.steps : [];
  const blocked = !isPortfolioDeployed || !address;

  return (
    <Card title="Exit buffer" meta="Writer-managed liquidity for early exits — separate from settlement backing">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[16px] font-medium">Currently funded</span>
        <span className="text-[24px] font-normal tnum">{fmtUsdc(g.exitBuffer)} USDC</span>
      </div>
      <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-5 text-ink-2">
        <li>Settlement backing is protected and locked: the reserve behind sold receipts cannot leave the vault.</li>
        <li>Early-exit liquidity is a separate, writer-managed buffer on top of that reserve.</li>
        <li>The writer can withdraw unused exit liquidity at any time.</li>
        <li>
          Therefore an early-exit quote can become unavailable before execution — while settlement backing
          remains protected.
        </li>
      </ul>
      <p className="mt-3 text-[13px] text-ink-2">
        An exit pays out of what is available: the reserve that burning those receipts releases, plus this
        buffer. When a quote is blocked, the ticket shows the needed and available amounts from that rule.
      </p>
      <div className="mt-4 flex flex-col gap-4">
        <Row
          label="Allocate from vault"
          detail="Writer only · locks free vault collateral"
          cta="Allocate"
          disabled={blocked || !isWriter}
          disabledReason={!address ? "Connect a wallet" : !isWriter ? "Only the writer can allocate from the vault" : undefined}
          running={allocateFlow.running}
          onSubmit={submit("allocate")}
        />
        <Row
          label="Fund from wallet"
          detail="Anyone · USDC from your wallet into the vault"
          cta="Fund"
          disabled={blocked}
          disabledReason={!address ? "Connect a wallet" : undefined}
          running={fundFlow.running}
          onSubmit={submit("fund")}
        />
        <Row
          label="Withdraw unused"
          detail="Writer only · back to the vault's free balance"
          cta="Withdraw"
          disabled={blocked || !isWriter || g.exitBuffer === 0n}
          disabledReason={
            !address
              ? "Connect a wallet"
              : !isWriter
                ? "Only the writer can withdraw"
                : g.exitBuffer === 0n
                  ? "Nothing funded"
                  : undefined
          }
          running={withdrawFlow.running}
          onSubmit={submit("withdraw")}
        />
      </div>
      {activeSteps.some((st) => st.phase !== "todo") ? <TxProgress steps={activeSteps} className="pt-3" /> : null}
    </Card>
  );
}
