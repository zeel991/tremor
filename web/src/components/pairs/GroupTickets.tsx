"use client";

import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useTokenBalance } from "@/lib/chain";
import { useGroupQuote } from "@/lib/portfolio-chain";
import { isPortfolioDeployed, takerSpender } from "@/lib/contracts";
import { fmtDateTime, fmtPriceUsdc, fmtUnits, fmtUsdc, RECEIPT_DECIMALS, tryParseDecimal, WAD } from "@/lib/format";
import { useDebounced, useNow } from "@/lib/hooks";
import {
  SIDE_LABEL,
  askFor,
  bidFor,
  exitAvailability,
  groupCanBuy,
  groupCanExit,
  groupCanRedeem,
  groupNeedsWorthlessBurn,
  outstandingFor,
  ppuFor,
  receiptFor,
  sideIsHigh,
  type GroupState,
  type Side,
} from "@/lib/portfolio";
import {
  BUY_GROUP_PLAN,
  BURN_WORTHLESS_GROUP_PLAN,
  EXIT_GROUP_PLAN,
  REDEEM_GROUP_PLAN,
  runBurnWorthlessGroup,
  runBuyGroup,
  runExitGroup,
  runRedeemGroup,
  useTxFlow,
  type SwapResult,
} from "@/lib/tx";
import { DarkItems } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { TxProgress } from "@/components/tx/TxProgress";
import { TxHash } from "@/components/ui/Address";
import { TicketWidget } from "@/components/series/TicketWidget";

/** Shared bits: units input parsing, slippage, invalidation. */
function useUnitsInput() {
  const [amount, setAmount] = useState("");
  const debounced = useDebounced(amount, 300);
  const parsed = useMemo(
    () => (debounced.trim() === "" ? null : tryParseDecimal(debounced, RECEIPT_DECIMALS)),
    [debounced],
  );
  return { amount, setAmount, parsed, valid: parsed !== null && parsed > 0n };
}

function SlippageRow({ value, onChange }: { value: "50" | "100" | "200"; onChange: (v: "50" | "100" | "200") => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-white/50">Slippage · spender {takerSpender().slice(0, 6)}…</span>
      <Segmented
        dark
        label="Slippage"
        value={value}
        onChange={onChange}
        options={[
          { value: "50", label: "0.5%" },
          { value: "100", label: "1%" },
          { value: "200", label: "2%" },
        ]}
      />
    </div>
  );
}

/**
 * Buy one side of the pair, exact-out in units, at the writer's fixed ask.
 *
 * The number shown next to the button is a `router.quote` result — the same arithmetic the swap runs —
 * refreshed on an interval; the fixed ask is only a resting label. `runBuyGroup` re-quotes once more
 * immediately before signing.
 */
