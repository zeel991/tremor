"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useQuoteIssueExactIn, useQuoteIssueExactOut, useTokenBalance } from "@/lib/chain";
import { isDeployed, takerSpender } from "@/lib/contracts";
import { fmtUnits, fmtUsdc, fmtVolPct, tryParseDecimal, USDC_DECIMALS, RECEIPT_DECIMALS, WAD } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { breakEvenVariance, canBuy, maxPayoutPerUnit, Status, type SeriesState } from "@/lib/series";
import { BUY_PLAN, runBuy, useTxFlow, type SwapResult } from "@/lib/tx";
import { DarkItems } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { TxProgress } from "@/components/tx/TxProgress";
import { TxHash } from "@/components/ui/Address";
import { IconArrow } from "@/components/ui/Icons";
import { TicketWidget } from "./TicketWidget";

type Mode = "exactIn" | "exactOut";

/**
 * Buy ticket in the dark rail: USDC in, receipts out at the executable ask. Reads `?units=` for hedge
 * presets.
 */
export function BuyTicket({ s, onUnitsChange }: { s: SeriesState; onUnitsChange?: (units: bigint, premium: bigint) => void }) {
  const params = useSearchParams();
  const presetUnits = params.get("units");
  return <BuyTicketInner s={s} onUnitsChange={onUnitsChange} presetUnits={presetUnits ?? undefined} />;
}

/**
 * The same ticket in read-only preview (landing hero): light frame, live quote, CTA opens the market.
 * No search params, no wallet actions.
 */
export function BuyTicketPreview({ s }: { s: SeriesState }) {
  return <BuyTicketInner s={s} preview />;
}

