"use client";

import { useId } from "react";
import dynamic from "next/dynamic";
import { Segmented } from "@/components/ui/Segmented";
import { InfoGlyph } from "@/components/ui/Tooltip";
import { cx, fmtDateTime, fmtDuration, fmtUnits, fmtVolPct, formatFixed, USDC_DECIMALS } from "@/lib/format";
import { maxPayoutPerUnit, payoutFor, perUnitPrice } from "@/lib/series";
import { STANCE_BPS, TENORS, type Derived, type Stance } from "@/lib/derive";

const PayoffChart = dynamic(() => import("@/components/charts/PayoffChart").then((m) => m.PayoffChart), { ssr: false });

/** Scenario figures always carry two decimals so the columns line up. */
const usd2 = (v: bigint): string => formatFixed(v, USDC_DECIMALS, { maxFrac: 2, minFrac: 2 });

/** A figure inside a meta line: mono, tabular. */
const M = ({ children }: { children: React.ReactNode }) => <span className="mono">{children}</span>;

/** `label ⓘ | control` on one 36px-ish row, one line of dense metadata under the control. */
function Row({ label, tip, control, meta, className }: { label: string; tip: React.ReactNode; control: React.ReactNode; meta?: React.ReactNode; className?: string }) {
  return (
    <div className={cx("grid gap-x-4 gap-y-2 py-3 sm:grid-cols-[88px_minmax(0,1fr)]", className)}>
      <span className="lbl sm:h-[30px]">
        {label}
        <InfoGlyph tip={tip} />
      </span>
      <div className="min-w-0">
        {control}
        {meta ? <div className="meta mt-2">{meta}</div> : null}
      </div>
    </div>
  );
}