export function BuyGroupTicket({ g, side }: { g: GroupState; side: Side }) {
  const { address } = useAccount();
  const now = useNow(30_000);
  const toast = useToast();
  const qc = useQueryClient();
  const flow = useTxFlow<SwapResult>(BUY_GROUP_PLAN);
  const { amount, setAmount, parsed, valid } = useUnitsInput();
  const [slippage, setSlippage] = useState<"50" | "100" | "200">("100");
  const usdcBal = useTokenBalance(g.params.quoteToken, address);

  const open = now > 0 && groupCanBuy(g, now);
  const quote = useGroupQuote(g, "issue", side, false, valid ? parsed : null, open);
  const units = quote.data?.amountOut;
  const premium = quote.data?.amountIn;
  const partial = quote.data !== undefined && parsed !== null && quote.data.amountOut < parsed;
  const remaining = g.params.maxUnitsPerSide - outstandingFor(g, side);
  const insufficient = premium !== undefined && usdcBal.data !== undefined && usdcBal.data < premium;

  let blocker: string | undefined;
  if (!isPortfolioDeployed) blocker = "Contracts not deployed";
  else if (g.finalized) blocker = "Group finalized";
  else if (now > 0 && now >= g.params.saleEnd) blocker = "Sale closed";
  else if (now > 0 && now < g.params.start) blocker = "Sale not open yet";
  else if (remaining <= 0n) blocker = `${SIDE_LABEL[side]} side sold out`;
  else if (!address) blocker = "Connect a wallet to buy";
  else if (insufficient) blocker = "Insufficient USDC";
  const locked = !!blocker && blocker !== "Connect a wallet to buy" && blocker !== "Insufficient USDC";

  const submit = async () => {
    if (!valid || blocker) return;
    const res = await flow.run((ctx) =>
      runBuyGroup(ctx, { group: g, side, units: parsed as bigint, slippageBps: Number(slippage) }),
    );
    if (res) {
      const detail = res.amountOut !== undefined ? `${fmtUnits(res.amountOut)} ${SIDE_LABEL[side]} units for ${fmtUsdc(res.amountIn ?? 0n)} USDC` : undefined;
      toast.success(res.partial ? "Filled partially" : `${SIDE_LABEL[side]} bought`, detail);
      void qc.invalidateQueries({ queryKey: ["chain"] });
      setAmount("");
    } else if (flow.error) toast.error("Buy failed", flow.error);
  };

  return (
    <div className="flex flex-col gap-3">
      <TicketWidget
        top={{
          label: (
            <>
              Remaining <b>{fmtUnits(remaining > 0n ? remaining : 0n, 0)}</b> units this side
            </>
          ),
          value: amount,
          onChange: setAmount,
          onMax: remaining > 0n ? () => setAmount(fmtUnits(remaining, 18).replace(/,/g, "")) : undefined,
          unit: `${SIDE_LABEL[side]} units`,
          unitIcon: sideIsHigh(side) ? "σ²" : "1−x",
          disabled: locked,
          inputLabel: `${SIDE_LABEL[side]} units to buy`,
        }}
        bottom={{
          label: (
            <>
              Balance <b>{usdcBal.data !== undefined ? fmtUsdc(usdcBal.data) : address ? "…" : "—"}</b> USDC
            </>
          ),
          value: premium !== undefined ? fmtUsdc(premium) : quote.isFetching ? "…" : "0.00",
          unit: "USDC",
          unitIcon: "$",
          dim: premium === undefined,
        }}
      />
      {quote.error ? <p className="m-0 text-[12px] text-down">On-chain quote failed — check RPC or amount.</p> : null}
      {partial ? (
        <p className="m-0 text-[12px] text-white/60">
          The market can sell <b className="tnum">{fmtUnits(units ?? 0n, 4)}</b> {SIDE_LABEL[side]} units right
          now — this buy fills partially.
        </p>
      ) : null}
      <DarkItems
        items={[
          { label: "Writer's ask / unit", value: `$${fmtPriceUsdc(askFor(g, side))} USDC` },
          { label: "Premium (on-chain quote)", value: premium !== undefined ? `${fmtUsdc(premium)} USDC` : quote.isFetching ? "…" : "—" },
          { label: "Max payout / unit", value: `$${fmtPriceUsdc(g.params.capPayoutPerUnit)} USDC` },
          { label: "Sale closes", value: fmtDateTime(g.params.saleEnd) },
        ]}
      />
      <SlippageRow value={slippage} onChange={setSlippage} />
      <Button size="lg" className="w-full" disabled={!valid || !!blocker || flow.running || premium === undefined} loading={flow.running} onClick={submit}>
        {blocker ?? `Buy ${SIDE_LABEL[side]}`}
      </Button>
      {flow.steps.some((st) => st.phase !== "todo") ? <TxProgress dark steps={flow.steps} className="pt-1" /> : null}
      {flow.result ? (
        <p className="m-0 text-[12px] text-white/60">
          Done · <TxHash value={flow.result.hash} />
        </p>
      ) : null}
      <p className="m-0 text-[12px] leading-4 text-white/45">
        Fixed bid/ask quotes set by the writer — not a fair-value volatility model. Every unit sold reserves
        collateral in the writer&apos;s vault at the shared cap.
      </p>
    </div>
  );
}

