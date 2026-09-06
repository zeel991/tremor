"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { Segmented } from "@/components/ui/Segmented";
import { Tag } from "@/components/ui/Tag";
import { Button } from "@/components/ui/Button";
import { InfoGlyph } from "@/components/ui/Tooltip";
import { cx, fmtDateTime, fmtDuration, fmtUnits, fmtUsdc, fmtVolPct, fmtWad, yymmdd } from "@/lib/format";
import {
  HOUR,
  INTERVAL_LADDER,
  MAX_SAMPLES,
  SALE_MODE_LABEL,
  HALF_SPREAD_CHOICES,
  SELLOUT_LIFT_CHOICES,
  type Derived,
  type OverrideKey,
  type Overrides,
  type ParamKey,
  type SaleMode,
} from "@/lib/derive";
import type { SeriesParams } from "@/lib/series";

// ---------------------------------------------------------------- small controls

function RowInput({
  label,
  value,
  onChange,
  unit,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  type?: "text" | "datetime-local";
}) {
  return (
    <div className={cx("w-full max-w-[240px]", unit && "input-wrap")}>
      <input
        className="input input-mono !h-9"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        inputMode={type === "text" ? "decimal" : undefined}
        autoComplete="off"
        spellCheck={false}
      />
      {unit ? <span className="input-unit tag tag-outline !h-[20px] bg-bg !text-[11px]">{unit}</span> : null}
    </div>
  );
}

function RowSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select className="input input-mono !h-9 max-w-[240px]" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * One `SeriesParams` field on one row: name + info glyph (meaning and formula live in the hover),
 * the literal that ships in mono under the name, the control, and the derived reading in mono
 * on the right. Overridden rows carry the lime left border the program viewer uses for a Tremor opcode.
 */
function ParamRow({
  name,
  value,
  reading,
  tip,
  control,
  overridden,
  onReset,
  issues,
}: {
  name: string;
  value: string;
  reading: ReactNode;
  tip: ReactNode;
  control?: ReactNode;
  overridden?: boolean;
  onReset?: () => void;
  issues?: ReactNode;
}) {
  return (
    <div className={cx("ins !py-2", overridden && "ins-tremor")}>
      <div className="grid items-center gap-x-4 gap-y-2 md:grid-cols-[minmax(0,180px)_minmax(0,1fr)_minmax(0,260px)]">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="mono text-[12px] font-medium">{name}</span>
            <InfoGlyph tip={tip} />
            {overridden ? (
              <button type="button" className="btn-text !text-[11px]" onClick={onReset}>
                reset
              </button>
            ) : null}
          </div>
          <div className="mono truncate text-[11px] leading-4 text-ink-3">{value}</div>
        </div>
        <div className="min-w-0">{control}</div>
        <div className="mono truncate text-[12px] leading-4 text-ink-2 md:text-right">{reading}</div>
      </div>
      {issues}
    </div>
  );
}

// ---------------------------------------------------------------- helpers

const toLocalInput = (ts: number): string => {
  const d = new Date(ts * 1000);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v: string): number | null => {
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};
const plain = (s: string): string => s.replace(/,/g, "");
/** Cell-sized versions of SALE_MODE_LABEL; the full label rides on the row's tooltip. */
const SALE_SHORT: Record<SaleMode, string> = { start: "Start", quarter: "Quarter", half: "Half", expiry: "Expiry" };

// ---------------------------------------------------------------- the disclosure