export function Decisions({
  d,
  tenorDays,
  onTenor,
  stance,
  onStance,
  customVolPct,
  onCustomVol,
  trailingWindow,
}: {
  d: Derived;
  tenorDays: number;
  onTenor: (days: number) => void;
  stance: Stance;
  onStance: (s: Stance) => void;
  customVolPct: string;
  onCustomVol: (v: string) => void;
  /** "1d" | "7d" | "30d" — the trailing realized window the anchor is read over. */
  trailingWindow: string;
}) {
  const p = d.draft;
  const customId = useId();
  const trailingKnown = d.trailingAvailable && !d.trailingFloored;
  const units = fmtUnits(p.maxUnits, 2);
  const markupBps = stance === "custom" ? null : STANCE_BPS[stance];
  const markup = markupBps === null ? null : Number(markupBps - 10_000n) / 100;

  const stanceReason = d.trailingPending
    ? "Trailing realized vol has not loaded yet"
    : d.trailingFloored
      ? "Feed printed no fresh rounds in this window — enter a custom price"
      : "Feed unavailable — enter a custom price";

  const tenorOptions = TENORS.map((t) => ({ value: String(t), label: `${t}d` }));
  const priceOptions: Array<{ value: Stance; label: string; disabled?: boolean; disabledReason?: string }> = [
    { value: "cheap", label: trailingKnown ? `Cheap ${fmtVolPct(d.stanceVariance.cheap)}%` : "Cheap", disabled: !trailingKnown, disabledReason: stanceReason },
    { value: "fair", label: trailingKnown ? `Fair ${fmtVolPct(d.stanceVariance.fair)}%` : "Fair", disabled: !trailingKnown, disabledReason: stanceReason },
    { value: "rich", label: trailingKnown ? `Rich ${fmtVolPct(d.stanceVariance.rich)}%` : "Rich", disabled: !trailingKnown, disabledReason: stanceReason },
    { value: "custom", label: "Custom" },
  ];

  const trailingText = d.trailingPending ? "—" : d.trailingFloored ? `${fmtVolPct(d.trailingVariance)}% floor` : d.trailingAvailable ? `${fmtVolPct(d.trailingVariance)}%` : "n/a";

  const windowTip = `Realized variance is measured over this window from Chainlink ETH/USD, sampled every ${fmtDuration(p.sampleInterval)} (${d.samples} samples).`;
  const saleTip =
    p.saleEnd >= p.expiry
      ? "Buying stays open to expiry, so a late buyer can price off variance that has already printed."
      : "Buying stops here so nobody can enter after the move has happened.";
  const priceTip = d.trailingPending
    ? `Reading trailing ${trailingWindow} realized vol; Cheap / Fair / Rich are multiples of it.`
    : !d.trailingAvailable
      ? "Trailing realized vol is unavailable, so there is nothing to anchor Cheap / Fair / Rich to — set the level yourself."
      : d.trailingFloored
        ? `Trailing ${trailingWindow} realized reads ${fmtVolPct(d.trailingVariance)}% — a missing market, not a calm one — so quotes anchor on the 20% floor.`
        : `Trailing ${trailingWindow} realized vol is ${fmtVolPct(d.trailingVariance)}%. ${markup === null ? "Custom = your own level" : `${stance[0].toUpperCase()}${stance.slice(1)} = +${markup}% markup`}. Your first unit sells at this level; the quote rises as inventory sells and decays back on a half-life.`;

  // scenarios
  const be = d.breakEvenVariance;
  const payoutBe = payoutFor(p.maxUnits, perUnitPrice(p.unitNotional, be));
  const payoutCap = payoutFor(p.maxUnits, maxPayoutPerUnit(p));
  const prem = d.premiumIfSoldOut;
  const scenarios = [
    { k: "Calm", sub: `realized < ${fmtVolPct(be)}%`, payout: 0n, net: prem },
    { k: "Break-even", sub: `${fmtVolPct(be)}%`, payout: payoutBe, net: prem - payoutBe },
    { k: "Cap", sub: `${fmtVolPct(p.capVariance)}%`, payout: payoutCap, net: prem - payoutCap },
  ];
  const signed = (v: bigint) => (v > 0n ? `+${usd2(v)}` : v < 0n ? `−${usd2(-v)}` : usd2(0n));

  return (
    <>
      <section className="card !p-0" aria-label="Contract">
        <div className="flex h-10 items-center justify-between gap-3 px-4 hairline-b">
          <span className="text-[14px] font-medium">Contract</span>
          <span className="meta">
            ETH/USD · <M>{d.samples}</M> samples · <M>{fmtDuration(p.sampleInterval)}</M> grid
          </span>
        </div>

        <div className="px-4">
          <Row
            label="Window"
            tip={windowTip}
            control={
              <Segmented
                block
                className="segmented-grid"
                label="Window length"
                value={String(tenorDays)}
                onChange={(v) => onTenor(Number(v))}
                options={TENORS.includes(tenorDays as (typeof TENORS)[number]) ? tenorOptions : [...tenorOptions, { value: String(tenorDays), label: `${tenorDays}d` }]}
              />
            }
            meta={
              <>
                <M>{fmtDateTime(p.start)}</M> → <M>{fmtDateTime(p.expiry)}</M> · <M>{d.samples}</M> samples · <M>{fmtDuration(p.sampleInterval)}</M> grid · sale
                closes <M>{fmtDateTime(p.saleEnd)}</M> <InfoGlyph tip={saleTip} />
              </>
            }
          />

          <Row
            label="Price"
            tip={priceTip}
            className="hairline-t"
            control={
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Segmented block className="segmented-grid min-w-0 flex-1" label="Price stance" value={stance} onChange={onStance} options={priceOptions} />
                {stance === "custom" ? (
                  <span className="input-wrap w-full sm:w-[150px] sm:flex-none">
                    <input
                      id={customId}
                      className="input input-mono !h-[30px] !pr-[52px]"
                      aria-label="Custom vol %"
                      value={customVolPct}
                      onChange={(e) => onCustomVol(e.target.value)}
                      placeholder="60.0"
                      inputMode="decimal"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <span className="input-unit tag tag-outline !h-[20px] bg-bg !text-[11px]">% vol</span>
                  </span>
                ) : null}
              </div>
            }
            meta={
              <>
                anchor <M>{trailingText}</M> · {markup === null ? "custom" : <M>+{markup}%</M>} · opens{" "}
                <M>{usd2(d.bidPerUnit)}</M> / <M>{usd2(d.askPerUnit)}</M> USDC · sells out at <M>{fmtVolPct(d.askAtSellOut)}%</M> · avg{" "}
                <M>{fmtVolPct(be)}%</M>
              </>
            }
          />
        </div>
      </section>

      <section className="card !p-0" aria-label="Payoff">
        <div className="flex h-10 items-center justify-between gap-3 px-4 hairline-b">
          <span className="text-[14px] font-medium">Payoff</span>
          <span className="meta">
            <M>{units}</M> units · USDC
          </span>
        </div>
        <div className="px-4 pt-3">
          <div className="flex items-baseline justify-between">
            <span className="micro">Payout</span>
            <span className="micro">Realized vol →</span>
          </div>
          <PayoffChart unitNotional={p.unitNotional} capVariance={p.capVariance} breakEvenVariance={be} units={p.maxUnits} premiumUsdc={prem} height={200} />
        </div>
        <div className="px-4 pb-1 pt-2">
          <table className="sc">
            <thead>
              <tr>
                <th>Scenario</th>
                <th className="num">
                  <span className="inline-flex items-center gap-1.5">
                    Payout <InfoGlyph tip="What holders redeem for: units × 100 USDC × realized variance, never above the cap. Your vault reserves this at the cap the moment a unit sells." />
                  </span>
                </th>
                <th className="num">
                  <span className="inline-flex items-center gap-1.5">
                    Premium taken <InfoGlyph tip="Premium collected if the whole inventory sells at the ask, before any buyer hits your bid. Every fill lands in your vault, not your wallet." />
                  </span>
                </th>
                <th className="num">
                  <span className="inline-flex items-center gap-1.5">
                    Net <InfoGlyph tip="Premium kept minus payout." />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {scenarios.map((r) => (
                <tr key={r.k}>
                  <td>
                    <span className="font-medium">{r.k}</span> <span className="text-ink-3">· </span>
                    <span className="mono-num">{r.sub}</span>
                  </td>
                  <td className="num">{usd2(r.payout)}</td>
                  <td className="num">{usd2(prem)}</td>
                  <td className={cx("num", r.net > 0n ? "text-up" : r.net < 0n ? "text-down" : "text-ink-2")}>{signed(r.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