/** Sell one side back at the writer's fixed bid, before expiry. Paid from released reserve + exit buffer. */
export function ExitGroupTicket({ g, side }: { g: GroupState; side: Side }) {
  const { address } = useAccount();
  const now = useNow(30_000);
  const toast = useToast();
  const qc = useQueryClient();
  const flow = useTxFlow<SwapResult>(EXIT_GROUP_PLAN);
  const { amount, setAmount, parsed, valid } = useUnitsInput();
  const [slippage, setSlippage] = useState<"50" | "100" | "200">("100");
  const bal = useTokenBalance(receiptFor(g, side), address);

  const open = now > 0 && !g.finalized && now < g.params.expiry;
  const quote = useGroupQuote(g, "exit", side, true, valid ? parsed : null, open);
  const proceeds = quote.data?.amountOut;
  const filled = quote.data?.amountIn;
  const partial = quote.data !== undefined && parsed !== null && quote.data.amountIn < parsed;
  const funding = valid ? exitAvailability(g, side, parsed as bigint) : undefined;
  const underfunded = funding !== undefined && funding.available < funding.needed;

  let blocker: string | undefined;
  if (!isPortfolioDeployed) blocker = "Contracts not deployed";
  else if (g.finalized) blocker = "Finalized — redeem instead";
  else if (now > 0 && now >= g.params.expiry) blocker = "Expired — finalize, then redeem";
  else if (now > 0 && !groupCanExit(g, side, now)) blocker = "Nothing outstanding on this side";
  else if (!address) blocker = "Connect a wallet to exit";
  else if (bal.data !== undefined && bal.data === 0n) blocker = `No ${SIDE_LABEL[side]} receipts held`;
  else if (parsed !== null && bal.data !== undefined && parsed > bal.data) blocker = "Exceeds your balance";
  const locked = !!blocker && blocker !== "Connect a wallet to exit" && blocker !== "Exceeds your balance";

  const submit = async () => {
    if (!valid || blocker) return;
    const res = await flow.run((ctx) =>
      runExitGroup(ctx, { group: g, side, units: parsed as bigint, slippageBps: Number(slippage) }),
    );
    if (res) {
      toast.success(
        res.partial ? "Exited partially" : "Position exited",
        res.amountOut !== undefined ? `Received ${fmtUsdc(res.amountOut)} USDC · receipts burned` : undefined,
      );
      void qc.invalidateQueries({ queryKey: ["chain"] });
      setAmount("");
    } else if (flow.error) toast.error("Exit failed", flow.error);
  };

  return (
    <div className="flex flex-col gap-3">
      <TicketWidget
        top={{
          label: (
            <>
              Balance <b>{bal.data !== undefined ? fmtUnits(bal.data, 4) : address ? "…" : "—"}</b> {SIDE_LABEL[side]} units
            </>
          ),
          value: amount,
          onChange: setAmount,
          onMax:
            bal.data !== undefined && bal.data > 0n
              ? () => setAmount(fmtUnits(bal.data as bigint, 18).replace(/,/g, ""))
              : undefined,
          unit: `${SIDE_LABEL[side]} units`,
          unitIcon: sideIsHigh(side) ? "σ²" : "1−x",
          disabled: locked,
          inputLabel: `${SIDE_LABEL[side]} units to sell`,
        }}
        bottom={{
          label: (
            <>
              Writer&apos;s bid <b>${fmtPriceUsdc(bidFor(g, side))}</b> USDC / unit
            </>
          ),
          value: proceeds !== undefined ? fmtPriceUsdc(proceeds) : quote.isFetching ? "…" : "0.00",
          unit: "USDC",
          unitIcon: "$",
          dim: proceeds === undefined,
        }}
      />
      {underfunded ? (
        <p className="m-0 border border-down bg-down/10 p-3 text-[13px] leading-5 text-white" role="alert">
          This exit is blocked: it needs <b className="tnum">{fmtUsdc(funding.needed)}</b> USDC but only{" "}
          <b className="tnum">{fmtUsdc(funding.available)}</b> is available — the reserve this burn releases
          plus the exit buffer. Settlement backing stays protected and locked; early-exit liquidity is a
          separate, writer-managed buffer, and the writer can withdraw the unused part at any time.
        </p>
      ) : null}
      {quote.error && !underfunded ? (
        <p className="m-0 text-[12px] text-down">On-chain quote failed — the exit may be underfunded right now.</p>
      ) : null}
      {partial ? (
        <p className="m-0 text-[12px] text-white/60">
          The bid is good for <b className="tnum">{fmtUnits(filled ?? 0n, 4)}</b> units right now — this exit
          fills partially.
        </p>
      ) : null}
      <DarkItems
        items={[
          { label: "Proceeds (on-chain quote)", value: proceeds !== undefined ? `${fmtUsdc(proceeds)} USDC` : quote.isFetching ? "…" : "—" },
          { label: "Exit buffer", value: `${fmtUsdc(g.exitBuffer)} USDC` },
          { label: "Reserve this burn releases", value: funding !== undefined ? `${fmtUsdc(funding.available - g.exitBuffer)} USDC` : "—" },
          { label: "Exit closes", value: fmtDateTime(g.params.expiry) },
        ]}
      />
      <SlippageRow value={slippage} onChange={setSlippage} />
      <Button size="lg" className="w-full" variant={open ? "primary" : "white"} disabled={!valid || !!blocker || flow.running || proceeds === undefined} loading={flow.running} onClick={submit}>
        {blocker ?? "Sell at the writer's bid"}
      </Button>
      {flow.steps.some((st) => st.phase !== "todo") ? <TxProgress dark steps={flow.steps} className="pt-1" /> : null}
      {flow.result ? (
        <p className="m-0 text-[12px] text-white/60">
          Done · <TxHash value={flow.result.hash} />
        </p>
      ) : null}
      <p className="m-0 text-[12px] leading-4 text-white/45">
        An early-exit quote can become unavailable before execution, while settlement backing remains
        protected: the writer can withdraw unused exit liquidity at any time.
      </p>
    </div>
  );
}

