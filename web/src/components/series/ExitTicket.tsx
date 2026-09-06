"use client";

import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useQuoteExit, useTokenBalance } from "@/lib/chain";
import { isDeployed } from "@/lib/contracts";
import { fmtDateTime, fmtUnits, fmtUsdc, fmtVolPct, RECEIPT_DECIMALS, tryParseDecimal, WAD } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { canExit, Status, type SeriesState } from "@/lib/series";
import { EXIT_PLAN, runExit, useTxFlow, type SwapResult } from "@/lib/tx";
import { DarkItems } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { TxProgress } from "@/components/tx/TxProgress";
import { TxHash } from "@/components/ui/Address";
import { Segmented } from "@/components/ui/Segmented";
import { TicketWidget } from "./TicketWidget";

/**
 * Receipts in, USDC out at the executable bid, before expiry.
 *
 * This is the ticket v1 did not have. A v1 holder saw an "accrued payout indication" and could do
 * nothing with it until expiry; the number here is a bid they can hit, bounded by the collateral that
 * burning their receipts releases.
 *
 * `indexedEntry` is the holder's average indexed entry price when it is known. Receipts that arrived
 * by plain transfer have no indexed cost, so P&L is omitted rather than invented.
 */
export function ExitTicket({ s, indexedEntry }: { s: SeriesState; indexedEntry?: bigint }) {
  const { address } = useAccount();
  const toast = useToast();
  const qc = useQueryClient();
  const flow = useTxFlow<SwapResult>(EXIT_PLAN);
  const bal = useTokenBalance(s.receipt, address);
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState<"50" | "100" | "200">("100");
  const debounced = useDebounced(amount, 300);
  const parsed = useMemo(
    () => (debounced.trim() === "" ? null : tryParseDecimal(debounced, RECEIPT_DECIMALS)),
    [debounced],
  );
  const valid = parsed !== null && parsed > 0n;
  const exitable = canExit(s);
  const quote = useQuoteExit(s.id, valid ? parsed : null, s.legs.exitOpen);

  const units = quote.data?.filledUnits;
  const proceeds = quote.data?.quoteOut;
  const avg = units && units > 0n && proceeds !== undefined ? (proceeds * WAD) / units : undefined;
  const pnl =
    indexedEntry !== undefined && units !== undefined && proceeds !== undefined && units > 0n
      ? proceeds - (indexedEntry * units) / WAD
      : undefined;
  const partial = quote.data !== undefined && parsed !== null && quote.data.filledUnits < parsed;

  let blocker: string | undefined;
  if (!isDeployed) blocker = "Contracts not deployed";
  else if (s.status === Status.Upcoming) blocker = "Window has not started";
  else if (s.status === Status.Closed) blocker = "Series closed";
  else if (!s.legs.exitOpen)
    blocker = s.status === Status.Finalized || s.status === Status.ExpiredUnfinalized ? "Expired — redeem instead" : "No exit market";
  else if (!s.oracle.checkpointsCurrent) blocker = "Update the market first";
  else if (!exitable) blocker = "Exit unavailable";
  else if (!address) blocker = "Connect a wallet to exit";
  else if (bal.data !== undefined && bal.data === 0n) blocker = "No receipts held";
  else if (parsed !== null && bal.data !== undefined && parsed > bal.data) blocker = "Exceeds your balance";

  const locked = !!blocker && blocker !== "Connect a wallet to exit" && blocker !== "Exceeds your balance";

  const submit = async () => {
    if (!valid || blocker) return;
    const res = await flow.run((ctx) =>
      runExit(ctx, { state: s, units: parsed as bigint, slippageBps: Number(slippage) }),
    );
    if (res) {
      const detail =
        res.amountOut !== undefined ? `Received ${fmtUsdc(res.amountOut)} USDC · receipts burned` : undefined;
      if (res.partial) toast.success("Exited partially", detail);
      else toast.success("Position exited", detail);
      void qc.invalidateQueries({ queryKey: ["chain"] });
      void qc.invalidateQueries({ queryKey: ["api"] });
      setAmount("");
    } else if (flow.error) {
      toast.error("Exit failed", flow.error);
    }
  };

  return (
    <div className="flex flex-col gap-3">
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
          inputLabel: "Units to sell",
        }}
        bottom={{
          label: (
            <>
              Bid <b>{fmtUsdc(s.quote.bidPerUnit)}</b> USDC / unit
            </>
          ),
          value: proceeds !== undefined ? fmtUsdc(proceeds) : quote.isFetching ? "…" : "0.00",
          unit: "USDC",
          unitIcon: "$",
          dim: proceeds === undefined,
        }}
      />
      {partial ? (
        <p className="m-0 text-[12px] text-white/60">
          The bid is good for <b className="tnum">{fmtUnits(units ?? 0n, 4)}</b> units right now — this exit
          fills partially.
        </p>
      ) : null}
      <DarkItems
        items={[
          { label: "Bid vol", value: `${fmtVolPct(s.quote.bidVariance)}%` },
          { label: "Ask vol", value: `${fmtVolPct(s.quote.askVariance)}%` },
          { label: "Proceeds", value: proceeds !== undefined ? `${fmtUsdc(proceeds)} USDC` : quote.isFetching ? "…" : "—" },
          { label: "Avg price / unit", value: avg !== undefined ? `${fmtUsdc(avg)} USDC` : "—" },
          {
            label: "Indexed P&L",
            value: pnl !== undefined ? `${pnl < 0n ? "−" : "+"}${fmtUsdc(pnl < 0n ? -pnl : pnl)} USDC` : "—",
          },
          ...(s.legs.exitOpen ? [{ label: "Exit closes", value: fmtDateTime(s.params.expiry) }] : []),
        ]}
      />
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-white/50">Slippage</span>
        <Segmented
          dark
          label="Slippage"
          value={slippage}
          onChange={setSlippage}
          options={[
            { value: "50", label: "0.5%" },
            { value: "100", label: "1%" },
            { value: "200", label: "2%" },
          ]}
        />
      </div>
      <Button
        size="lg"
        className="w-full"
        variant={exitable ? "primary" : "white"}
        disabled={!valid || !!blocker || flow.running || proceeds === undefined}
        loading={flow.running}
        onClick={submit}
      >
        {blocker ?? "Sell at the bid"}
      </Button>
      {flow.steps.some((st) => st.phase !== "todo") ? <TxProgress dark steps={flow.steps} className="pt-1" /> : null}
      {flow.result ? (
        <p className="m-0 text-[12px] text-white/60">
          Done · <TxHash value={flow.result.hash} />
        </p>
      ) : null}
      <p className="m-0 text-[12px] leading-4 text-white/45">
        Exiting burns the receipts, which is what lets the exit and redemption strategies share one
        reserve: a unit can leave through either, never both.
      </p>
    </div>
  );
}
