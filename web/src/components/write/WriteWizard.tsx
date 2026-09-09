"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useTrailing, WINDOW_SECONDS, type TrailingWindow } from "@/lib/api";
import { useTokenBalance, useTrailingOnchain, useWriterVault } from "@/lib/chain";
import { ADDR, isDeployed } from "@/lib/contracts";
import { cx, fmtUnits, fmtUsdc, fmtVolPct, formatFixed, USDC_DECIMALS, yymmdd } from "@/lib/format";
import { deriveSeries, maxCollateralFor, type Derived, type OverrideKey, type Overrides, type Stance } from "@/lib/derive";
import { CREATE_SERIES_PLAN, purgeLegacyCheckpoints, runCreateSeries, useTxFlow, type CreateSeriesResult } from "@/lib/tx";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Disabled, InfoGlyph } from "@/components/ui/Tooltip";
import { useToast } from "@/components/ui/Toast";
import { TxProgress } from "@/components/tx/TxProgress";
import { Decisions } from "./Decisions";
import { AdvancedParams } from "./AdvancedParams";

/** Match the anchor's lookback to the tenor: a 30-day series is not priced off one calm day. */
const anchorWindow = (tenorDays: number): TrailingWindow => (tenorDays <= 1 ? "1d" : tenorDays <= 14 ? "7d" : "30d");

/** parseDecimal() strips commas, so the ticket amount can be grouped like every other number on the page. */
const ticketUsdc = (v: bigint): string => formatFixed(v, USDC_DECIMALS, { maxFrac: 2 });
/** Ticket figures always carry two decimals so the column of amounts lines up. */
const usd2 = (v: bigint): string => formatFixed(v, USDC_DECIMALS, { maxFrac: 2, minFrac: 2 });
const units2 = (v: bigint): string => fmtUnits(v, 2).includes(".") ? fmtUnits(v, 2) : `${fmtUnits(v, 2)}.00`;

const VAULT_NOTE =
  "Collateral goes into a maker vault at a deterministic address that only you own. The vault has no upgrade path, no admin and no rescue function. You can withdraw whatever is free, but every unit that sells reserves its capped payout, and the vault reverts a withdrawal that would touch a reservation, a revocation of the Aqua allowance, and any attempt to move unsold inventory. A reservation is released only when the receipt is burned — on exit or on redemption.";

/** Short button label per primary error id; the full derive.ts message rides on the hover. */
const ERROR_LABEL: Record<string, string> = {
  "under-one-unit": "Size below one unit",
  "no-collateral": "Set collateral",
  "collateral-parse": "Collateral is not a number",
  "anchor-parse": "Set a price",
  "anchor-uint64": "Price too high",
  "anchor-trailing": "Enter a custom price",
  "spread-range": "Spread out of range",
  "ask-over-cap": "Sell-out ask above the cap",
};

