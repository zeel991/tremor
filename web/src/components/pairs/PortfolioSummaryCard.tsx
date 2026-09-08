"use client";

import { useVaultBalances } from "@/lib/portfolio-chain";
import { fmtUnits, fmtUsdc } from "@/lib/format";
import { standaloneCapsFor, type GroupState } from "@/lib/portfolio";
import { Card } from "@/components/ui/Card";
import { Tag } from "@/components/ui/Tag";
import { AllocBar } from "@/components/ui/Hatch";

/**
 * The headline card: what this group actually locks versus what two separately backed series would.
 *
 * The comparison is honest by construction — `standaloneCaps` is a hypothetical ("if backed
 * separately"), never a description of simultaneous debt, because HIGH and CALM can never both pay
 * their cap: they sum to S at every outcome.
 */
export function PortfolioSummaryCard({ g }: { g: GroupState }) {
  const vault = useVaultBalances(g.vault);
  const standalone =
    g.standaloneCaps > 0n
      ? g.standaloneCaps
      : standaloneCapsFor(g.highOutstanding, g.calmOutstanding, g.params.capPayoutPerUnit);
  const saved = standalone > g.reserveLocked ? standalone - g.reserveLocked : 0n;
  const pct = standalone > 0n ? Number((g.reserveLocked * 10_000n) / standalone) / 100 : 0;
  const free = vault.data ? (vault.data.balance > vault.data.locked ? vault.data.balance - vault.data.locked : 0n) : undefined;
  const backed = vault.data !== undefined && vault.data.balance >= vault.data.locked;

  return (
    <Card
      title="Portfolio reserve"
      meta="One vault backs both sides at the worst case, not the sum of the caps"
      action={
        vault.data !== undefined ? (
          <Tag tone={backed ? "up" : "down"}>{backed ? "Vault holds the reserve" : "Check the vault"}</Tag>
        ) : undefined
      }
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[16px] font-medium">Required portfolio reserve</span>
        <span className="text-[24px] font-normal tnum">{fmtUsdc(g.reserveLocked, 0)} USDC</span>
      </div>
      <div className="mt-3">
        <AllocBar pct={pct} tone="lime" label="Portfolio reserve against the separately-backed baseline" />
        <div className="mt-1.5 flex items-baseline justify-between gap-3 text-[12px] text-ink-3">
          <span>Portfolio reserve</span>
          <span className="tnum">Sum of standalone caps (if backed separately): {fmtUsdc(standalone, 0)} USDC</span>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="label">Vault collateral</dt>
          <dd className="tnum">{vault.data !== undefined ? `${fmtUsdc(vault.data.balance)} USDC` : "unavailable"}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="label">Free collateral</dt>
          <dd className="tnum">{free !== undefined ? `${fmtUsdc(free)} USDC` : "unavailable"}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="label">HIGH outstanding</dt>
          <dd className="tnum">{fmtUnits(g.highOutstanding, 2)} units</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="label">CALM outstanding</dt>
          <dd className="tnum">{fmtUnits(g.calmOutstanding, 2)} units</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="label">Exit buffer</dt>
          <dd className="tnum">{fmtUsdc(g.exitBuffer)} USDC</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="label">Standalone caps (if backed separately)</dt>
          <dd className="tnum">{fmtUsdc(standalone, 0)} USDC</dd>
        </div>
      </dl>
      <p className="mt-4 text-[12px] text-ink-3">
        Two separately backed series with the same outstanding claims would lock{" "}
        <b className="tnum">{fmtUsdc(standalone, 0)} USDC</b>; this group locks{" "}
        <b className="tnum">{fmtUsdc(g.reserveLocked, 0)} USDC</b>
        {saved > 0n ? (
          <>
            {" "}
            — <b className="tnum">{fmtUsdc(saved, 0)} USDC</b> less, because HIGH and CALM sum to the same cap
            at every outcome and can never both pay it.
          </>
        ) : (
          <>. With only one side outstanding, the reserve equals that side&apos;s cap.</>
        )}{" "}
        The standalone figure is a baseline, not actual simultaneous debt.
      </p>
    </Card>
  );
}
