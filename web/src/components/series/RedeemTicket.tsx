"use client";

import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useQuoteSettle, useTokenBalance } from "@/lib/chain";
import { isDeployed } from "@/lib/contracts";
import { fmtDateTime, fmtUnits, fmtUsdc, fmtVolPct, RECEIPT_DECIMALS, tryParseDecimal, WAD } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { canRedeem, isFinalized, needsWorthlessBurn, Status, type SeriesState } from "@/lib/series";
import {
  BURN_WORTHLESS_PLAN,
  REDEEM_PLAN,
  runBurnWorthless,
  runRedeem,
  useTxFlow,
  type SwapResult,
} from "@/lib/tx";
import { DarkItems } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { TxProgress } from "@/components/tx/TxProgress";
import { TxHash } from "@/components/ui/Address";
import { TicketWidget } from "./TicketWidget";

/**
 * Receipts in, USDC out at the final variance. Available once the series is finalized, and available
 * for as long as the holder likes: the settlement strategy carries no deadline.
 *
 * A series that finalized worthless cannot be redeemed through SwapVM at all — it rejects a swap with
 * a zero output — so the ticket switches to the explicit burn path instead of showing a button that
 * would always revert.
 */
export function RedeemTicket({ s, indexedEntry }: { s: SeriesState; indexedEntry?: bigint }) {
  const { address } = useAccount();
  const toast = useToast();
  const qc = useQueryClient();
  const flow = useTxFlow<SwapResult>(REDEEM_PLAN);
  const burnFlow = useTxFlow<string>(BURN_WORTHLESS_PLAN);
  const bal = useTokenBalance(s.receipt, address);
  const [amount, setAmount] = useState("");
  const debounced = useDebounced(amount, 300);
  const parsed = useMemo(
    () => (debounced.trim() === "" ? null : tryParseDecimal(debounced, RECEIPT_DECIMALS)),
    [debounced],
  );
  const valid = parsed !== null && parsed > 0n;
  const worthless = needsWorthlessBurn(s);
  const redeemable = canRedeem(s);
  const quote = useQuoteSettle(s.id, valid ? parsed : null, s.legs.settleOpen && !worthless);

  const proceeds = quote.data?.quoteOut;
  const pnl =
    indexedEntry !== undefined && parsed !== null && proceeds !== undefined && parsed > 0n
      ? proceeds - (indexedEntry * parsed) / WAD
      : undefined;

  let blocker: string | undefined;
  if (!isDeployed) blocker = "Contracts not deployed";
  else if (s.status === Status.Upcoming) blocker = "Window has not started";
  else if (s.status === Status.Live) blocker = "Locked until expiry";
  else if (s.status === Status.ExpiredUnfinalized) blocker = "Finalize the variance first";
  else if (s.status === Status.Closed && s.unitsOutstanding === 0n) blocker = "Series closed";
  else if (!address) blocker = "Connect a wallet";
  else if (bal.data !== undefined && bal.data === 0n) blocker = "No receipts held";
  else if (parsed !== null && bal.data !== undefined && parsed > bal.data) blocker = "Exceeds your balance";
  else if (!worthless && !redeemable) blocker = "Redemption unavailable";

  const locked = !!blocker && blocker !== "Connect a wallet" && blocker !== "Exceeds your balance";

  const submit = async () => {
    if (!valid || blocker) return;
    const res = await flow.run((ctx) => runRedeem(ctx, { state: s, units: parsed as bigint, slippageBps: 100 }));
    if (res) {
      toast.success("Redeemed", res.amountOut !== undefined ? `Received ${fmtUsdc(res.amountOut)} USDC` : undefined);
      void qc.invalidateQueries({ queryKey: ["chain"] });
      void qc.invalidateQueries({ queryKey: ["api"] });
      setAmount("");
    } else if (flow.error) {
      toast.error("Redemption failed", flow.error);
    }
  };

  const burn = async () => {
    if (!valid || blocker) return;
    const hash = await burnFlow.run((ctx) => runBurnWorthless(ctx, s.id, parsed as bigint));
    if (hash) {
      toast.success("Receipts burned", "This series finalized at a zero payout");
      void qc.invalidateQueries({ queryKey: ["chain"] });
      void qc.invalidateQueries({ queryKey: ["api"] });
      setAmount("");
    } else if (burnFlow.error) {
      toast.error("Burn failed", burnFlow.error);
    }
  };

  const activeFlow = worthless ? burnFlow : flow;

  return (
    <div className="flex flex-col gap-3">
      {worthless ? (
        <p className="m-0 border border-white/20 bg-white/5 p-3 text-[13px] leading-5 text-white/80" role="status">
          This series finalized at <b>{fmtVolPct(s.finalVariance)}%</b> realized vol, which pays nothing per
          unit. SwapVM refuses a zero-output swap, so there is an explicit burn instead of a redemption
          that would always revert.
        </p>
      ) : null}
      <TicketWidget
        top={{
          label: (
            <>
              Balance <b>{bal.data !== undefined ? fmtUnits(bal.data, 4) : address ? "…" : "—"}</b> units
            </>
          ),
          value: amount,
          onChange: setAmount,
          onMax:
            bal.data !== undefined && bal.data > 0n
              ? () => setAmount(fmtUnits(bal.data as bigint, 18).replace(/,/g, ""))
              : undefined,
          unit: "receipts",
          unitIcon: "σ²",
          disabled: locked,
          inputLabel: worthless ? "Units to burn" : "Units to redeem",
        }}
        bottom={{
          label: (
            <>
              Payout <b>{fmtUsdc(s.payoutPerUnit)}</b> USDC / unit
            </>
          ),
          value: worthless ? "0.00" : proceeds !== undefined ? fmtUsdc(proceeds) : quote.isFetching ? "…" : "0.00",
          unit: "USDC",
          unitIcon: "$",
          dim: worthless || proceeds === undefined,
        }}
      />
      <DarkItems
        items={[
          {
            label: isFinalized(s) ? "Final realized vol" : "Realized vol so far",
            value: `${fmtVolPct(isFinalized(s) ? s.finalVariance : s.quote.realizedVarianceSoFar)}%`,
          },
          { label: "Payout / unit", value: `${fmtUsdc(s.payoutPerUnit)} USDC` },
          {
            label: "You receive",
            value: worthless ? "0.00 USDC" : proceeds !== undefined ? `${fmtUsdc(proceeds)} USDC` : quote.isFetching ? "…" : "—",
          },
          {
            label: "Indexed P&L",
            value: pnl !== undefined ? `${pnl < 0n ? "−" : "+"}${fmtUsdc(pnl < 0n ? -pnl : pnl)} USDC` : "—",
          },
          ...(isFinalized(s) ? [] : [{ label: "Expires", value: fmtDateTime(s.params.expiry) }]),
        ]}
      />
      <Button
        size="lg"
        className="w-full"
        variant={redeemable || worthless ? "primary" : "white"}
        disabled={!valid || !!blocker || activeFlow.running}
        loading={activeFlow.running}
        onClick={worthless ? burn : submit}
      >
        {blocker ?? (worthless ? "Burn receipts" : "Redeem receipts")}
      </Button>
      {activeFlow.steps.some((st) => st.phase !== "todo") ? (
        <TxProgress dark steps={activeFlow.steps} className="pt-1" />
      ) : null}
      {flow.result ? (
        <p className="m-0 text-[12px] text-white/60">
          Done · <TxHash value={flow.result.hash} />
        </p>
      ) : null}
      <p className="m-0 text-[12px] leading-4 text-white/45">
        Redemption needs nothing from the writer and has no deadline. The final variance was fixed on
        chain from Chainlink round history and cannot move again.
      </p>
    </div>
  );
}
