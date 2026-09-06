"use client";

import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useGroupCheckpointProgress } from "@/lib/portfolio-chain";
import { isPortfolioDeployed } from "@/lib/contracts";
import { fmtDateTime, fmtVolPct } from "@/lib/format";
import type { GroupState } from "@/lib/portfolio";
import { CHECKPOINT_PLAN, FINALIZE_PLAN, runGroupCheckpoint, runGroupFinalize, useTxFlow } from "@/lib/tx";
import { DarkItems } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { TxProgress } from "@/components/tx/TxProgress";
import { TxHash } from "@/components/ui/Address";
import { AllocBar } from "@/components/ui/Hatch";

/**
 * Checkpoint / finalize against the portfolio market's own accumulator. Permissionless on purpose:
 * settlement of a paired market cannot depend on a keeper any more than a series can.
 */
export function GroupOracleTicket({ g }: { g: GroupState }) {
  const { address } = useAccount();
  const toast = useToast();
  const qc = useQueryClient();
  const checkpointFlow = useTxFlow<{ hash: string; stored: number; available: number; done: boolean }>(CHECKPOINT_PLAN);
  const finalizeFlow = useTxFlow<string>(FINALIZE_PLAN);
  const progress = useGroupCheckpointProgress(g.id);

  const stored = progress.data?.stored;
  const available = progress.data?.available;
  const total = progress.data?.total;
  const behind = stored !== undefined && available !== undefined ? Math.max(0, available - stored) : undefined;
  const budget = 32;
  const canFinalize =
    !g.finalized && stored !== undefined && total !== undefined && total > 0 && stored >= total;
  const pct = stored !== undefined && total !== undefined && total > 1 ? (Math.max(0, stored - 1) / (total - 1)) * 100 : 0;

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["chain"] });

  const checkpoint = async () => {
    const res = await checkpointFlow.run((ctx) => runGroupCheckpoint(ctx, g.id, budget));
    if (res) {
      toast.success(
        res.done ? "Window is current" : "Window advanced",
        res.done ? `${res.stored} samples stored` : `${res.stored} of ${res.available} — run it again`,
      );
      invalidate();
    } else if (checkpointFlow.error) toast.error("Checkpoint failed", checkpointFlow.error);
  };

  const finalize = async () => {
    const hash = await finalizeFlow.run((ctx) => runGroupFinalize(ctx, g.id));
    if (hash) {
      toast.success("Variance finalized", "Both sides' payouts are now fixed");
      invalidate();
    } else if (finalizeFlow.error) toast.error("Finalize failed", finalizeFlow.error);
  };

  const blocker = !isPortfolioDeployed ? "Contracts not deployed" : !address ? "Connect a wallet" : undefined;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <AllocBar pct={pct} tone="lime" label="Observation window checkpointed" />
        <div className="mt-1.5 flex items-baseline justify-between gap-3">
          <span className="text-[12px] text-white/50">Window checkpointed</span>
          <span className="text-[13px] tnum text-white">
            {stored !== undefined && total !== undefined ? `${stored} / ${total} samples` : "unavailable"}
          </span>
        </div>
      </div>
      <DarkItems
        items={[
          { label: "Behind", value: behind === undefined ? "unavailable" : behind === 0 ? "Current" : `${behind} sample${behind === 1 ? "" : "s"}` },
          { label: "Window ends", value: fmtDateTime(g.params.expiry) },
          {
            label: g.finalized ? "Final realized vol" : "Final variance",
            value: g.finalized ? `${fmtVolPct(g.finalVariance)}%` : "not yet fixed",
          },
          { label: "Per call", value: `up to ${budget} samples` },
        ]}
      />
      <Button
        size="lg"
        className="w-full"
        variant={behind !== undefined && behind > 0 ? "primary" : "white"}
        disabled={!!blocker || behind === undefined || behind === 0 || checkpointFlow.running}
        loading={checkpointFlow.running}
        onClick={checkpoint}
      >
        {blocker ?? (behind === undefined ? "Progress unavailable" : behind === 0 ? "Window is current" : `Update the window (${Math.min(behind, budget)} samples)`)}
      </Button>
      {checkpointFlow.steps.some((st) => st.phase !== "todo") ? <TxProgress dark steps={checkpointFlow.steps} className="pt-1" /> : null}
      <Button
        size="lg"
        className="w-full"
        variant={canFinalize ? "primary" : "white"}
        disabled={!!blocker || !canFinalize || finalizeFlow.running}
        loading={finalizeFlow.running}
        onClick={finalize}
      >
        {blocker ?? (g.finalized ? "Already finalized" : canFinalize ? "Finalize variance" : "Finalize (window incomplete)")}
      </Button>
      {finalizeFlow.steps.some((st) => st.phase !== "todo") ? <TxProgress dark steps={finalizeFlow.steps} className="pt-1" /> : null}
      {finalizeFlow.result ? (
        <p className="m-0 text-[12px] text-white/60">
          Done · <TxHash value={finalizeFlow.result as `0x${string}`} />
        </p>
      ) : null}
      <p className="m-0 text-[12px] leading-4 text-white/45">
        Anyone can make these calls against the portfolio accumulator. Finalizing fixes x once, and with it
        both sides&apos; payouts.
      </p>
    </div>
  );
}
