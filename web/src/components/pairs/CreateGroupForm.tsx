"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { ADDR, deploymentError, isDeployed, isPortfolioDeployed } from "@/lib/contracts";
import {
  RECEIPT_DECIMALS,
  USDC_DECIMALS,
  fmtUsdc,
  tryParseDecimal,
  varianceFromVolPct,
} from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { maxGroupLiability, type GroupParams } from "@/lib/portfolio";
import { CREATE_GROUP_PLAN, runCreateGroup, useTxFlow, type CreateGroupResult } from "@/lib/tx";
import { Card, LineItems } from "@/components/ui/Card";
import { Button, LinkButton } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { useToast } from "@/components/ui/Toast";
import { TxProgress } from "@/components/tx/TxProgress";
import { EmptyState } from "@/components/ui/EmptyState";

function Field({
  label,
  unit,
  value,
  onChange,
  hint,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium">{label}</span>
      <span className="input-wrap w-full">
        <input
          className="input input-mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
        />
        <span className="input-unit tag tag-outline !h-[20px] bg-bg !text-[11px]">{unit}</span>
      </span>
      {hint ? <span className="text-[12px] text-ink-3">{hint}</span> : null}
    </label>
  );
}

/**
 * Create one risk group: a shared window and cap, plus the four explicit quotes.
 *
 * The quotes are what they say: fixed bid/ask set by the writer — not a fair-value volatility model.
 * The vault flow mirrors the series wizard: create or load the vault, top it up to one full side at
 * the cap, then one transaction mints both receipts and ships all six legs.
 */
