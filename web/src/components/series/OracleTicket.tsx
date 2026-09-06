"use client";

import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useMaxSamplesPerCheckpoint } from "@/lib/chain";
import { isDeployed } from "@/lib/contracts";
import { fmtDateTime, fmtVolPct } from "@/lib/format";
import { checkpointProgressBps, checkpointsBehind, needsFinalize, Status, type SeriesState } from "@/lib/series";
import { CHECKPOINT_PLAN, FINALIZE_PLAN, runCheckpoint, runFinalize, useTxFlow } from "@/lib/tx";
import { DarkItems } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { TxProgress } from "@/components/tx/TxProgress";
import { TxHash } from "@/components/ui/Address";
import { AllocBar } from "@/components/ui/Hatch";

/**
 * The oracle controls: walk the observation window forward, then fix the final variance.
 *
 * Both are permissionless, and that is the point of showing them to everyone rather than hiding them
 * behind a writer-only panel. If no automation ever runs, the next holder who wants their money makes
 * these calls themselves — which is exactly why settlement cannot be held hostage.
 */
export function OracleTicket({ s }: { s: SeriesState }) {
  const { address } = useAccount();
  const toast = useToast();
  const qc = useQueryClient();
  const checkpointFlow = useTxFlow<{ hash: string; stored: number; available: number; done: boolean }>(
    CHECKPOINT_PLAN,
  );
  const finalizeFlow = useTxFlow<string>(FINALIZE_PLAN);
  const maxSamples = useMaxSamplesPerCheckpoint();

  const behind = checkpointsBehind(s);
  const budget = maxSamples.data ?? 32;
  const callsLeft = behind === 0 ? 0 : Math.ceil(behind / budget);
  const canFinalize = needsFinalize(s);
  const pct = Number(checkpointProgressBps(s)) / 100;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["chain"] });
    void qc.invalidateQueries({ queryKey: ["api"] });
  };

  const checkpoint = async () => {
    const res = await checkpointFlow.run((ctx) => runCheckpoint(ctx, s.id, budget));
    if (res) {
      toast.success(
        res.done ? "Market is current" : "Window advanced",
        res.done ? `${res.stored} samples stored` : `${res.stored} of ${res.available} — run it again`,
      );
      invalidate();
    } else if (checkpointFlow.error) {
      toast.error("Checkpoint failed", checkpointFlow.error);
    }
  };

  const finalize = async () => {
    const hash = await finalizeFlow.run((ctx) => runFinalize(ctx, s.id));
    if (hash) {
      toast.success("Variance finalized", "The payout per unit is now fixed");
      invalidate();
    } else if (finalizeFlow.error) {
      toast.error("Finalize failed", finalizeFlow.error);
    }
  };

  const blocker = !isDeployed ? "Contracts not deployed" : !address ? "Connect a wallet" : undefined;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <AllocBar pct={pct} tone="lime" label="Observation window checkpointed" />
        <div className="mt-1.5 flex items-baseline justify-between gap-3">
          <span className="text-[12px] text-white/50">Window checkpointed</span>
          <span className="text-[13px] tnum text-white">
            {s.oracle.samplesStored} / {s.oracle.samplesTotal} samples
          </span>
        </div>
      </div>
      <DarkItems
        items={[
          { label: "Behind", value: behind === 0 ? "Current" : `${behind} sample${behind === 1 ? "" : "s"}` },
          { label: "Calls to catch up", value: callsLeft === 0 ? "—" : `${callsLeft}` },
          { label: "Stored through", value: s.oracle.processedThrough > 0 ? fmtDateTime(s.oracle.processedThrough) : "—" },
          { label: "Window ends", value: fmtDateTime(s.params.expiry) },
          {
            label: s.status === Status.Finalized || s.status === Status.Closed ? "Final realized vol" : "Realized so far",
            value: `${fmtVolPct(
              s.status === Status.Finalized || s.status === Status.Closed ? s.finalVariance : s.quote.realizedVarianceSoFar,
            )}%`,
          },
          { label: "Per call", value: `up to ${budget} samples` },
        ]}
      />
      <Button
        size="lg"
        className="w-full"
        variant={behind > 0 ? "primary" : "white"}
        disabled={!!blocker || behind === 0 || checkpointFlow.running}
        loading={checkpointFlow.running}
        onClick={checkpoint}
      >
        {blocker ?? (behind === 0 ? "Market is current" : `Update the market (${Math.min(behind, budget)} samples)`)}
      </Button>
      {checkpointFlow.steps.some((st) => st.phase !== "todo") ? (
        <TxProgress dark steps={checkpointFlow.steps} className="pt-1" />
      ) : null}
      <Button
        size="lg"
        className="w-full"
        variant={canFinalize ? "primary" : "white"}
        disabled={!!blocker || !canFinalize || finalizeFlow.running}
        loading={finalizeFlow.running}
        onClick={finalize}
      >
        {blocker ??
          (s.status === Status.Finalized || s.status === Status.Closed
            ? "Already finalized"
            : canFinalize
              ? "Finalize variance"
              : "Finalize (window incomplete)")}
      </Button>
      {finalizeFlow.steps.some((st) => st.phase !== "todo") ? (
        <TxProgress dark steps={finalizeFlow.steps} className="pt-1" />
      ) : null}
      {finalizeFlow.result ? (
        <p className="m-0 text-[12px] text-white/60">
          Done · <TxHash value={finalizeFlow.result as `0x${string}`} />
        </p>
      ) : null}
      <p className="m-0 text-[12px] leading-4 text-white/45">
        Anyone can make these calls. Each checkpoint stores at most {budget} Chainlink samples, so a long
        window takes several cheap transactions instead of one that might not fit in a block.
      </p>
    </div>
  );
}
