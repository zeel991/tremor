"use client";

import { useMemo, useState } from "react";
import { fmtPriceUsdc, fmtUsdc } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import {
  GROUP_STATUS_LABEL,
  SIDE_LABEL,
  askFor,
  bidFor,
  groupCanBuy,
  groupCanExit,
  groupCanRedeem,
  groupNeedsWorthlessBurn,
  groupStatus,
  groupSymbol,
  ppuFor,
  type GroupState,
  type Side,
} from "@/lib/portfolio";
import { Segmented } from "@/components/ui/Segmented";
import { BuyGroupTicket, ExitGroupTicket, RedeemGroupTicket } from "./GroupTickets";
import { GroupOracleTicket } from "./GroupOracleTicket";

type TicketKind = "buy" | "exit" | "redeem" | "oracle";

const KIND_LABEL: Record<TicketKind, string> = { buy: "Buy", exit: "Exit", redeem: "Redeem", oracle: "Oracle" };

const FOOTNOTE: Record<TicketKind, string> = {
  buy: "USDC in, one side's receipts out at the writer's fixed ask. Every unit sold reserves collateral at the shared cap.",
  exit: "Receipts in, USDC out at the writer's fixed bid, before expiry — paid from released reserve plus the exit buffer.",
  redeem: "Receipts in, USDC out at the payout fixed at finalization. HIGH and CALM together always pay the full cap.",
  oracle: "Anyone can walk the observation window forward and finalize it. No key is privileged.",
};

function kindsFor(g: GroupState, now: number): TicketKind[] {
  const kinds: TicketKind[] = [];
  if (now === 0) return ["buy"];
  if (groupCanBuy(g, now)) kinds.push("buy");
  if (groupCanExit(g, "high", now) || groupCanExit(g, "calm", now)) kinds.push("exit");
  if (
    groupCanRedeem(g, "high") ||
    groupCanRedeem(g, "calm") ||
    groupNeedsWorthlessBurn(g, "high") ||
    groupNeedsWorthlessBurn(g, "calm")
  )
    kinds.push("redeem");
  if (!g.finalized && now >= g.params.saleEnd) kinds.push("oracle");
  if (kinds.length === 0) kinds.push(g.finalized ? "redeem" : "buy");
  return kinds;
}

/** Sticky inverted rail: side toggle (HIGH / CALM), lifecycle-aware ticket tabs, the active ticket. */
export function GroupTradeRail({ g }: { g: GroupState }) {
  const now = useNow(30_000);
  const kinds = useMemo(() => kindsFor(g, now), [g, now]);
  const [chosenKind, setChosenKind] = useState<TicketKind | undefined>();
  const [side, setSide] = useState<Side>("high");
  const kind: TicketKind = chosenKind && kinds.includes(chosenKind) ? chosenKind : kinds[0];

  return (
    <aside className="trade-rail panel flex flex-col gap-4 p-4 xl:sticky xl:top-[88px]" aria-label="Paired market ticket">
      <div className="flex items-center justify-between border-b border-white/10 pb-3">
        <span className="micro">Order entry</span>
        <span className="trade-live">
          <i aria-hidden="true" /> {now > 0 ? GROUP_STATUS_LABEL[groupStatus(g, now)] : "…"}
        </span>
      </div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[18px] font-medium leading-6">{groupSymbol(g)}</div>
          <span className="bracket bracket-light mono mt-1 inline-block">#{g.id.toString()}</span>
        </div>
        <div className="text-right">
          <div className="label">Cap payout / unit</div>
          <div className="text-[22px] font-normal leading-7 tnum">{fmtUsdc(g.params.capPayoutPerUnit)}</div>
        </div>
      </div>
      <Segmented
        dark
        block
        label="Side"
        value={side}
        onChange={setSide}
        options={(["high", "calm"] as Side[]).map((v) => ({
          value: v,
          label: `${SIDE_LABEL[v]} ($${fmtPriceUsdc(g.finalized ? ppuFor(g, v) : askFor(g, v))})`,
        }))}
      />
      {kinds.length > 1 ? (
        <Segmented
          dark
          block
          label="Ticket"
          value={kind}
          onChange={setChosenKind}
          options={kinds.map((v) => ({ value: v, label: KIND_LABEL[v] }))}
        />
      ) : null}
      {g.finalized ? (
        <div className="border border-lime/30 bg-lime/10 p-3">
          <div className="text-[11px] uppercase tracking-wider text-lime font-medium">Final Settlement Price</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-[20px] font-mono font-medium text-white">
              ${fmtPriceUsdc(ppuFor(g, side))} <small className="text-[12px] text-white/60">USDC / unit</small>
            </span>
            <span className="text-[12px] font-mono text-lime">
              {side === "high" ? `${(Number(g.xWad) / 1e16).toFixed(2)}% of cap` : `${(100 - Number(g.xWad) / 1e16).toFixed(2)}% of cap`}
            </span>
          </div>
        </div>
      ) : (
        <dl className="trade-quote-strip">
          <div>
            <dt>{SIDE_LABEL[side]} bid / unit</dt>
            <dd>${fmtPriceUsdc(bidFor(g, side))} USDC</dd>
          </div>
          <div>
            <dt>{SIDE_LABEL[side]} ask / unit</dt>
            <dd>${fmtPriceUsdc(askFor(g, side))} USDC</dd>
          </div>
        </dl>
      )}
      <p className="m-0 text-[12px] leading-4 text-white/45">
        {g.finalized
          ? "Market finalized: payouts are fixed by on-chain realized variance. Redeem or burn receipts."
          : "Fixed bid/ask quotes set by the writer — not a fair-value volatility model."}
      </p>
      {kind === "buy" ? (
        <BuyGroupTicket g={g} side={side} />
      ) : kind === "exit" ? (
        <ExitGroupTicket g={g} side={side} />
      ) : kind === "redeem" ? (
        <RedeemGroupTicket g={g} side={side} />
      ) : (
        <GroupOracleTicket g={g} />
      )}
      <p className="m-0 text-[12px] leading-4 text-white/45">{FOOTNOTE[kind]}</p>
    </aside>
  );
}
