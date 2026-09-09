"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useApiOnline, useLvr, useTrailing } from "@/lib/api";
import { useQuoteIssueExactOut } from "@/lib/chain";
import { isDeployed } from "@/lib/contracts";
import { fmtDate, fmtUnits, fmtUsd, fmtUsdc, fmtVolPct, tryParseDecimal, USDC_DECIMALS, varianceFromVolPct, volPctNumber, WAD, YEAR_SECONDS } from "@/lib/format";
import { useSeriesList } from "@/lib/hooks";
import { canBuy, marketVolPct, receiptSymbol, type SeriesState } from "@/lib/series";
import { Card, LineItems } from "@/components/ui/Card";
import { AmountInput, SelectInput } from "@/components/ui/AmountInput";
import { StatusTag } from "@/components/ui/Tag";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { LinkButton } from "@/components/ui/Button";
import { AllocBar } from "@/components/ui/Hatch";

type Source = "1d" | "7d" | "30d" | "custom";
const TONES = ["lime", "ink", "up"] as const;

function HedgeRow({ s, units, poolUsdc }: { s: SeriesState; units: bigint; poolUsdc: bigint }) {
  const quote = useQuoteIssueExactOut(s.id, units > 0n ? units : null);
  const premium = quote.data?.premium;
  const filled = quote.data?.filledUnits;
  const unitsStr = fmtUnits(units, 6).replace(/,/g, "");
  const costPct = premium !== undefined && poolUsdc > 0n ? Number((premium * 10_000n) / poolUsdc) / 100 : undefined;
  return (
    <tr>
      <td>
        <Link href={`/series/${s.id.toString()}`} className="font-medium hover:underline">
          {receiptSymbol(s)}
        </Link>
        <span className="mono block text-[11px] text-ink-3">
          #{s.id.toString()} · expires {fmtDate(s.params.expiry)}
        </span>
      </td>
      <td>
        <StatusTag status={s.status} issuanceOpen={s.legs.issuanceOpen} compact />
      </td>
      <td className="num">{marketVolPct(s)}%</td>
      <td className="num font-medium">{fmtUnits(units, 4)}</td>
      <td className="num">
        {premium !== undefined ? (
          <>
            {fmtUsdc(premium)} USDC
            {costPct !== undefined ? <span className="block text-[11px] text-ink-3">{costPct.toFixed(2)}% of pool</span> : null}
            {filled !== undefined && filled < units ? (
              <span className="block text-[11px] text-down">market fills {fmtUnits(filled, 2)}</span>
            ) : null}
          </>
        ) : quote.isFetching ? (
          "…"
        ) : units > s.unitsAvailable ? (
          <span className="text-down">only {fmtUnits(s.unitsAvailable, 2)} left</span>
        ) : (
          "—"
        )}
      </td>
      <td className="num">
        <LinkButton href={`/series/${s.id.toString()}?units=${unitsStr}`} size="sm" variant={canBuy(s) ? "primary" : "tertiary"}>
          Buy
        </LinkButton>
      </td>
    </tr>
  );
}

