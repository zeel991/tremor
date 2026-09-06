import { fmtAllowance, fmtUsdc, isUnlimitedAllowance } from "@/lib/format";
import { maxLiabilityFor, type SeriesState } from "@/lib/series";
import { Card } from "@/components/ui/Card";
import { Tag } from "@/components/ui/Tag";
import { AllocBar } from "@/components/ui/Hatch";

function Bar({
  label,
  value,
  required,
  tone,
}: {
  label: string;
  value: bigint;
  required: bigint;
  tone: "lime" | "ink" | "up";
}) {
  const unlimited = isUnlimitedAllowance(value);
  const pct = unlimited || required === 0n ? 100 : Math.min(100, Number((value * 10_000n) / required) / 100);
  return (
    <div>
      <AllocBar pct={pct} tone={tone} label={label} />
      <div className="mt-1.5 flex items-baseline justify-between gap-3">
        <span className="label inline-flex items-center gap-1.5">
          <span className={`sdot ${tone === "lime" ? "text-lime" : tone === "ink" ? "text-ink" : "text-up"}`} />
          {label}
        </span>
        <span className="text-[13px] tnum" title={unlimited ? value.toString() : undefined}>
          {fmtAllowance(value)} · {pct.toFixed(0)}%
        </span>
      </div>
    </div>
  );
}

/**
 * The writer's locked collateral, as an enforceable fact rather than an observation.
 *
 * v1 showed a "coverage ratio" built from the seller's wallet balance and their Aqua allowance —
 * both of which the seller could change at any moment, which made the number a snapshot of intent
 * rather than a guarantee. Here the collateral is inside a vault whose owner cannot withdraw what is
 * reserved, cannot reduce the Aqua allowance, and cannot dock the legs that pay holders out, so the
 * three bars below are the three things that actually have to be true.
 */
export function CollateralCard({ s }: { s: SeriesState }) {
  const v = s.vaultState;
  const legsLive = s.unitsOutstanding === 0n || s.legs.exitLegActive || s.legs.settleLegActive;
  const ok = s.fullyCollateralized;
  const capExposure = maxLiabilityFor(s.unitsOutstanding, s.params);
  return (
    <Card
      title="Locked collateral"
      meta="Held by the writer's vault, reserved per sold unit"
      action={<Tag tone={ok ? "up" : "down"}>{ok ? "Fully collateralized" : "Check the vault"}</Tag>}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[16px] font-medium">Reserved for outstanding receipts</span>
        <span className="text-[24px] font-normal tnum">{fmtUsdc(s.lockedLiability, 0)} USDC</span>
      </div>
      <div className="mt-4 flex flex-col gap-4">
        <Bar label="Vault balance against the reservation" value={v.balance} required={s.lockedLiability} tone="lime" />
        <Bar label="Aqua allowance against the reservation" value={v.aquaAllowance} required={s.lockedLiability} tone="ink" />
        <Bar
          label="Reservation against the maximum payout"
          value={s.lockedLiability}
          required={capExposure}
          tone="up"
        />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="label">Vault free</dt>
          <dd className="tnum">{fmtUsdc(v.free)} USDC</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="label">Max payout per unit</dt>
          <dd className="tnum">{fmtUsdc(s.quote.maxPayoutPerUnit)} USDC</dd>
        </div>
      </dl>
      <p className="mt-4 text-[12px] text-ink-3">
        {ok
          ? "The vault holds every dollar it has reserved, Aqua can still move it, and a burn leg is still shipped. The writer can withdraw only the free balance."
          : legsLive
            ? "This vault does not currently satisfy all three conditions. Check its balance, its Aqua allowance and its shipped strategies before buying."
            : "Both burn legs have been docked, which only happens after a series closes with nothing outstanding."}
      </p>
    </Card>
  );
}