export function WriteWizard() {
  const { address } = useAccount();
  const toast = useToast();
  const qc = useQueryClient();
  const flow = useTxFlow<CreateSeriesResult>(CREATE_SERIES_PLAN);
  const usdcBal = useTokenBalance(ADDR.usdc, address);
  const vault = useWriterVault(address);
  const vaultFree = vault.data?.exists ? vault.data.state.free : 0n;

  // ---- the three decisions
  const [tenorDays, setTenorDays] = useState(7);
  const [stance, setStance] = useState<Stance>("fair");
  const [customVolPct, setCustomVolPct] = useState("");
  const [collateral, setCollateral] = useState("2,000");
  const [overrides, setOverrides] = useState<Overrides>({});
  const [advOpen, setAdvOpen] = useState(false);
  const [nowTs, setNowTs] = useState(() => Math.floor(Date.now() / 1000));
  const collateralTouched = useRef(false);

  useEffect(() => {
    const t = window.setInterval(() => setNowTs(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // A v1 create checkpoint describes a different design against different addresses; drop it once.
  useEffect(() => purgeLegacyCheckpoints(), []);

  // ---- price anchor: backend first, the Lens as the fallback that keeps the form alive
  const win = anchorWindow(tenorDays);
  const trailing = useTrailing(win);
  const onchain = useTrailingOnchain(WINDOW_SECONDS[win], 3600, trailing.isError);
  const trailingVariance = trailing.data?.rv ?? onchain.data?.rv ?? null;
  const trailingPending = trailingVariance === null && !(trailing.isError && (onchain.isError || !isDeployed));

  const setOverride = useCallback((k: OverrideKey, v: string | undefined) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (v === undefined) delete next[k];
      else next[k] = v;
      return next;
    });
  }, []);
  const resetAll = useCallback(() => setOverrides({}), []);

  const d: Derived = useMemo(
    () =>
      deriveSeries({
        nowTs,
        feed: ADDR.feed,
        quoteToken: ADDR.usdc,
        trailingVariance,
        trailingPending,
        tenorDays,
        collateral,
        stance,
        customVolPct,
        walletUsdc: address && usdcBal.data !== undefined ? usdcBal.data + vaultFree : undefined,
        overrides,
      }),
    [nowTs, trailingVariance, trailingPending, tenorDays, collateral, stance, customVolPct, address, usdcBal.data, vaultFree, overrides],
  );

  // With no trailing read there is nothing to price against, so the writer has to name a level.
  useEffect(() => {
    if (!d.trailingAvailable && !trailingPending && stance !== "custom") {
      const timer = window.setTimeout(() => {
        setStance("custom");
        setCustomVolPct((v) => (v.trim() === "" ? "60.0" : v));
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [d.trailingAvailable, trailingPending, stance]);

  // Default the collateral to whatever the writer can actually back, once, until they type.
  useEffect(() => {
    if (collateralTouched.current || usdcBal.data === undefined) return;
    const cap = maxCollateralFor(usdcBal.data + vaultFree, d.draft.unitNotional, d.draft.capVariance);
    const want = 2_000_000_000n; // 2,000 USDC
    const pick = cap < want ? cap : maxCollateralFor(want, d.draft.unitNotional, d.draft.capVariance);
    if (pick > 0n) {
      const timer = window.setTimeout(() => setCollateral(ticketUsdc(pick)), 0);
      return () => window.clearTimeout(timer);
    }
  }, [usdcBal.data, vaultFree, d.draft.unitNotional, d.draft.capVariance]);

  const onCollateral = (v: string) => {
    collateralTouched.current = true;
    setCollateral(v);
  };
  const onMax = () => {
    collateralTouched.current = true;
    if (usdcBal.data !== undefined)
      setCollateral(ticketUsdc(maxCollateralFor(usdcBal.data + vaultFree, d.draft.unitNotional, d.draft.capVariance)));
  };
  const onStance = (s: Stance) => {
    setStance(s);
    if (s === "custom" && customVolPct.trim() === "") setCustomVolPct(fmtVolPct(d.draft.anchorVariance, 2).replace(/,/g, ""));
  };
  const onCustomVol = (v: string) => {
    setCustomVolPct(v);
    if (v.trim() !== "") setStance("custom");
    else if (d.trailingAvailable) setStance("fair");
  };

  const params = d.params;
  const primaryErrors = d.errors.filter((e) => e.where === "primary");
  const advErrorCount = d.errors.length - primaryErrors.length;
  const sizeError = primaryErrors.find((e) => e.id === "under-one-unit" || e.id === "no-collateral" || e.id === "collateral-parse" || e.id === "short-balance");

  // ---- blocker: the button label, and the precise reason on hover. Sources: derive.ts errors + wallet state.
  let blocker: string | undefined;
  let blockerReason: string | undefined;
  const short = d.errors.find((e) => e.id === "short-balance");
  const firstPrimary = primaryErrors.find((e) => e.id !== "short-balance" && e.id !== "anchor-pending");
  if (!isDeployed) {
    blocker = "Contracts not deployed";
    blockerReason = "No Tremor deployment is configured for this network.";
  } else if (!address) {
    blocker = "Connect a wallet";
    blockerReason = "Connect a wallet to write a series.";
  } else if (usdcBal.data === 0n && vaultFree === 0n) {
    blocker = "Add USDC to write";
    blockerReason = "This wallet holds no USDC and your vault has no free collateral; collateral is committed in USDC.";
  } else if (short) {
    blocker = "Not enough USDC";
    blockerReason = short.message;
  } else if (d.trailingPending) {
    blocker = "Reading realized vol…";
    blockerReason = "Trailing realized vol has not loaded yet.";
  } else if (!params) {
    blocker = firstPrimary ? (ERROR_LABEL[firstPrimary.id] ?? "Fix the highlighted fields") : "Fix Advanced";
    blockerReason = firstPrimary
      ? firstPrimary.message
      : `${advErrorCount} overridden parameter${advErrorCount === 1 ? "" : "s"} ${advErrorCount === 1 ? "has" : "have"} an error — open Advanced.`;
  }

  const maxReason =
    usdcBal.data === undefined
      ? "No USDC balance read yet"
      : usdcBal.data === 0n && vaultFree === 0n
        ? "This wallet holds no USDC and your vault has no free collateral"
        : undefined;

  /** Only the shortfall is pulled from the wallet; collateral already free in the vault is reused. */
  const topUp = d.collateralCommitted > vaultFree ? d.collateralCommitted - vaultFree : 0n;

  const submit = async () => {
    if (!params || blocker) return;
    const res = await flow.run((ctx) => runCreateSeries(ctx, { params, depositAmount: topUp }));
    if (res) {
      toast.success(`Series #${res.id.toString()} is live`, "ISSUE, EXIT and SETTLE shipped to Aqua.");
      void qc.invalidateQueries({ queryKey: ["chain"] });
      void qc.invalidateQueries({ queryKey: ["api"] });
    } else if (flow.error) {
      toast.error("Write failed", flow.error);
    }
  };

  const p = d.draft;
  const tenorLabel = `${Math.round((p.expiry - p.start) / 86_400)}d`;

  const rows: Array<{ k: string; v: React.ReactNode; tip: string }> = [
    {
      k: "Units",
      v: units2(p.maxUnits),
      tip: "Receipt units minted to your vault and offered on the ISSUE leg. Each redeems for 100 USDC × realized variance, never above the cap.",
    },
    {
      k: "Opens bid / ask",
      v: (
        <>
          {usd2(d.bidPerUnit)} / {usd2(d.askPerUnit)}
          <span className="unit">USDC</span>
        </>
      ),
      tip: "The two executable prices your market opens at, per unit. Buyers pay the ask; holders who want out before expiry hit your bid.",
    },
    {
      k: "Premium if sold out",
      v: (
        <>
          {usd2(d.premiumIfSoldOut)}
          <span className="unit">USDC</span>
        </>
      ),
      tip: "Total premium if every unit sells at the ask: the quote rises as inventory clears, so this exceeds units × first-unit price. Buybacks on your bid give some of it back.",
    },
    {
      k: "Break-even vol",
      v: `${fmtVolPct(d.breakEvenVariance)}%`,
      tip: "Realized vol at which the redemptions equal the premium collected across the whole inventory.",
    },
    {
      k: "Max payout / unit",
      v: (
        <>
          {usd2(d.maxPayoutPerUnit)}
          <span className="unit">USDC</span>
        </>
      ),
      tip: "100 USDC × cap variance: the most one unit can ever pay, and what your vault reserves the moment that unit sells.",
    },
    {
      k: "Reserved if sold out",
      v: (
        <>
          {usd2(d.collateralCommitted)}
          <span className="unit">USDC</span>
        </>
      ),
      tip: "Vault collateral locked if the whole inventory sells: units × max payout per unit. It cannot be withdrawn until the receipts are burned.",
    },
    {
      k: "Worst case",
      v: (
        <>
          {d.worstCaseNet < 0n ? `−${usd2(-d.worstCaseNet)}` : usd2(d.worstCaseNet)}
          <span className="unit">USDC</span>
        </>
      ),
      tip: "Premium taken minus the full capped payout: your loss if realized vol finishes at or above the cap with the whole inventory sold.",
    },
    {
      k: "Pays max at",
      v: `${fmtVolPct(p.capVariance)}% vol`,
      tip: "The cap. Realized vol at or above this redeems for the maximum and never more, however far ETH moves.",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(360px,1fr)] xl:items-start">
      {/* ---------------------------------------------------------------- left: white workspace */}
      <div className="flex flex-col gap-6">
        <Decisions
          d={d}
          tenorDays={tenorDays}
          onTenor={setTenorDays}
          stance={stance}
          onStance={onStance}
          customVolPct={customVolPct}
          onCustomVol={onCustomVol}
          trailingWindow={win}
        />

        {advErrorCount > 0 ? (
          <Banner tone="negative">
            {advErrorCount} overridden parameter{advErrorCount === 1 ? "" : "s"} need{advErrorCount === 1 ? "s" : ""} attention — see Advanced.
          </Banner>
        ) : null}

        <AdvancedParams
          d={d}
          overrides={overrides}
          setOverride={setOverride}
          resetAll={resetAll}
          customVolPct={customVolPct}
          onCustomVol={onCustomVol}
          tenorDays={tenorDays}
          open={advOpen}
          setOpen={setAdvOpen}
        />
      </div>

      {/* ---------------------------------------------------------------- right: the order ticket */}
      <aside className="panel flex flex-col gap-4 p-4 xl:sticky xl:top-[88px]" aria-label="Write ticket">
        <div className="flex items-baseline gap-2 whitespace-nowrap">
          <span className="mono text-[14px] font-medium leading-5">tVAR-ETH-{yymmdd(p.expiry)}</span>
          <span className="text-[12px] leading-4 text-white/50">
            · <span className="mono">{tenorLabel}</span> · <span className="mono">{units2(p.maxUnits)}</span> units
          </span>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="lbl">
              Size
              <InfoGlyph tone="white" tip="USDC put at risk. Inventory = collateral ÷ max loss per unit, floored to 0.01 units, so the committed amount never exceeds what you type." />
            </span>
            {sizeError ? (
              <InfoGlyph tone="white" tip={sizeError.message} label="Size problem" className="!border-down !text-down" />
            ) : (
              <span className="meta">
                <span className="mono">{usd2(topUp)}</span> from wallet
              </span>
            )}
          </div>
          <div className={cx("amt", sizeError && "outline outline-1 outline-down")}>
            <div className="amt-head">
              <span className="truncate">
                Balance <b>{usdcBal.data !== undefined ? fmtUsdc(usdcBal.data + vaultFree) : "—"}</b>
              </span>
              <Disabled reason={maxReason} tone="white">
                <button type="button" className="amt-max" onClick={onMax} disabled={maxReason !== undefined}>
                  MAX
                </button>
              </Disabled>
            </div>
            <div className="amt-body">
              <input
                className="amt-input"
                aria-label="Collateral in USDC"
                value={collateral}
                onChange={(e) => onCollateral(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="amt-select">
                <span className="amt-select-icon">$</span>USDC
              </span>
            </div>
          </div>
        </div>

        <dl className="m-0">
          {rows.map((r) => (
            <div className="tk" key={r.k}>
              <dt>
                {r.k}
                <InfoGlyph tone="white" tip={r.tip} />
              </dt>
              <dd>{r.v}</dd>
            </div>
          ))}
        </dl>

        <TxProgress dark compact steps={flow.steps} />

        <Disabled reason={!flow.running ? blockerReason : undefined} tone="white" block>
          <Button className="w-full" size="lg" disabled={!!blocker || flow.running} loading={flow.running} onClick={submit}>
            {blocker ?? (flow.result ? "Write another" : "Write series")}
          </Button>
        </Disabled>

        {flow.result ? (
          <p className="m-0 text-center text-[12px] leading-4 text-white/60">
            Series #{flow.result.id.toString()} is live ·{" "}
            <Link href={`/series/${flow.result.id.toString()}`} className="underline underline-offset-2">
              open it
            </Link>
          </p>
        ) : null}
        {flow.error && !flow.running ? (
          <p className="m-0 flex items-center gap-1.5 text-[12px] leading-4 text-white/45">
            Retry resumes the same series
            <InfoGlyph tone="white" tip="The created series ID is saved locally. Confirmed approvals and shipped legs are detected and skipped, so retry cannot create a duplicate series." />
          </p>
        ) : null}

        <p className="m-0 flex items-center gap-1.5 text-[12px] leading-4 text-white/45">
          <span className="truncate">Collateral held in your own vault · reserved per unit sold</span>
          <InfoGlyph tone="white" tip={VAULT_NOTE} />
        </p>
      </aside>
    </div>
  );
}