export function CreateGroupForm() {
  const { address } = useAccount();
  const toast = useToast();
  const qc = useQueryClient();
  const flow = useTxFlow<CreateGroupResult>(CREATE_GROUP_PLAN);
  const now = useNow(60_000);

  const [windowDays, setWindowDays] = useState("7");
  const [saleHours, setSaleHours] = useState("42");
  const [capVol, setCapVol] = useState("100");
  const [capPayout, setCapPayout] = useState("100");
  const [maxUnits, setMaxUnits] = useState("100");
  const [askHigh, setAskHigh] = useState("40");
  const [bidHigh, setBidHigh] = useState("30");
  const [askCalm, setAskCalm] = useState("70");
  const [bidCalm, setBidCalm] = useState("60");
  const [demo, setDemo] = useState(false);

  const parsed = useMemo(() => {
    const days = Number(windowDays);
    const hours = Number(saleHours);
    const capPayoutPerUnit = tryParseDecimal(capPayout, USDC_DECIMALS);
    const maxUnitsPerSide = tryParseDecimal(maxUnits, RECEIPT_DECIMALS);
    const quotes = [askHigh, bidHigh, askCalm, bidCalm].map((q) => tryParseDecimal(q, USDC_DECIMALS));
    let capVariance: bigint | null = null;
    try {
      capVariance = varianceFromVolPct(capVol);
    } catch {
      capVariance = null;
    }
    if (
      now === 0 ||
      !Number.isFinite(days) ||
      days <= 0 ||
      !Number.isFinite(hours) ||
      hours <= 0 ||
      capPayoutPerUnit === null ||
      capPayoutPerUnit <= 0n ||
      maxUnitsPerSide === null ||
      maxUnitsPerSide <= 0n ||
      capVariance === null ||
      capVariance <= 0n ||
      quotes.some((q) => q === null || q < 0n)
    ) {
      return null;
    }
    const interval = 3600;
    const start = Math.floor(now / interval) * interval;
    const expiry = start + Math.round(days * 86400);
    const saleEnd = Math.min(start + Math.round(hours * 3600), expiry);
    const [aH, bH, aC, bC] = quotes as bigint[];
    if (bH > aH || bC > aC) return null; // a bid above the ask is free money against the vault
    const params: GroupParams = {
      feed: ADDR.feed,
      quoteToken: ADDR.usdc,
      start,
      expiry,
      saleEnd,
      sampleInterval: interval,
      capVariance,
      capPayoutPerUnit,
      maxUnitsPerSide,
      askHigh: aH,
      bidHigh: bH,
      askCalm: aC,
      bidCalm: bC,
    };
    return params;
  }, [now, windowDays, saleHours, capVol, capPayout, maxUnits, askHigh, bidHigh, askCalm, bidCalm]);

  const required = parsed ? maxGroupLiability(parsed) : undefined;

  if (!isPortfolioDeployed) {
    return (
      <Card>
        <EmptyState action={<LinkButton href="/pairs" variant="tertiary" size="sm">Back to paired markets</LinkButton>}>
          {!isDeployed && deploymentError
            ? `Deployment manifest rejected: ${deploymentError}`
            : "This deployment manifest has no portfolio market — paired markets cannot be written here."}
        </EmptyState>
      </Card>
    );
  }

  const submit = async () => {
    if (!parsed) return;
    const res = await flow.run((ctx) => runCreateGroup(ctx, { params: parsed, backdatedDemo: demo }));
    if (res) {
      toast.success("Paired market created", `Group #${res.id.toString()}`);
      void qc.invalidateQueries({ queryKey: ["chain"] });
    } else if (flow.error) {
      toast.error("Create failed", flow.error);
    }
  };

  const blocker = !address ? "Connect a wallet" : !parsed ? "Check the inputs — bids may not exceed asks" : undefined;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(360px,1fr)] xl:items-start">
      <Card title="Terms" meta="One observation window and cap backs both sides">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Observation window" unit="days" value={windowDays} onChange={setWindowDays} />
          <Field label="Sale window" unit="hours" value={saleHours} onChange={setSaleHours} hint="Issuance closes this long after the window starts" />
          <Field label="Volatility cap" unit="% vol" value={capVol} onChange={setCapVol} hint="x reaches 1 here: HIGH pays its full cap, CALM pays zero" />
          <Field label="Cap payout S" unit="USDC / unit" value={capPayout} onChange={setCapPayout} hint="A HIGH and a CALM unit together always pay exactly S" />
          <Field label="Max units per side" unit="units" value={maxUnits} onChange={setMaxUnits} />
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Field label="HIGH ask" unit="USDC / unit" value={askHigh} onChange={setAskHigh} />
          <Field label="HIGH bid" unit="USDC / unit" value={bidHigh} onChange={setBidHigh} />
          <Field label="CALM ask" unit="USDC / unit" value={askCalm} onChange={setAskCalm} />
          <Field label="CALM bid" unit="USDC / unit" value={bidCalm} onChange={setBidCalm} />
        </div>
        <Banner className="mt-6">
          These are fixed bid/ask quotes set by you, the writer — not a fair-value volatility model. Buyers
          see them labelled that way.
        </Banner>
        <label className="mt-4 flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
          Backdated demo group (local chains only)
        </label>
      </Card>

      <aside className="panel flex flex-col gap-4 p-4 xl:sticky xl:top-[88px]">
        <span className="micro">Summary</span>
        <div className="rounded-none bg-white p-4">
          <LineItems
            items={[
              { label: "Collateral to lock", value: required !== undefined ? `${fmtUsdc(required, 0)} USDC` : "—" },
              {
                label: "Why not both caps",
                value: "reserve = max(HIGH, CALM) · S",
                mono: true,
              },
              { label: "Feed", value: `${ADDR.feed.slice(0, 8)}…`, mono: true },
              { label: "Quote token", value: "USDC", muted: true },
            ]}
          />
        </div>
        <p className="m-0 text-[12px] leading-4 text-white/45">
          One full side at the cap backs the whole group: because HIGH and CALM payouts sum to S, both sides
          can never claim their cap at once.
        </p>
        <Button size="lg" className="w-full" disabled={!!blocker || flow.running} loading={flow.running} onClick={submit}>
          {blocker ?? "Create the paired market"}
        </Button>
        {flow.steps.some((st) => st.phase !== "todo") ? <TxProgress dark steps={flow.steps} className="pt-1" /> : null}
        {flow.result ? (
          <p className="m-0 text-[12px] text-white/60">
            Created ·{" "}
            <Link href={`/pairs/${flow.result.id.toString()}`} className="underline">
              open group #{flow.result.id.toString()}
            </Link>
          </p>
        ) : null}
      </aside>
    </div>
  );
}