export function AdvancedParams({
  d,
  overrides,
  setOverride,
  resetAll,
  customVolPct,
  onCustomVol,
  tenorDays,
  open,
  setOpen,
}: {
  d: Derived;
  overrides: Overrides;
  setOverride: (k: OverrideKey, v: string | undefined) => void;
  resetAll: () => void;
  customVolPct: string;
  onCustomVol: (v: string) => void;
  tenorDays: number;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const p: SeriesParams = d.draft;
  const ref = useRef<HTMLDetailsElement>(null);
  const nudged = useRef(false);

  const advIssues = [...d.errors, ...d.warnings].filter((i) => i.where === "advanced");
  const hasAdvError = d.errors.some((i) => i.where === "advanced");

  // An error can never hide behind the disclosure: it opens itself and scrolls into view.
  useEffect(() => {
    if (!hasAdvError) {
      nudged.current = false;
      return;
    }
    setOpen(true);
    if (!nudged.current) {
      nudged.current = true;
      ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [hasAdvError, setOpen]);

  const issuesFor = (param: ParamKey): ReactNode => {
    const mine = advIssues.filter((i) => i.param === param);
    const notes = d.notes.filter((n) => n.param === param);
    if (mine.length === 0 && notes.length === 0) return null;
    return (
      <div className="mt-1.5 flex flex-col gap-1">
        {mine.map((i) => (
          <p key={i.id} className={cx("small m-0", d.errors.includes(i) ? "text-down" : "text-lime-dark")}>
            {i.message}
          </p>
        ))}
        {notes.map((n) => (
          <p key={n.id} className="small m-0 text-ink-2">
            {n.message}
          </p>
        ))}
      </div>
    );
  };

  const liftBps = overrides.selloutLiftBps ?? "5000";
  const impactCustom = overrides.impactPerUnit !== undefined;
  const saleMode = (overrides.saleMode ?? "quarter") as SaleMode;
  const priceTouched = customVolPct.trim() !== "";

  return (
    <details ref={ref} open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} className="card !p-0">
      <summary className="flex h-10 cursor-pointer list-none items-center gap-x-3 px-4 [&::-webkit-details-marker]:hidden">
        <span className="text-[14px] font-medium">Advanced</span>
        <span className="meta flex-1">
          <span className="mono">13</span> params · derived from window, size, price
        </span>
        <InfoGlyph tip="Every field is computed from the three decisions; change one here and it stays fixed until reset. The mono literal under each name is the exact argument shipped in createSeries(params)." />
        {d.overriddenKeys.length > 0 ? (
          <Tag tone="lime">
            {d.overriddenKeys.length} override{d.overriddenKeys.length === 1 ? "" : "s"}
          </Tag>
        ) : null}
        <span aria-hidden className="text-ink-3">
          {open ? "−" : "+"}
        </span>
      </summary>

      <div className="hairline-t bg-bg-2 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <Link href="/docs/guides/write" className="btn-text !text-[12px]">
            Guide
          </Link>
          <Button variant="tertiary" size="sm" disabled={d.overriddenKeys.length === 0} onClick={resetAll}>
            Reset all
          </Button>
        </div>

        <div className="border border-line bg-bg">
          <ParamRow name="feed" value={p.feed} reading="Chainlink ETH/USD · 8 dec" tip="The Chainlink proxy whose round history settles realized variance; from the deployment config." />
          <ParamRow name="quoteToken" value={p.quoteToken} reading="USDC · 6 dec" tip="Premiums are paid and collateral is committed in this token; from the deployment config." />

          <ParamRow
            name="start"
            value={String(p.start)}
            reading={fmtDateTime(p.start)}
            tip="Window opens and the first sample is taken. Default: the next whole hour at least 5 min out, so the grid lands on clean clock times."
            overridden={overrides.start !== undefined}
            onReset={() => setOverride("start", undefined)}
            control={
              <RowInput
                label="Start"
                type="datetime-local"
                value={toLocalInput(p.start)}
                onChange={(v) => {
                  const ts = fromLocalInput(v);
                  setOverride("start", ts === null ? v : String(ts));
                }}
              />
            }
            issues={issuesFor("start")}
          />

          <ParamRow
            name="expiry"
            value={String(p.expiry)}
            reading={fmtDateTime(p.expiry)}
            tip="Last sample and settlement. expiry = start + days × 86,400; only the day count is edited, which keeps the window an exact multiple of the sampling interval."
            overridden={overrides.tenorDays !== undefined}
            onReset={() => setOverride("tenorDays", undefined)}
            control={<RowInput label="Window in days" unit="days" value={overrides.tenorDays ?? String(tenorDays)} onChange={(v) => setOverride("tenorDays", v)} />}
            issues={issuesFor("expiry")}
          />

          <ParamRow
            name="saleEnd"
            value={String(p.saleEnd)}
            reading={fmtDateTime(p.saleEnd)}
            tip={`Buying stops here (${SALE_MODE_LABEL[saleMode].toLowerCase()}). Default: start + a quarter of the window, snapped to the grid; later lets buyers price off variance that has already printed.`}
            overridden={overrides.saleMode !== undefined}
            onReset={() => setOverride("saleMode", undefined)}
            control={
              <Segmented
                block
                className="segmented-grid max-w-[420px]"
                label="Sale closes"
                value={saleMode}
                onChange={(v) => setOverride("saleMode", v)}
                options={(["start", "quarter", "half", "expiry"] as SaleMode[]).map((m) => ({ value: m, label: SALE_SHORT[m] }))}
              />
            }
            issues={issuesFor("saleEnd")}
          />

          <ParamRow
            name="sampleInterval"
            value={String(p.sampleInterval)}
            reading={`${fmtDuration(p.sampleInterval)} · ${d.samples} samples`}
            tip={`Seconds between Chainlink samples. Default: the finest grid at or under ${MAX_SAMPLES} samples (the measured gas envelope); every option divides a day.`}
            overridden={overrides.sampleInterval !== undefined}
            onReset={() => setOverride("sampleInterval", undefined)}
            control={
              <RowSelect
                label="Sampling interval"
                value={String(p.sampleInterval)}
                onChange={(v) => setOverride("sampleInterval", v)}
                options={INTERVAL_LADDER.map((v) => ({
                  value: String(v),
                  label: `${fmtDuration(v)} · ${Math.max(1, Math.round((tenorDays * 86_400) / v))} samples`,
                }))}
              />
            }
            issues={issuesFor("sampleInterval")}
          />

          <ParamRow
            name="unitNotional"
            value={p.unitNotional.toString()}
            reading={`${fmtUsdc(p.unitNotional)} USDC / unit / σ²`}
            tip="USDC one unit pays per 1.0 of realized variance. A protocol constant so a unit means the same thing in every series."
            overridden={overrides.unitNotional !== undefined}
            onReset={() => setOverride("unitNotional", undefined)}
            control={<RowInput label="Unit notional" unit="USDC" value={overrides.unitNotional ?? plain(fmtUsdc(p.unitNotional))} onChange={(v) => setOverride("unitNotional", v)} />}
            issues={issuesFor("unitNotional")}
          />

          <ParamRow
            name="capVariance"
            value={p.capVariance.toString()}
            reading={`${fmtVolPct(p.capVariance)}% vol · ${fmtUsdc(d.maxPayoutPerUnit)} USDC / unit`}
            tip="Payout ceiling. Default: a round vol at least 2× trailing realized and at least √(2 × price), so buyers keep 2× upside; anchored on realized vol so changing your price cannot move your collateral."
            overridden={overrides.capVolPct !== undefined}
            onReset={() => setOverride("capVolPct", undefined)}
            control={<RowInput label="Cap" unit="% vol" value={overrides.capVolPct ?? plain(fmtVolPct(p.capVariance, 2))} onChange={(v) => setOverride("capVolPct", v)} />}
            issues={issuesFor("capVariance")}
          />

          <ParamRow
            name="anchorVariance"
            value={p.anchorVariance.toString()}
            reading={`${fmtVolPct(p.anchorVariance)}% vol · ${fmtUsdc(d.askPerUnit)} / ${fmtUsdc(d.bidPerUnit)} USDC`}
            tip="Where the market rests with no inventory sold, as variance: (vol ÷ 100)². This is the mid the spread is quoted around, not a claim about what variance is worth."
            control={<RowInput label="Anchor vol" unit="% vol" value={priceTouched ? customVolPct : plain(fmtVolPct(p.anchorVariance, 2))} onChange={onCustomVol} />}
            issues={issuesFor("anchorVariance")}
          />

          <ParamRow
            name="halfSpreadBps"
            value={String(p.halfSpreadBps)}
            reading={`±${(p.halfSpreadBps / 100).toFixed(2)}% · ${fmtUsdc(d.askPerUnit - d.bidPerUnit)} USDC wide`}
            tip="Half the bid/ask spread, in basis points of the projected variance. The ask is the mid plus this, the bid is the mid minus it, and both are clamped inside the cap. This is the only compensation the market gets for standing on both sides."
            overridden={overrides.halfSpreadBps !== undefined}
            onReset={() => setOverride("halfSpreadBps", undefined)}
            control={
              <Segmented
                block
                className="segmented-grid max-w-[420px]"
                label="Half-spread"
                value={String(p.halfSpreadBps)}
                onChange={(v) => setOverride("halfSpreadBps", v)}
                options={HALF_SPREAD_CHOICES.map((b) => ({ value: String(b), label: `${b / 100}%` }))}
              />
            }
            issues={issuesFor("halfSpreadBps")}
          />

          <ParamRow
            name="impactPerUnit"
            value={p.impactPerUnit.toString()}
            reading={`${fmtWad(p.impactPerUnit, 5)} σ²/unit · ${fmtVolPct(d.askAtSellOut)}% sold out`}
            tip="How far the forward variance moves per unit of net inventory sold: min(lift × anchor, cap − anchor) ÷ maxUnits, so clearing the whole inventory is a bounded, stated move. The skew decays back on the half-life, and it falls again when holders exit."
            overridden={overrides.selloutLiftBps !== undefined || impactCustom}
            onReset={() => {
              setOverride("selloutLiftBps", undefined);
              setOverride("impactPerUnit", undefined);
            }}
            control={
              <div className="flex flex-col gap-2">
                <Segmented
                  block
                  className="segmented-grid max-w-[420px]"
                  label="Price impact at full sell-out"
                  value={impactCustom ? "custom" : liftBps}
                  onChange={(v) => {
                    if (v === "custom") {
                      setOverride("impactPerUnit", fmtWad(p.impactPerUnit, 8).replace(/,/g, ""));
                    } else {
                      setOverride("impactPerUnit", undefined);
                      setOverride("selloutLiftBps", v);
                    }
                  }}
                  options={[...SELLOUT_LIFT_CHOICES.map((b) => ({ value: String(b), label: `+${Number(b) / 100}%` })), { value: "custom", label: "Custom" }]}
                />
                {impactCustom ? (
                  <RowInput label="Impact per unit" unit="σ²/unit" value={overrides.impactPerUnit ?? ""} onChange={(v) => setOverride("impactPerUnit", v)} />
                ) : null}
              </div>
            }
            issues={issuesFor("impactPerUnit")}
          />

          <ParamRow
            name="halfLife"
            value={String(p.halfLife)}
            reading={p.halfLife === 0 ? "no decay" : fmtDuration(p.halfLife)}
            tip="Time for the inventory skew to fade by half. Default: three sampling steps held between 1 h and 12 h — long enough that splitting a fill gains nothing, short enough that a quiet day brings the quote back to the anchor."
            overridden={overrides.halfLifeHours !== undefined}
            onReset={() => setOverride("halfLifeHours", undefined)}
            control={<RowInput label="Half-life" unit="hours" value={overrides.halfLifeHours ?? String(Math.round(p.halfLife / HOUR))} onChange={(v) => setOverride("halfLifeHours", v)} />}
            issues={issuesFor("halfLife")}
          />

          <ParamRow
            name="maxUnits"
            value={p.maxUnits.toString()}
            reading={`${fmtUnits(p.maxUnits, 2)} units · ${fmtUsdc(d.collateralCommitted)} USDC`}
            tip="Inventory minted to your vault. Default: collateral ÷ max payout per unit, floored to 0.01 units so the reservation the whole inventory can create never exceeds what you deposited."
            overridden={overrides.maxUnits !== undefined}
            onReset={() => setOverride("maxUnits", undefined)}
            control={<RowInput label="Max units" unit="units" value={overrides.maxUnits ?? plain(fmtUnits(p.maxUnits, 2))} onChange={(v) => setOverride("maxUnits", v)} />}
            issues={issuesFor("maxUnits")}
          />
        </div>

        <p className="meta mt-3 mb-0">
          <span className="mono">tVAR-ETH-{yymmdd(p.expiry)}</span> · deployed by <span className="mono">createSeries</span> · mints{" "}
          <span className="mono">maxUnits</span> to your vault · burned on exit or redemption, which is what releases your collateral
        </p>
      </div>
    </details>
  );
}