export function HedgeCalculator() {
  const [poolValue, setPoolValue] = useState("100000");
  const [horizonDays, setHorizonDays] = useState("7");
  const [source, setSource] = useState<Source>("7d");
  const [customVol, setCustomVol] = useState("60");
  const apiOnline = useApiOnline();
  const trailing = useTrailing(source === "custom" ? "7d" : source);
  const { data: series, isLoading } = useSeriesList();

  const poolUsdc = tryParseDecimal(poolValue, USDC_DECIMALS) ?? 0n;
  const days = Number(horizonDays);
  const horizonSec = Number.isFinite(days) && days > 0 ? Math.round(days * 86_400) : 0;

  const variance: bigint | null = useMemo(() => {
    if (source === "custom") {
      try {
        return customVol.trim() ? varianceFromVolPct(customVol) : null;
      } catch {
        return null;
      }
    }
    return trailing.data?.rv ?? null;
  }, [source, customVol, trailing.data]);

  // E[LVR] = V·σ²·T/8  (USDC 6 dec, exact bigint)
  const expectedLvr = variance !== null && horizonSec > 0 ? (poolUsdc * variance * BigInt(horizonSec)) / (8n * YEAR_SECONDS * WAD) : null;
  const hedgeNotional = horizonSec > 0 ? (poolUsdc * BigInt(horizonSec)) / (8n * YEAR_SECONDS) : null;
  // units = (V·T/8) / unitNotional, per series
  const unitsFor = (s: SeriesState): bigint =>
    s.params.unitNotional === 0n ? 0n : (poolUsdc * BigInt(horizonSec) * WAD) / (8n * YEAR_SECONDS * s.params.unitNotional);

  const live = (series ?? []).filter((s) => canBuy(s));
  const lvrApi = useLvr(Number(poolValue.replace(/,/g, "")) || 0, days || 0, source === "custom" ? "7d" : source, apiOnline === true);
  const volPct = variance !== null ? volPctNumber(variance) : undefined;

  return (
    <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)] xl:items-start">
      <div className="flex flex-col gap-6">
        <Card title="Your position" meta="Constant-product LP">
          <div className="flex flex-col gap-4">
            <AmountInput label="Pool value" value={poolValue} onChange={setPoolValue} unit="USD" hint="Value of the position you want to hedge" />
            <AmountInput label="Horizon" value={horizonDays} onChange={setHorizonDays} unit="days" inputMode="numeric" />
            <SelectInput
              label="Vol source"
              value={source}
              onChange={setSource}
              options={[
                { value: "1d", label: "Trailing 1d realized" },
                { value: "7d", label: "Trailing 7d realized" },
                { value: "30d", label: "Trailing 30d realized" },
                { value: "custom", label: "Custom vol" },
              ]}
              hint={
                source !== "custom"
                  ? trailing.data
                    ? `σ = ${fmtVolPct(trailing.data.rv)}% from ${trailing.data.samples} Chainlink samples`
                    : trailing.isError
                      ? "API offline — pick custom"
                      : "loading…"
                  : undefined
              }
            />
            {source === "custom" ? <AmountInput label="Annualized vol" value={customVol} onChange={setCustomVol} unit="% vol" /> : null}
          </div>
        </Card>
        <Card title="Why this works" tone="bg2">
          <p className="body !text-[14px] !leading-5">
            Loss-versus-rebalancing for a constant-product LP is proportional to realized variance: <span className="mono text-ink">E[LVR] ≈ V·σ²·T/8</span>. A
            Tremor receipt pays <span className="mono text-ink">unitNotional·σ²</span>, so <span className="mono text-ink">(V·T/8) / unitNotional</span> units
            estimate the gross variance notional. This is not an exact hedge: the premium is a real cost, the payout is capped, and fees, expiry mismatch and Chainlink-versus-pool basis all move the result. Sold units are fully collateralized, so writer default is not among the risks.
          </p>
          {lvrApi.data ? (
            <LineItems
              className="mt-3"
              items={[
                { label: "Backend σ", value: `${(lvrApi.data.sigma * 100).toFixed(1)}%`, muted: true },
                { label: "Backend E[LVR]", value: fmtUsd(lvrApi.data.expectedLvrUsd), muted: true },
              ]}
            />
          ) : null}
        </Card>
      </div>

      <div className="flex flex-col gap-6">
        {/* allocation-style result card */}
        <Card title="Gross hedge estimate" meta={`${days || 0} day${days === 1 ? "" : "s"} · ${source === "custom" ? "custom vol" : `trailing ${source}`} · before premium and basis risk`}>
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-[16px] font-medium">Modelled gross LVR</span>
            <span className="num-lg">{expectedLvr !== null ? `$ ${fmtUsdc(expectedLvr)}` : "—"}</span>
          </div>
          <div className="mt-5 flex flex-col gap-3">
            <AllocBar pct={volPct !== undefined ? Math.min(100, volPct) : 0} tone="lime" label="Vol used" />
            {live.slice(0, 3).map((s, i) => {
              const u = unitsFor(s);
              const cap = s.unitsAvailable > 0n ? Math.min(100, Number((u * 10_000n) / s.unitsAvailable) / 100) : 0;
              return <AllocBar key={s.id.toString()} pct={cap} tone={TONES[(i + 1) % TONES.length]} label={`${receiptSymbol(s)} capacity used`} />;
            })}
          </div>
          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
            <span className="label inline-flex items-center gap-1.5">
              <span className="sdot text-lime" />
              Vol used <span className="text-ink tnum">{volPct !== undefined ? `${volPct.toFixed(1)}%` : "—"}</span>
            </span>
            {live.slice(0, 3).map((s, i) => {
              const u = unitsFor(s);
              const cap = s.unitsAvailable > 0n ? Math.min(100, Number((u * 10_000n) / s.unitsAvailable) / 100) : 0;
              const tone = TONES[(i + 1) % TONES.length];
              return (
                <span key={s.id.toString()} className="label inline-flex items-center gap-1.5">
                  <span className={`sdot ${tone === "lime" ? "text-lime" : tone === "ink" ? "text-ink" : "text-up"}`} />
                  {receiptSymbol(s)} <span className="text-ink tnum">{cap.toFixed(0)}% of supply</span>
                </span>
              );
            })}
          </div>
          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            <div className="border border-line p-3">
              <div className="label">Vol used</div>
              <div className="mt-1 text-[18px] font-medium tnum">{variance !== null ? `${fmtVolPct(variance)}%` : "—"}</div>
            </div>
            <div className="border border-line p-3">
              <div className="label">Hedge notional (V·T/8)</div>
              <div className="mt-1 text-[18px] font-medium tnum">{hedgeNotional !== null ? `$ ${fmtUsdc(hedgeNotional)}` : "—"}</div>
              <div className="text-[11px] text-ink-3">USD per 1.0 of variance</div>
            </div>
          </div>
        </Card>

        <Card title="Units per live series" meta="Cost is the on-chain integral quote for your exact size, price impact included" flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Series</th>
                  <th>Status</th>
                  <th className="num">Market vol</th>
                  <th className="num">Hedge units</th>
                  <th className="num">Cost (Lens quote)</th>
                  <th className="num"></th>
                </tr>
              </thead>
              {isLoading ? (
                <SkeletonRows rows={2} cols={6} />
              ) : (
                <tbody>
                  {live.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ height: "auto" }}>
                        <EmptyState>{isDeployed ? "No series open for sale right now." : "Contracts not deployed on this chain."}</EmptyState>
                      </td>
                    </tr>
                  ) : (
                    live.map((s) => <HedgeRow key={s.id.toString()} s={s} units={unitsFor(s)} poolUsdc={poolUsdc} />)
                  )}
                </tbody>
              )}
            </table>
          </div>
          <p className="px-6 py-4 text-[13px] leading-5 text-ink-2">Estimate only. Protection is capped and may diverge from pool LVR because of premium cost, fees, expiry mismatch and oracle basis. Below the cap the payout tracks the V·σ²·T/8 estimate by construction, so the residual is essentially the premium; at the cap it under-pays precisely where the bill is largest.</p>
        </Card>
      </div>
    </div>
  );
}
