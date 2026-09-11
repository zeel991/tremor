"use client";

import { useMemo } from "react";
import { fmtPriceUsdc, fmtUnits, fmtVolPct, fmtWad, minBig, WAD } from "@/lib/format";
import { type GroupState, groupStatus, GroupStatus } from "@/lib/portfolio";
import { useGroupRealized } from "@/lib/portfolio-chain";
import { useNow } from "@/lib/hooks";
import { Card } from "@/components/ui/Card";
import { Tag } from "@/components/ui/Tag";

export function LivePairPricingCard({ g }: { g: GroupState }) {
  const now = useNow(30_000);
  const status = groupStatus(g, now || g.params.start);
  const isFinal = g.finalized;
  const isLive = !isFinal && status === GroupStatus.Open;

  const realized = useGroupRealized(g.id);
  const currentVariance = isFinal ? g.finalVariance : realized.data?.variance ?? 0n;

  // Compute indicative payouts if not finalized yet
  const { highIndicativePpu, calmIndicativePpu, currentXWad } = useMemo(() => {
    if (isFinal) {
      return {
        highIndicativePpu: g.highPpu,
        calmIndicativePpu: g.calmPpu,
        currentXWad: g.xWad,
      };
    }
    const cap = g.params.capVariance;
    const x = cap > 0n ? minBig((currentVariance * WAD) / cap, WAD) : 0n;
    const S = g.params.capPayoutPerUnit;
    const hp = (S * x) / WAD;
    const cp = S - hp;
    return {
      highIndicativePpu: hp,
      calmIndicativePpu: cp,
      currentXWad: x,
    };
  }, [isFinal, g, currentVariance]);

  const p = g.params;
  const spreadHigh = p.askHigh > p.bidHigh ? p.askHigh - p.bidHigh : 0n;
  const spreadCalm = p.askCalm > p.bidCalm ? p.askCalm - p.bidCalm : 0n;

  const highPct = Number(currentXWad) / 1e16; // e.g. 0.04%
  const calmPct = Math.max(0, 100 - highPct);

  return (
    <Card
      title="Live HIGH & CALM Pricing"
      meta={
        isFinal
          ? "Finalized settlement prices · exact on-chain payouts"
          : isLive
            ? "Live trading quotes & trailing variance"
            : "Window observation & checkpoint tracking"
      }
    >
      <div className="flex flex-col gap-5">
        {/* Comparison grid */}
        <div className="grid gap-4 md:grid-cols-2">
          {/* HIGH SIDE */}
          <div className="flex flex-col justify-between border-2 border-lime-dark/30 bg-bg-2 p-4 transition-all">
            <div>
              <div className="flex items-center justify-between gap-2 border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center bg-lime text-[11px] font-bold text-ink">
                    H
                  </span>
                  <span className="font-semibold text-ink tracking-wide">HIGH Side</span>
                </div>
                <Tag tone="lime">{isFinal ? "Settled" : "High Volatility"}</Tag>
              </div>

              <div className="mt-4">
                <span className="text-[12px] uppercase tracking-wider text-ink-3">
                  {isFinal ? "Final Settlement Price" : "Current Executable Ask"}
                </span>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-[28px] font-mono font-medium tracking-tight text-ink">
                    ${isFinal ? fmtPriceUsdc(g.highPpu) : fmtPriceUsdc(p.askHigh)}
                  </span>
                  <span className="text-[13px] text-ink-2 font-mono">USDC / unit</span>
                </div>
                <span className="text-[11px] text-ink-3">
                  {isFinal
                    ? "Redemption pays this exact value per unit"
                    : `Fixed ask to buy · bid is $${fmtPriceUsdc(p.bidHigh)} USDC`}
                </span>
              </div>

              <div className="mt-4 divide-y divide-line border-t border-line text-[13px]">
                <div className="flex items-center justify-between py-2">
                  <span className="text-ink-2">Buy Ask (Cost to enter)</span>
                  <span className="font-mono text-ink">
                    {isFinal ? <span className="text-ink-3">Closed</span> : `$${fmtPriceUsdc(p.askHigh)} USDC`}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-ink-2">Exit Bid (Proceeds to sell)</span>
                  <span className="font-mono text-ink">
                    {isFinal ? <span className="text-ink-3">Closed</span> : `$${fmtPriceUsdc(p.bidHigh)} USDC`}
                  </span>
                </div>
                {!isFinal && (
                  <div className="flex items-center justify-between py-2">
                    <span className="text-ink-2">Spread</span>
                    <span className="font-mono text-ink-2">${fmtPriceUsdc(spreadHigh)} USDC</span>
                  </div>
                )}
                <div className="flex items-center justify-between py-2">
                  <span className="text-ink-2">{isFinal ? "Final Payout" : "Indicative Payout"}</span>
                  <span className="font-mono font-medium text-ink">
                    ${fmtPriceUsdc(highIndicativePpu)} USDC
                  </span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-ink-2">Outstanding in Market</span>
                  <span className="font-mono text-ink">{fmtUnits(g.highOutstanding, 2)} units</span>
                </div>
              </div>
            </div>

            <div className="mt-3 bg-bg-3 p-2 text-[11px] text-ink-2">
              Formula: <span className="font-mono font-medium text-ink">S · x</span> = {fmtPriceUsdc(p.capPayoutPerUnit)} × {fmtWad(currentXWad, 4)}
            </div>
          </div>

          {/* CALM SIDE */}
          <div className="flex flex-col justify-between border border-line-2 bg-bg-2 p-4 transition-all">
            <div>
              <div className="flex items-center justify-between gap-2 border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center bg-ink text-[11px] font-bold text-white">
                    C
                  </span>
                  <span className="font-semibold text-ink tracking-wide">CALM Side</span>
                </div>
                <Tag tone="outline">{isFinal ? "Settled" : "Low Volatility"}</Tag>
              </div>

              <div className="mt-4">
                <span className="text-[12px] uppercase tracking-wider text-ink-3">
                  {isFinal ? "Final Settlement Price" : "Current Executable Ask"}
                </span>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-[28px] font-mono font-medium tracking-tight text-ink">
                    ${isFinal ? fmtPriceUsdc(g.calmPpu) : fmtPriceUsdc(p.askCalm)}
                  </span>
                  <span className="text-[13px] text-ink-2 font-mono">USDC / unit</span>
                </div>
                <span className="text-[11px] text-ink-3">
                  {isFinal
                    ? "Redemption pays this exact value per unit"
                    : `Fixed ask to buy · bid is $${fmtPriceUsdc(p.bidCalm)} USDC`}
                </span>
              </div>

              <div className="mt-4 divide-y divide-line border-t border-line text-[13px]">
                <div className="flex items-center justify-between py-2">
                  <span className="text-ink-2">Buy Ask (Cost to enter)</span>
                  <span className="font-mono text-ink">
                    {isFinal ? <span className="text-ink-3">Closed</span> : `$${fmtPriceUsdc(p.askCalm)} USDC`}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-ink-2">Exit Bid (Proceeds to sell)</span>
                  <span className="font-mono text-ink">
                    {isFinal ? <span className="text-ink-3">Closed</span> : `$${fmtPriceUsdc(p.bidCalm)} USDC`}
                  </span>
                </div>
                {!isFinal && (
                  <div className="flex items-center justify-between py-2">
                    <span className="text-ink-2">Spread</span>
                    <span className="font-mono text-ink-2">${fmtPriceUsdc(spreadCalm)} USDC</span>
                  </div>
                )}
                <div className="flex items-center justify-between py-2">
                  <span className="text-ink-2">{isFinal ? "Final Payout" : "Indicative Payout"}</span>
                  <span className="font-mono font-medium text-ink">
                    ${fmtPriceUsdc(calmIndicativePpu)} USDC
                  </span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-ink-2">Outstanding in Market</span>
                  <span className="font-mono text-ink">{fmtUnits(g.calmOutstanding, 2)} units</span>
                </div>
              </div>
            </div>

            <div className="mt-3 bg-bg-3 p-2 text-[11px] text-ink-2">
              Formula: <span className="font-mono font-medium text-ink">S · (1 − x)</span> = {fmtPriceUsdc(p.capPayoutPerUnit)} × (1 − {fmtWad(currentXWad, 4)})
            </div>
          </div>
        </div>

        {/* Invariant Split Bar */}
        <div className="border border-line bg-bg-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
            <span className="text-ink">
              Payout Invariant: <b>HIGH + CALM = Cap ({fmtPriceUsdc(p.capPayoutPerUnit)} USDC)</b>
            </span>
            <span className="font-mono text-ink-3 text-[12px]">
              ${fmtPriceUsdc(highIndicativePpu)} + ${fmtPriceUsdc(calmIndicativePpu)} = ${fmtPriceUsdc(p.capPayoutPerUnit)} USDC
            </span>
          </div>

          <div className="mt-2 flex h-3 w-full overflow-hidden bg-bg-3 border border-line">
            <div
              className="bg-lime transition-all"
              style={{ width: `${Math.max(1, Math.min(99, highPct))}%` }}
              title={`HIGH: ${highPct.toFixed(2)}%`}
            />
            <div
              className="bg-ink-3/40 transition-all"
              style={{ width: `${Math.max(1, Math.min(99, calmPct))}%` }}
              title={`CALM: ${calmPct.toFixed(2)}%`}
            />
          </div>

          <div className="mt-2 flex items-center justify-between text-[11px] font-mono text-ink-2">
            <span className="font-semibold text-lime-dark">HIGH {highPct.toFixed(2)}% (${fmtPriceUsdc(highIndicativePpu)} / unit)</span>
            <span>CALM {calmPct.toFixed(2)}% (${fmtPriceUsdc(calmIndicativePpu)} / unit)</span>
          </div>

          <p className="m-0 mt-3 text-[12px] leading-relaxed text-ink-3">
            {isFinal
              ? `Because ETH realized vol was ${fmtVolPct(g.finalVariance)}% vs the ${fmtVolPct(p.capVariance)}% cap (x = ${fmtWad(g.xWad, 4)}), HIGH finalized at $${fmtPriceUsdc(g.highPpu)} USDC and CALM captured $${fmtPriceUsdc(g.calmPpu)} USDC. Together they always equal exactly $${fmtPriceUsdc(p.capPayoutPerUnit)} USDC with zero stranded dust.`
              : `Current realized vol is ${fmtVolPct(currentVariance)}% against the ${fmtVolPct(p.capVariance)}% cap. Indicative payout updates with each oracle checkpoint.`}
          </p>
        </div>
      </div>
    </Card>
  );
}