/** Redeem one side at the payout fixed at finalization, or burn it if it finalized worthless. */
export function RedeemGroupTicket({ g, side }: { g: GroupState; side: Side }) {
  const { address } = useAccount();
  const toast = useToast();
  const qc = useQueryClient();
  const flow = useTxFlow<SwapResult>(REDEEM_GROUP_PLAN);
  const burnFlow = useTxFlow<`0x${string}`>(BURN_WORTHLESS_GROUP_PLAN);
  const { amount, setAmount, parsed, valid } = useUnitsInput();
  const [slippage, setSlippage] = useState<"50" | "100" | "200">("100");
  const bal = useTokenBalance(receiptFor(g, side), address);

  const redeemable = groupCanRedeem(g, side);
  const worthless = groupNeedsWorthlessBurn(g, side);
  const quote = useGroupQuote(g, "settle", side, true, valid && redeemable ? parsed : null, redeemable);
  const proceeds = quote.data?.amountOut;

  let blocker: string | undefined;
  if (!isPortfolioDeployed) blocker = "Contracts not deployed";
  else if (!g.finalized) blocker = "Not finalized yet";
  else if (!redeemable && !worthless) blocker = "Nothing to redeem on this side";
  else if (!address) blocker = "Connect a wallet";
  else if (bal.data !== undefined && bal.data === 0n) blocker = `No ${SIDE_LABEL[side]} receipts held`;
  else if (parsed !== null && bal.data !== undefined && parsed > bal.data) blocker = "Exceeds your balance";
  const locked = !!blocker && blocker !== "Connect a wallet" && blocker !== "Exceeds your balance";

  const submit = async () => {
    if (!valid || blocker) return;
    if (worthless) {
      const hash = await burnFlow.run((ctx) => runBurnWorthlessGroup(ctx, g.id, sideIsHigh(side), parsed as bigint));
      if (hash) {
        toast.success("Receipts burned", `${SIDE_LABEL[side]} finalized worthless`);
        void qc.invalidateQueries({ queryKey: ["chain"] });
        setAmount("");
      } else if (burnFlow.error) toast.error("Burn failed", burnFlow.error);
      return;
    }
    const res = await flow.run((ctx) =>
      runRedeemGroup(ctx, { group: g, side, units: parsed as bigint, slippageBps: Number(slippage) }),
    );
    if (res) {
      toast.success("Redeemed", res.amountOut !== undefined ? `Received ${fmtUsdc(res.amountOut)} USDC` : undefined);
      void qc.invalidateQueries({ queryKey: ["chain"] });
      setAmount("");
    } else if (flow.error) toast.error("Redeem failed", flow.error);
  };

  const running = flow.running || burnFlow.running;
  const activeFlow = worthless ? burnFlow : flow;
  const estimate = valid && g.finalized ? ((parsed as bigint) * ppuFor(g, side)) / WAD : undefined;

  return (
    <div className="flex flex-col gap-3">
      {worthless ? (
        <p className="m-0 border border-white/20 bg-white/5 p-3 text-[13px] leading-5 text-white/80" role="status">
          {SIDE_LABEL[side]} finalized at a zero payout, which cannot go through SwapVM. Burning the receipts
          clears the position; the money went to the other side.
        </p>
      ) : null}
      <TicketWidget
        top={{
          label: (
            <>
              Balance <b>{bal.data !== undefined ? fmtUnits(bal.data, 4) : address ? "…" : "—"}</b> {SIDE_LABEL[side]} units
            </>
          ),
          value: amount,
          onChange: setAmount,
          onMax:
            bal.data !== undefined && bal.data > 0n
              ? () => setAmount(fmtUnits(bal.data as bigint, 18).replace(/,/g, ""))
              : undefined,
          unit: `${SIDE_LABEL[side]} units`,
          unitIcon: sideIsHigh(side) ? "σ²" : "1−x",
          disabled: locked,
          inputLabel: `${SIDE_LABEL[side]} units to redeem`,
        }}
        bottom={{
          label: (
            <>
              Fixed payout <b>{g.finalized ? `$${fmtPriceUsdc(ppuFor(g, side))}` : "—"}</b> USDC / unit
            </>
          ),
          value: worthless
            ? "0.00"
            : proceeds !== undefined
              ? fmtPriceUsdc(proceeds)
              : quote.isFetching
                ? "…"
                : estimate !== undefined
                  ? fmtPriceUsdc(estimate)
                  : "0.00",
          unit: "USDC",
          unitIcon: "$",
          dim: proceeds === undefined,
        }}
      />
      <DarkItems
        items={[
          { label: "Final variance", value: g.finalized ? g.finalVariance.toString() : "not yet fixed" },
          { label: `${SIDE_LABEL[side]} payout / unit`, value: g.finalized ? `$${fmtPriceUsdc(ppuFor(g, side))} USDC` : "—" },
          { label: "Proceeds (on-chain quote)", value: worthless ? "0 — burn" : proceeds !== undefined ? `$${fmtPriceUsdc(proceeds)} USDC` : "—" },
        ]}
      />
      {!worthless ? <SlippageRow value={slippage} onChange={setSlippage} /> : null}
      <Button
        size="lg"
        className="w-full"
        variant={redeemable || worthless ? "primary" : "white"}
        disabled={!valid || !!blocker || running || (!worthless && proceeds === undefined)}
        loading={running}
        onClick={submit}
      >
        {blocker ?? (worthless ? "Burn worthless receipts" : `Redeem ${SIDE_LABEL[side]}`)}
      </Button>
      {activeFlow.steps.some((st) => st.phase !== "todo") ? <TxProgress dark steps={activeFlow.steps} className="pt-1" /> : null}
      <p className="m-0 text-[12px] leading-4 text-white/45">
        Redemption pays the payout fixed at finalization. No deadline, and nothing needed from the writer.
      </p>
    </div>
  );
}
