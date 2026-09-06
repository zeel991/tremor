"use client";

import { useMemo, useState } from "react";
import { fmtUsdc, fmtVolPct } from "@/lib/format";
import {
  canBuy,
  canExit,
  canRedeem,
  needsCheckpoint,
  needsFinalize,
  needsWorthlessBurn,
  receiptSymbol,
  Status,
  type SeriesState,
} from "@/lib/series";
import { StatusTag } from "@/components/ui/Tag";
import { Segmented } from "@/components/ui/Segmented";
import { BuyTicket } from "./BuyTicket";
import { ExitTicket } from "./ExitTicket";
import { RedeemTicket } from "./RedeemTicket";
import { OracleTicket } from "./OracleTicket";

type Side = "buy" | "exit" | "redeem" | "oracle";

const SIDE_LABEL: Record<Side, string> = {
  buy: "Buy",
  exit: "Exit",
  redeem: "Redeem",
  oracle: "Oracle",
};

const FOOTNOTE: Record<Side, string> = {
  buy: "USDC in, receipts out at the executable ask. Every unit sold reserves collateral in the writer's vault.",
  exit: "Receipts in, USDC out at the executable bid, before expiry. The receipts are burned.",
  redeem: "Receipts in, USDC out at the final realized variance. No deadline, and nothing needed from the writer.",
  oracle: "Anyone can walk the observation window forward and finalize it. No key is privileged.",
};

/**
 * The tabs a series offers depend on where it is in its life, not on taste.
 *
 * Before expiry there are two sides to the market. After expiry there is a window to finish
 * checkpointing and a variance to fix. Once that is done there is a redemption. Showing a Buy tab on
 * an expired series, or a Redeem tab on a live one, would be offering a button that can only revert.
 */
function sidesFor(s: SeriesState): Side[] {
  const sides: Side[] = [];
  if (s.status === Status.Upcoming || s.status === Status.Live) {
    if (s.legs.issuanceOpen || canBuy(s)) sides.push("buy");
    if (s.legs.exitOpen || canExit(s)) sides.push("exit");
  }
  if (canRedeem(s) || needsWorthlessBurn(s)) sides.push("redeem");
  if (needsCheckpoint(s) || needsFinalize(s) || s.status === Status.ExpiredUnfinalized) sides.push("oracle");
  if (sides.length === 0) sides.push(s.status === Status.Live ? "buy" : "redeem");
  return sides;
}

/** Sticky inverted rail: header, the lifecycle-aware tabs, the active ticket. */
export function TradeRail({
  s,
  indexedEntry,
  onUnitsChange,
}: {
  s: SeriesState;
  indexedEntry?: bigint;
  onUnitsChange?: (units: bigint, premium: bigint) => void;
}) {
  const sides = useMemo(() => sidesFor(s), [s]);
  const [chosen, setChosen] = useState<Side | undefined>();
  const side: Side = chosen && sides.includes(chosen) ? chosen : sides[0];

  return (
    <aside className="trade-rail panel flex flex-col gap-4 p-4 xl:sticky xl:top-[88px]" aria-label="Trade ticket">
      <div className="flex items-center justify-between border-b border-white/10 pb-3">
        <span className="micro">Order entry</span>
        <span className="trade-live">
          <i aria-hidden="true" /> {s.oracle.checkpointsCurrent ? "Live quote" : "Quote stale"}
        </span>
      </div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[18px] font-medium leading-6">{receiptSymbol(s)}</div>
          <div className="mt-1 flex items-center gap-3">
            <StatusTag status={s.status} issuanceOpen={s.legs.issuanceOpen} compact onDark />
            <span className="bracket bracket-light mono">#{s.id.toString()}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="label">Market vol</div>
          <div className="text-[22px] font-normal leading-7 tnum">{fmtVolPct(s.quote.projectedVariance)}%</div>
        </div>
      </div>
      {sides.length > 1 ? (
        <Segmented
          dark
          block
          label="Ticket side"
          value={side}
          onChange={setChosen}
          options={sides.map((v) => ({ value: v, label: SIDE_LABEL[v] }))}
        />
      ) : null}
      <dl className="trade-quote-strip">
        <div>
          <dt>Bid / unit</dt>
          <dd>{fmtUsdc(s.quote.bidPerUnit)} USDC</dd>
        </div>
        <div>
          <dt>Ask / unit</dt>
          <dd>{fmtUsdc(s.quote.askPerUnit)} USDC</dd>
        </div>
      </dl>
      {side === "buy" ? (
        <BuyTicket s={s} onUnitsChange={onUnitsChange} />
      ) : side === "exit" ? (
        <ExitTicket s={s} indexedEntry={indexedEntry} />
      ) : side === "redeem" ? (
        <RedeemTicket s={s} indexedEntry={indexedEntry} />
      ) : (
        <OracleTicket s={s} />
      )}
      <p className="m-0 text-[12px] leading-4 text-white/45">{FOOTNOTE[side]}</p>
    </aside>
  );
}