function BuyTicketInner({
  s,
  onUnitsChange,
  presetUnits,
  preview,
}: {
  s: SeriesState;
  onUnitsChange?: (units: bigint, premium: bigint) => void;
  presetUnits?: string;
  preview?: boolean;
}) {
  const [mode, setMode] = useState<Mode>(presetUnits ? "exactOut" : "exactIn");
  const [amount, setAmount] = useState(presetUnits ?? "");
  const [slippage, setSlippage] = useState<"50" | "100" | "200">("100");
  const { address } = useAccount();
  const toast = useToast();
  const qc = useQueryClient();
  const flow = useTxFlow<SwapResult>(BUY_PLAN);

  const debounced = useDebounced(amount, 300);
  const parsed = useMemo(
    () => (debounced.trim() === "" ? null : tryParseDecimal(debounced, mode === "exactIn" ? USDC_DECIMALS : RECEIPT_DECIMALS)),
    [debounced, mode],
  );
  const valid = parsed !== null && parsed > 0n;

  // The engine clamps a fill to whichever binds first — Aqua's receipt inventory, the vault's free
  // collateral, or the distance from the ask to the cap. Both quote helpers already return the
  // clamped size, so the ticket shows the fill the buyer actually gets, and `runBuy` sends it with
  // allowPartialFill so a clamp tightening between quote and execution fills small instead of
  // reverting.
  const forSale = s.unitsAvailable;
  const qIn = useQuoteIssueExactIn(s.id, mode === "exactIn" && valid ? parsed : null);
  const qOut = useQuoteIssueExactOut(s.id, mode === "exactOut" && valid ? parsed : null);
  const usdcBal = useTokenBalance(s.params.quoteToken, preview ? undefined : address);

  const units = mode === "exactIn" ? qIn.data?.units : qOut.data?.filledUnits;
  const premium = mode === "exactIn" ? qIn.data?.premium : qOut.data?.premium;
  const quoting = mode === "exactIn" ? qIn.isFetching : qOut.isFetching;
  const quoteError = mode === "exactIn" ? qIn.error : qOut.error;
  /** A clamp bound the fill below what was asked for; the swap fills what it can. */
  const partial =
    mode === "exactIn"
      ? qIn.data !== undefined && parsed !== null && qIn.data.premium < parsed
      : qOut.data !== undefined && parsed !== null && qOut.data.filledUnits < parsed;

  useEffect(() => {
    if (units !== undefined && premium !== undefined) onUnitsChange?.(units, premium);
  }, [units, premium, onUnitsChange]);

  const avg = units && units > 0n && premium !== undefined ? (premium * WAD) / units : undefined;
  const be = units && premium !== undefined ? breakEvenVariance(premium, units, s.params.unitNotional) : undefined;
  const maxPayout = units ? (units * maxPayoutPerUnit(s.params)) / WAD : undefined;
  const insufficient = premium !== undefined && usdcBal.data !== undefined && usdcBal.data < premium;

  let blocker: string | undefined;
  if (!isDeployed) blocker = "Contracts not deployed";
  else if (!address && !preview) blocker = "Connect a wallet to buy";
  else if (s.status === Status.Closed) blocker = "Series closed";
  else if (s.status === Status.Finalized || s.status === Status.ExpiredUnfinalized) blocker = "Sale closed";
  else if (!s.legs.issuanceOpen) blocker = forSale === 0n ? "Sold out" : "Issuance closed";
  else if (!s.oracle.checkpointsCurrent) blocker = "Update the market first";
  else if (!s.fullyCollateralized) blocker = "Vault does not back this series";
  else if (!canBuy(s)) blocker = "Not for sale";
  else if (insufficient) blocker = "Insufficient USDC";

  const inputLocked = !!blocker && blocker !== "Insufficient USDC" && blocker !== "Connect a wallet to buy";

  const submit = async () => {
    if (!valid || blocker) return;
    const res = await flow.run((ctx) => runBuy(ctx, { state: s, mode, amount: parsed as bigint, slippageBps: Number(slippage) }));
    if (res) {
      const detail = res.amountOut !== undefined ? `${fmtUnits(res.amountOut)} units for ${fmtUsdc(res.amountIn ?? 0n)} USDC` : undefined;
      if (res.partial) toast.success("Filled partially", detail ? `${detail} — the market clamped the fill` : undefined);
      else toast.success("Receipts bought", detail);
      void qc.invalidateQueries({ queryKey: ["chain"] });
      void qc.invalidateQueries({ queryKey: ["api"] });
      setAmount("");
    } else if (flow.error) {
      toast.error("Buy failed", flow.error);
    }
  };

  const toggle = () => {
    setMode((m) => (m === "exactIn" ? "exactOut" : "exactIn"));
    setAmount("");
  };

  const outText = (v: bigint | undefined, fmt: (x: bigint) => string) => (v !== undefined ? fmt(v) : quoting ? "…" : "0.00");

  const usdcHalf = {
    label: (
      <>
        Balance <b>{usdcBal.data !== undefined ? fmtUsdc(usdcBal.data) : preview || !address ? "—" : "…"}</b> USDC
      </>
    ),
    unit: "USDC",
    unitIcon: "$",
  };
  const unitsHalf = {
    label: (
      <>
        For sale <b>{fmtUnits(forSale, 0)}</b> units
      </>
    ),
    unit: "receipts",
    unitIcon: "σ²",
  };

  const widget = (
    <TicketWidget
      onSwap={toggle}
      swapDisabled={inputLocked}
      top={
        mode === "exactIn"
          ? {
              ...usdcHalf,
              value: amount,
              onChange: setAmount,
              onMax: usdcBal.data !== undefined && usdcBal.data > 0n ? () => setAmount(fmtUsdc(usdcBal.data as bigint, 6).replace(/,/g, "")) : undefined,
              onUnitClick: toggle,
              disabled: inputLocked,
              inputLabel: "USDC to pay",
            }
          : {
              ...unitsHalf,
              value: amount,
              onChange: setAmount,
              onMax: forSale > 0n ? () => setAmount(fmtUnits(forSale, 18).replace(/,/g, "")) : undefined,
              onUnitClick: toggle,
              disabled: inputLocked,
              inputLabel: "Units to receive",
            }
      }
      bottom={
        mode === "exactIn"
          ? { ...unitsHalf, value: outText(units, (u) => fmtUnits(u, 4)), dim: units === undefined }
          : { ...usdcHalf, value: outText(premium, (p) => fmtUsdc(p)), dim: premium === undefined }
      }
    />
  );

  if (preview) {
    return (
      <div className="ticket-preview flex flex-col gap-3">
        {widget}
        <div className="grid grid-cols-2 gap-2">
          <div className="card !p-3">
            <div className="label">Premium</div>
            <div className="mt-1 text-[15px] font-medium tnum">{premium !== undefined ? `${fmtUsdc(premium)} USDC` : quoting ? "…" : "—"}</div>
          </div>
          <div className="card !p-3">
            <div className="label">Break-even vol</div>
            <div className="mt-1 text-[15px] font-medium tnum">{be !== undefined && be > 0n ? `${fmtVolPct(be)}%` : `${fmtVolPct(s.quote.askVariance)}%`}</div>
          </div>
        </div>
        <Link href={`/series/${s.id.toString()}`} className="btn btn-primary btn-lg w-full">
          Open market <IconArrow width={16} height={16} />
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {!s.fullyCollateralized ? (
        <p className="m-0 border border-down bg-down/10 p-3 text-[13px] leading-5 text-white" role="alert">
          Buying is disabled: the writer&apos;s vault does not currently hold what it has reserved, or a
          burn leg is no longer shipped to Aqua.
        </p>
      ) : null}
      {!s.oracle.checkpointsCurrent ? (
        <p className="m-0 border border-white/20 bg-white/5 p-3 text-[13px] leading-5 text-white/80" role="status">
          {s.oracle.samplesAvailable - s.oracle.samplesStored} Chainlink sample
          {s.oracle.samplesAvailable - s.oracle.samplesStored === 1 ? "" : "s"} have passed without being
          stored, so the market cannot quote. Anyone can update it from the Oracle tab.
        </p>
      ) : null}
      {widget}
      {quoteError ? <p className="m-0 text-[12px] text-down">Quote failed — check RPC or amount.</p> : null}
      {partial ? (
        <p className="m-0 text-[12px] text-white/60">
          This buy fills partially: the market can sell <b className="tnum">{fmtUnits(units ?? 0n, 4)}</b> units
          right now
          {mode === "exactIn" && premium !== undefined ? (
            <>
              {" "}
              for <b className="tnum">{fmtUsdc(premium)}</b> USDC
            </>
          ) : null}
          . Inventory, the vault&apos;s free collateral or the cap is the binding constraint.
        </p>
      ) : null}
      <DarkItems
        items={[
          { label: "Units", value: units !== undefined ? `${fmtUnits(units, 4)}` : quoting ? "…" : "—" },
          { label: "Premium", value: premium !== undefined ? `${fmtUsdc(premium)} USDC` : quoting ? "…" : "—" },
          { label: "Avg price / unit", value: avg !== undefined ? `${fmtUsdc(avg)} USDC` : "—" },
          { label: "Break-even vol", value: be !== undefined && be > 0n ? `${fmtVolPct(be)}%` : "—" },
          { label: "Max payout (at cap)", value: maxPayout !== undefined ? `${fmtUsdc(maxPayout)} USDC` : "—" },
          { label: "Cap", value: `${fmtVolPct(s.params.capVariance)}% vol` },
          { label: "Locked backing", value: `${fmtUsdc(s.lockedLiability, 0)} USDC` },
        ]}
      />
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-white/50">Slippage · spender {takerSpender().slice(0, 6)}…</span>
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
      <Button size="lg" className="w-full" disabled={!valid || !!blocker || flow.running || premium === undefined} loading={flow.running} onClick={submit}>
        {blocker ?? (mode === "exactIn" ? "Buy receipts" : "Buy units")}
      </Button>
      {flow.steps.some((st) => st.phase !== "todo") ? <TxProgress dark steps={flow.steps} className="pt-1" /> : null}
      {flow.result ? (
        <p className="m-0 text-[12px] text-white/60">
          Done · <TxHash value={flow.result.hash} />
        </p>
      ) : null}
    </div>
  );
}
