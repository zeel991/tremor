"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { usePortfolio, useVault, type Position } from "@/lib/api";
import { useReceiptBalances, useWriterVault } from "@/lib/chain";
import { isDeployed, isPortfolioDeployed } from "@/lib/contracts";
import { fmtAllowance, fmtDate, fmtPriceUsdc, fmtUnits, fmtUsdc, parseDecimal, USDC_DECIMALS } from "@/lib/format";
import { useNow, useSeriesList } from "@/lib/hooks";
import {
  canClose,
  canExit,
  canRedeem,
  isFinalized,
  maxLiabilityFor,
  needsWorthlessBurn,
  payoutFor,
  receiptSymbol,
  Status,
  type SeriesState,
} from "@/lib/series";
import {
  useGroupList,
  usePortfolioVault,
  useVaultBalances,
} from "@/lib/portfolio-chain";
import {
  askFor,
  bidFor,
  GROUP_STATUS_LABEL,
  groupCanExit,
  groupCanRedeem,
  groupExitProceeds,
  groupNeedsWorthlessBurn,
  groupSettleProceeds,
  groupStatus,
  groupSymbol,
  ppuFor,
  receiptFor,
  SIDE_LABEL,
  sideSymbol,
  standaloneCapsFor,
  type GroupState,
  type Side,
} from "@/lib/portfolio";
import {
  BURN_WORTHLESS_GROUP_PLAN,
  BURN_WORTHLESS_PLAN,
  CLOSE_SERIES_PLAN,
  DEPOSIT_PLAN,
  REDEEM_GROUP_PLAN,
  REDEEM_PLAN,
  runBurnWorthless,
  runBurnWorthlessGroup,
  runCloseSeries,
  runDeposit,
  runRedeem,
  runRedeemGroup,
  runStopIssuance,
  runWithdrawFree,
  STOP_ISSUANCE_PLAN,
  useTxFlow,
  WITHDRAW_FREE_PLAN,
  type SwapResult,
} from "@/lib/tx";
import { Card } from "@/components/ui/Card";
import { StatusTag, Tag } from "@/components/ui/Tag";
import { StatTile } from "@/components/ui/StatTile";
import { AmountInput } from "@/components/ui/AmountInput";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { WalletPill } from "@/components/shell/WalletPill";
import { LockedBackingCell } from "@/components/series/SeriesTable";

type Held = { s: SeriesState; units: bigint; position?: Position };

type HeldGroup = {
  g: GroupState;
  side: Side;
  units: bigint;
};

/**
 * Redemption pays the final variance and needs nothing from the writer, so it belongs in a one-click
 * button. A finalized series that pays zero cannot go through SwapVM at all — it rejects a zero
 * output — so that case burns instead, which releases the writer's reservation just the same.
 */
function RedeemButton({ s, units }: { s: SeriesState; units: bigint }) {
  const worthless = needsWorthlessBurn(s);
  const flow = useTxFlow<SwapResult>(REDEEM_PLAN);
  const burnFlow = useTxFlow<`0x${string}`>(BURN_WORTHLESS_PLAN);
  const toast = useToast();
  const qc = useQueryClient();
  const active = worthless ? burnFlow : flow;
  const enabled = units > 0n && (worthless || canRedeem(s));

  if (!enabled && canExit(s)) {
    return (
      <Link href={`/series/${s.id.toString()}`} className="btn btn-tertiary btn-sm">
        Exit
      </Link>
    );
  }
  return (
    <Button
      size="sm"
      variant={enabled ? "primary" : "tertiary"}
      disabled={!enabled || active.running}
      loading={active.running}
      title={
        worthless
          ? "Final realized variance was zero: burn the receipts to release the writer's reservation"
          : "Receipts in, USDC out at the final realized variance"
      }
      onClick={async () => {
        if (worthless) {
          const hash = await burnFlow.run((ctx) => runBurnWorthless(ctx, s.id, units));
          if (hash) {
            toast.success("Receipts burned", "This series finalized at zero realized variance.");
            void qc.invalidateQueries({ queryKey: ["chain"] });
          } else if (burnFlow.error) toast.error("Burn failed", burnFlow.error);
          return;
        }
        const r = await flow.run((ctx) => runRedeem(ctx, { state: s, units, slippageBps: 100 }));
        if (r) {
          toast.success("Redeemed", r.amountOut !== undefined ? `Received ${fmtUsdc(r.amountOut)} USDC` : undefined);
          void qc.invalidateQueries({ queryKey: ["chain"] });
        } else if (flow.error) toast.error("Redeem failed", flow.error);
      }}
    >
      {worthless ? "Burn" : enabled ? "Redeem" : isFinalized(s) ? "Redeemed" : "Not yet"}
    </Button>
  );
}

/** One-click redeem or burn for paired market receipts */
function RedeemGroupButton({ g, side, units }: { g: GroupState; side: Side; units: bigint }) {
  const worthless = groupNeedsWorthlessBurn(g, side);
  const redeemable = groupCanRedeem(g, side);
  const enabled = units > 0n && (worthless || redeemable);
  const flow = useTxFlow<SwapResult>(REDEEM_GROUP_PLAN);
  const burnFlow = useTxFlow<`0x${string}`>(BURN_WORTHLESS_GROUP_PLAN);
  const toast = useToast();
  const qc = useQueryClient();
  const active = worthless ? burnFlow : flow;

  if (!enabled) {
    return (
      <Link href={`/pairs/${g.id.toString()}`} className="btn btn-tertiary btn-sm">
        View
      </Link>
    );
  }

  return (
    <Button
      size="sm"
      variant={enabled ? "primary" : "tertiary"}
      disabled={!enabled || active.running}
      loading={active.running}
      title={
        worthless
          ? `${SIDE_LABEL[side]} finalized at zero payout: burn to clear the receipt`
          : "Redeem receipts at the final fixed payout"
      }
      onClick={async () => {
        if (worthless) {
          const hash = await burnFlow.run((ctx) =>
            runBurnWorthlessGroup(ctx, g.id, side === "high", units),
          );
          if (hash) {
            toast.success("Receipts burned", `${SIDE_LABEL[side]} finalized worthless`);
            void qc.invalidateQueries({ queryKey: ["chain"] });
          } else if (burnFlow.error) toast.error("Burn failed", burnFlow.error);
          return;
        }
        const r = await flow.run((ctx) =>
          runRedeemGroup(ctx, { group: g, side, units, slippageBps: 100 }),
        );
        if (r) {
          toast.success("Redeemed", r.amountOut !== undefined ? `Received ${fmtUsdc(r.amountOut)} USDC` : undefined);
          void qc.invalidateQueries({ queryKey: ["chain"] });
        } else if (flow.error) toast.error("Redeem failed", flow.error);
      }}
    >
      {worthless ? "Burn" : enabled ? "Redeem" : g.finalized ? "Redeemed" : "Not yet"}
    </Button>
  );
}

/** Permanently closes new sales. Exit and redemption are unaffected, which is the whole point. */
function StopIssuanceButton({ s }: { s: SeriesState }) {
  const flow = useTxFlow<`0x${string}`>(STOP_ISSUANCE_PLAN);
  const toast = useToast();
  const qc = useQueryClient();
  if (!s.legs.issuanceOpen) return null;
  return (
    <Button
      size="sm"
      variant="tertiary"
      disabled={flow.running}
      loading={flow.running}
      title="Stops new sales for good. Holders keep their exit bid and their redemption."
      onClick={async () => {
        if (
          !window.confirm(
            `Stop issuance for series #${s.id.toString()}? This cannot be undone. Exit and redemption stay open for the ${fmtUnits(s.unitsOutstanding, 2)} units already sold.`,
          )
        )
          return;
        const hash = await flow.run((ctx) => runStopIssuance(ctx, s.id));
        if (hash) {
          toast.success("Issuance stopped", "Exit and redemption remain open.");
          void qc.invalidateQueries({ queryKey: ["chain"] });
        } else if (flow.error) toast.error("Stop failed", flow.error);
      }}
    >
      Stop issuance
    </Button>
  );
}

/**
 * Close is only offered with no receipts outstanding, because that is the only condition under which
 * it can succeed: the controller docks the strategies, burns the unsold inventory and releases the
 * residual reservation, and every one of those steps reverts while a claim is live.
 */
function CloseSeriesButton({ s }: { s: SeriesState }) {
  const flow = useTxFlow<`0x${string}`>(CLOSE_SERIES_PLAN);
  const toast = useToast();
  const qc = useQueryClient();
  if (s.status === Status.Closed) return null;
  const enabled = canClose(s);
  return (
    <Button
      size="sm"
      variant="tertiary"
      disabled={!enabled || flow.running}
      loading={flow.running}
      title={
        enabled
          ? "Docks the strategies, burns unsold inventory and frees the residual collateral"
          : `${fmtUnits(s.unitsOutstanding, 2)} units are still outstanding; they have to be exited or redeemed first`
      }
      onClick={async () => {
        const hash = await flow.run((ctx) => runCloseSeries(ctx, s.id));
        if (hash) {
          toast.success("Series closed", "The residual collateral is free to withdraw.");
          void qc.invalidateQueries({ queryKey: ["chain"] });
        } else if (flow.error) toast.error("Close failed", flow.error);
      }}
    >
      Close
    </Button>
  );
}

/**
 * The writer's vault, which is where every claim on their collateral is enforced.
 *
 * Only `free` can leave. `locked` is the sum of the reservations for every unit sold across every one
 * of this writer's series, and the vault reverts a withdrawal that would touch it — no admin path, no
 * exception. Withdrawal is shown even at zero so a writer can see *why* it is zero.
 */
function VaultCard({ writer }: { writer: `0x${string}` }) {
  const v2Chain = useWriterVault(writer);
  const pVaultQuery = usePortfolioVault(writer);
  const pVaultAddress = pVaultQuery.data && !/^0x0{40}$/i.test(pVaultQuery.data) ? pVaultQuery.data : undefined;
  const pBalancesQuery = useVaultBalances(pVaultAddress);

  // Active vault selection: prefer portfolio vault if deployed and holding funds or exists, else v2 series vault
  const activeVault = useMemo(() => {
    if (pVaultAddress && pBalancesQuery.data) {
      return {
        vault: pVaultAddress,
        exists: true,
        isPortfolio: true,
        state: {
          vault: pVaultAddress,
          owner: writer,
          balance: pBalancesQuery.data.balance,
          locked: pBalancesQuery.data.locked,
          free: pBalancesQuery.data.free,
          aquaAllowance: ~0n,
          allowanceSufficient: true,
        },
      };
    }
    if (v2Chain.data?.exists) {
      return {
        vault: v2Chain.data.vault,
        exists: true,
        isPortfolio: false,
        state: v2Chain.data.state,
      };
    }
    return undefined;
  }, [pVaultAddress, pBalancesQuery.data, v2Chain.data, writer]);

  const indexed = useVault(activeVault?.vault);
  const [amount, setAmount] = useState("");
  const deposit = useTxFlow<`0x${string}`>(DEPOSIT_PLAN);
  const withdraw = useTxFlow<`0x${string}`>(WITHDRAW_FREE_PLAN);
  const toast = useToast();
  const qc = useQueryClient();

  const parsed = useMemo(() => {
    if (!amount.trim()) return null;
    try {
      return parseDecimal(amount, USDC_DECIMALS);
    } catch {
      return null;
    }
  }, [amount]);

  if (!activeVault) {
    return (
      <Card title="Maker vault" meta="Created the first time you write a series or paired market">
        <EmptyState
          action={
            <div className="flex gap-2">
              <Link href="/write" className="btn btn-tertiary btn-sm">
                Write a series
              </Link>
              <Link href="/pairs/new" className="btn btn-tertiary btn-sm">
                Write paired market
              </Link>
            </div>
          }
        >
          {isDeployed
            ? "No maker vault for this wallet yet. Writing your first series or pair deploys one at a deterministic address."
            : "Contracts not deployed on this chain."}
        </EmptyState>
      </Card>
    );
  }

  const v = activeVault.state;
  const busy = deposit.running || withdraw.running;
  const isPending = activeVault.isPortfolio ? pBalancesQuery.isPending : v2Chain.isPending;
  const err =
    amount.trim() && parsed === null
      ? "Enter an amount in USDC"
      : parsed !== null && parsed <= 0n
        ? "Enter an amount above zero"
        : undefined;

  return (
    <Card
      title={`Maker vault ${activeVault.isPortfolio ? "(Paired Markets)" : "(Series)"}`}
      meta="Reserved collateral cannot be withdrawn, and the Aqua allowance cannot be revoked"
      action={
        <div className="flex items-center gap-2">
          <span className="mono text-[11px] text-ink-3">{activeVault.vault.slice(0, 8)}…{activeVault.vault.slice(-6)}</span>
          <Tag tone={v.allowanceSufficient ? "up" : "down"}>
            {v.allowanceSufficient ? "Aqua allowance sufficient" : "Aqua allowance too low"}
          </Tag>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <StatTile size="sm" label="Balance" value={`${fmtUsdc(v.balance)} USDC`} loading={isPending} />
        <StatTile
          size="sm"
          label="Reserved"
          value={`${fmtUsdc(v.locked)} USDC`}
          sub="Backing units already sold"
          loading={isPending}
        />
        <StatTile
          size="sm"
          label="Free"
          value={`${fmtUsdc(v.free)} USDC`}
          sub="Withdrawable now"
          loading={isPending}
        />
        <StatTile size="sm" label="Aqua allowance" value={fmtAllowance(v.aquaAllowance)} loading={isPending} />
      </div>
      <div className="mt-4 grid items-end gap-3 sm:grid-cols-[1fr_auto_auto]">
        <AmountInput
          label="Amount"
          value={amount}
          onChange={setAmount}
          unit="USDC"
          disabled={busy}
          error={err}
          right={`free ${fmtUsdc(v.free)}`}
        />
        <Button
          variant="primary"
          disabled={busy || parsed === null || parsed <= 0n}
          loading={deposit.running}
          onClick={async () => {
            const hash = await deposit.run((ctx) => runDeposit(ctx, activeVault.vault, parsed as bigint));
            if (hash) {
              setAmount("");
              toast.success("Vault funded", `${fmtUsdc(parsed as bigint)} USDC deposited.`);
              void qc.invalidateQueries({ queryKey: ["chain"] });
            } else if (deposit.error) toast.error("Deposit failed", deposit.error);
          }}
        >
          Deposit
        </Button>
        <Button
          variant="tertiary"
          disabled={busy || parsed === null || parsed <= 0n || (parsed ?? 0n) > v.free}
          loading={withdraw.running}
          title={
            (parsed ?? 0n) > v.free
              ? "The vault reverts a withdrawal that would touch reserved collateral"
              : "Withdraws unreserved collateral to this wallet"
          }
          onClick={async () => {
            const hash = await withdraw.run((ctx) =>
              runWithdrawFree(ctx, activeVault.vault, parsed as bigint, writer),
            );
            if (hash) {
              setAmount("");
              toast.success("Withdrawn", `${fmtUsdc(parsed as bigint)} USDC returned to your wallet.`);
              void qc.invalidateQueries({ queryKey: ["chain"] });
            } else if (withdraw.error) toast.error("Withdrawal failed", withdraw.error);
          }}
        >
          Withdraw free
        </Button>
      </div>
      <p className="small mt-3 text-ink-3">
        {indexed.data?.indexed
          ? `Indexed history: ${fmtUsdc(indexed.data.indexed.deposited ?? 0n)} USDC deposited, ${fmtUsdc(indexed.data.indexed.withdrawn ?? 0n)} withdrawn.`
          : "Deposit and withdrawal history comes from the indexer, which is currently unavailable."}
      </p>
    </Card>
  );
}

function SeriesCell({ s }: { s: SeriesState }) {
  return (
    <>
      <Link href={`/series/${s.id.toString()}`} className="font-medium hover:underline">
        {receiptSymbol(s)}
      </Link>
      <span className="mono block text-[11px] text-ink-3">
        #{s.id.toString()} · {fmtDate(s.params.expiry)}
      </span>
    </>
  );
}

export function PortfolioView() {
  const { address } = useAccount();
  const { data, isLoading } = useSeriesList();
  const groupList = useGroupList();
  const now = useNow(5_000);

  // Collect all receipt tokens across v2 series and v3 paired markets
  const allReceiptTokens = useMemo(() => {
    const list: { receipt: `0x${string}` }[] = [];
    (data ?? []).forEach((s) => list.push({ receipt: s.receipt }));
    (groupList.data ?? []).forEach((g) => {
      list.push({ receipt: g.highReceipt });
      list.push({ receipt: g.calmReceipt });
    });
    return list as unknown as SeriesState[];
  }, [data, groupList.data]);

  const balances = useReceiptBalances(address, allReceiptTokens);
  const portfolio = usePortfolio(address);

  /** Held v2 series receipts */
  const heldSeries = useMemo<Held[]>(() => {
    if (!data || !balances.data) return [];
    const byId = new Map((portfolio.data?.positions ?? []).map((p) => [p.seriesId.toString(), p]));
    return data
      .map((s) => ({
        s,
        units: balances.data!.get(s.receipt.toLowerCase()) ?? 0n,
        position: byId.get(s.id.toString()),
      }))
      .filter((x) => x.units > 0n);
  }, [data, balances.data, portfolio.data]);

  /** Held v3 paired market receipts (HIGH or CALM) */
  const heldGroups = useMemo<HeldGroup[]>(() => {
    if (!groupList.data || !balances.data) return [];
    const out: HeldGroup[] = [];
    for (const g of groupList.data) {
      const highUnits = balances.data.get(g.highReceipt.toLowerCase()) ?? 0n;
      if (highUnits > 0n) out.push({ g, side: "high", units: highUnits });
      const calmUnits = balances.data.get(g.calmReceipt.toLowerCase()) ?? 0n;
      if (calmUnits > 0n) out.push({ g, side: "calm", units: calmUnits });
    }
    return out;
  }, [groupList.data, balances.data]);

  const written = useMemo(
    () => (data ?? []).filter((s) => s.writer.toLowerCase() === address?.toLowerCase()),
    [data, address],
  );

  const writtenGroups = useMemo(
    () => (groupList.data ?? []).filter((g) => g.writer.toLowerCase() === address?.toLowerCase()),
    [groupList.data, address],
  );

  const unitsTotal =
    heldSeries.reduce((acc, x) => acc + x.units, 0n) +
    heldGroups.reduce((acc, x) => acc + x.units, 0n);

  /** Redeemable now: finalized payout only across both markets. */
  const redeemableTotal =
    heldSeries.reduce(
      (acc, x) => acc + (isFinalized(x.s) ? payoutFor(x.units, x.s.payoutPerUnit) : 0n),
      0n,
    ) +
    heldGroups.reduce(
      (acc, x) => acc + (x.g.finalized ? groupSettleProceeds(x.units, ppuFor(x.g, x.side)) : 0n),
      0n,
    );

  /** Executable exit value: the bid a holder could actually hit right now. */
  const exitTotal =
    heldSeries.reduce(
      (acc, x) => acc + (canExit(x.s) ? payoutFor(x.units, x.s.quote.bidPerUnit) : 0n),
      0n,
    ) +
    heldGroups.reduce(
      (acc, x) => acc + (groupCanExit(x.g, x.side, now) ? groupExitProceeds(x.units, bidFor(x.g, x.side)) : 0n),
      0n,
    );

  const indexedCost = heldSeries.reduce((acc, x) => acc + (x.position?.costBasisKnown ? x.position.indexedCost : 0n), 0n);
  const costKnown = heldSeries.some((x) => x.position?.costBasisKnown);
  const reservedTotal =
    written.reduce((acc, s) => acc + s.lockedLiability, 0n) +
    writtenGroups.reduce((acc, g) => acc + g.reserveLocked, 0n);

  if (!address) {
    return (
      <Card>
        <EmptyState action={<WalletPill />}>
          Connect a wallet to see the receipts you hold and the series you have written.
        </EmptyState>
      </Card>
    );
  }

  const loading =
    isLoading ||
    groupList.isLoading ||
    (allReceiptTokens.length > 0 && balances.isPending);

  const totalPositionsCount = heldSeries.length + heldGroups.length;
  const totalWrittenCount = written.length + writtenGroups.length;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Receipts held"
          value={fmtUnits(unitsTotal, 2)}
          sub={`${totalPositionsCount} positions (${heldSeries.length} series, ${heldGroups.length} paired)`}
          loading={loading}
        />
        <StatTile
          label="Redeemable now"
          value={`${fmtPriceUsdc(redeemableTotal)} USDC`}
          sub="Finalized markets, at the final variance"
          loading={loading}
        />
        <StatTile
          label="Exit value"
          value={`${fmtPriceUsdc(exitTotal)} USDC`}
          sub="At the current executable bid"
          loading={loading}
        />
        <StatTile
          label="Collateral reserved"
          value={totalWrittenCount > 0 ? `${fmtUsdc(reservedTotal)} USDC` : "—"}
          sub={`${totalWrittenCount} markets written`}
          loading={loading}
        />
      </div>

      <Card
        title="Receipts held"
        meta="Exit before expiry at the market's bid, or redeem after finalization at the realized variance"
        flush
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Side / Series</th>
                <th>Status</th>
                <th className="num">Units</th>
                <th className="num">Exit bid / unit</th>
                <th className="num">Payout / unit</th>
                <th className="num">Value</th>
                <th className="num">Action</th>
              </tr>
            </thead>
            {loading ? (
              <SkeletonRows rows={2} cols={8} />
            ) : (
              <tbody>
                {totalPositionsCount === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ height: "auto" }}>
                      <EmptyState
                        action={
                          <div className="flex gap-2">
                            <Link href="/markets" className="btn btn-tertiary btn-sm">
                              Browse series
                            </Link>
                            <Link href="/pairs" className="btn btn-tertiary btn-sm">
                              Browse paired
                            </Link>
                          </div>
                        }
                      >
                        {isDeployed ? "No receipts in this wallet." : "Contracts not deployed on this chain."}
                      </EmptyState>
                    </td>
                  </tr>
                ) : (
                  <>
                    {/* Paired market positions */}
                    {heldGroups.map(({ g, side, units }) => {
                      const st = groupStatus(g, now);
                      const ppu = ppuFor(g, side);
                      const bid = bidFor(g, side);
                      const val = g.finalized
                        ? groupSettleProceeds(units, ppu)
                        : groupCanExit(g, side, now)
                          ? groupExitProceeds(units, bid)
                          : 0n;

                      return (
                        <tr key={`group-${g.id.toString()}-${side}`}>
                          <td>
                            <Link href={`/pairs/${g.id.toString()}`} className="font-medium hover:underline">
                              {groupSymbol(g)}
                            </Link>
                            <span className="mono block text-[11px] text-ink-3">
                              Pair #{g.id.toString()} · {fmtDate(g.params.expiry)}
                            </span>
                          </td>
                          <td>
                            <Tag tone={side === "high" ? "lime" : "outline"}>
                              {sideSymbol(g, side)}
                            </Tag>
                          </td>
                          <td>
                            <Tag tone={g.finalized ? "default" : "up"}>
                              {GROUP_STATUS_LABEL[st]}
                            </Tag>
                          </td>
                          <td className="num">{fmtUnits(units, 4)}</td>
                          <td className="num">
                            {g.finalized ? (
                              <span className="text-ink-3">expired</span>
                            ) : (
                              `$${fmtPriceUsdc(bid)} USDC`
                            )}
                          </td>
                          <td className="num">
                            {g.finalized ? (
                              `$${fmtPriceUsdc(ppu)} USDC`
                            ) : (
                              <span className="text-ink-3" title="Fixed only when finalized">
                                not yet fixed
                              </span>
                            )}
                          </td>
                          <td className="num font-medium">
                            {val > 0n ? `$${fmtPriceUsdc(val)} USDC` : "—"}
                          </td>
                          <td className="num">
                            <RedeemGroupButton g={g} side={side} units={units} />
                          </td>
                        </tr>
                      );
                    })}

                    {/* Series positions */}
                    {heldSeries.map(({ s, units, position }) => {
                      const finalized = isFinalized(s);
                      const value = finalized
                        ? payoutFor(units, s.payoutPerUnit)
                        : canExit(s)
                          ? payoutFor(units, s.quote.bidPerUnit)
                          : 0n;
                      return (
                        <tr key={`series-${s.id.toString()}`}>
                          <td>
                            <SeriesCell s={s} />
                          </td>
                          <td>
                            <span className="text-ink-3">Series #{s.id.toString()}</span>
                          </td>
                          <td>
                            <StatusTag status={s.status} issuanceOpen={s.legs.issuanceOpen} compact />
                          </td>
                          <td className="num">{fmtUnits(units, 4)}</td>
                          <td className="num">
                            {finalized ? (
                              <span className="text-ink-3">expired</span>
                            ) : (
                              `$${fmtPriceUsdc(s.quote.bidPerUnit)} USDC`
                            )}
                          </td>
                          <td className="num">
                            {finalized ? (
                              `$${fmtPriceUsdc(s.payoutPerUnit)} USDC`
                            ) : (
                              <span className="text-ink-3" title="Fixed only when the observation window is finalized">
                                not yet fixed
                              </span>
                            )}
                          </td>
                          <td className="num font-medium">{value > 0n ? `$${fmtPriceUsdc(value)} USDC` : "—"}</td>
                          <td className="num">
                            <RedeemButton s={s} units={units} />
                          </td>
                        </tr>
                      );
                    })}
                  </>
                )}
              </tbody>
            )}
          </table>
        </div>
        {heldSeries.length > 0 ? (
          <p className="small border-t border-line px-4 py-2 text-ink-3">
            {costKnown
              ? `Indexed cost across series positions with a known entry: ${fmtUsdc(indexedCost)} USDC.`
              : "Series positions arrived via on-chain mint or transfer."}
          </p>
        ) : null}
      </Card>

      <VaultCard writer={address} />

      {/* Paired markets written */}
      {isPortfolioDeployed && (
        <Card
          title="Paired markets written"
          meta="Complementary HIGH/CALM claims sharing a single max(h,c)·S collateral reserve"
          flush
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Status</th>
                  <th className="num">HIGH sold</th>
                  <th className="num">CALM sold</th>
                  <th className="num">Reserve locked</th>
                  <th className="num">Exit buffer</th>
                  <th className="num">Action</th>
                </tr>
              </thead>
              {loading ? (
                <SkeletonRows rows={2} cols={7} />
              ) : (
                <tbody>
                  {writtenGroups.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ height: "auto" }}>
                        <EmptyState
                          action={
                            <Link href="/pairs/new" className="btn btn-tertiary btn-sm">
                              Write a paired market
                            </Link>
                          }
                        >
                          No paired markets written by this wallet.
                        </EmptyState>
                      </td>
                    </tr>
                  ) : (
                    writtenGroups.map((g) => {
                      const st = groupStatus(g, now);
                      const standalone =
                        g.standaloneCaps > 0n
                          ? g.standaloneCaps
                          : standaloneCapsFor(g.highOutstanding, g.calmOutstanding, g.params.capPayoutPerUnit);

                      return (
                        <tr key={g.id.toString()}>
                          <td>
                            <Link href={`/pairs/${g.id.toString()}`} className="font-medium hover:underline">
                              {groupSymbol(g)}
                            </Link>
                            <span className="mono block text-[11px] text-ink-3">
                              #{g.id.toString()} · {fmtDate(g.params.expiry)}
                            </span>
                          </td>
                          <td>
                            <Tag tone={g.finalized ? "default" : "up"}>{GROUP_STATUS_LABEL[st]}</Tag>
                          </td>
                          <td className="num">
                            {fmtUnits(g.highOutstanding, 2)}
                            <span className="text-ink-3"> / {fmtUnits(g.params.maxUnitsPerSide, 0)}</span>
                          </td>
                          <td className="num">
                            {fmtUnits(g.calmOutstanding, 2)}
                            <span className="text-ink-3"> / {fmtUnits(g.params.maxUnitsPerSide, 0)}</span>
                          </td>
                          <td className="num">
                            <span className="font-medium">{fmtUsdc(g.reserveLocked)} USDC</span>
                            <span className="text-ink-3 block text-[11px]">
                              / {fmtUsdc(standalone, 0)} if separate
                            </span>
                          </td>
                          <td className="num">{fmtUsdc(g.exitBuffer)} USDC</td>
                          <td className="num">
                            <Link href={`/pairs/${g.id.toString()}`} className="btn btn-tertiary btn-sm">
                              Manage
                            </Link>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              )}
            </table>
          </div>
        </Card>
      )}

      {/* Series written */}
      <Card
        title="Series written"
        meta="Every unit sold reserves collateral in your vault until the receipt is burned"
        flush
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Series</th>
                <th>Status</th>
                <th className="num">Units sold</th>
                <th className="num">Units unsold</th>
                <th className="num">Reserved</th>
                <th className="num">At the cap</th>
                <th className="num">Premium taken</th>
                <th>Backing</th>
                <th className="num">Action</th>
              </tr>
            </thead>
            {loading ? (
              <SkeletonRows rows={2} cols={9} />
            ) : (
              <tbody>
                {written.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ height: "auto" }}>
                      <EmptyState
                        action={
                          <Link href="/write" className="btn btn-tertiary btn-sm">
                            Write one
                          </Link>
                        }
                      >
                        No series written by this wallet.
                      </EmptyState>
                    </td>
                  </tr>
                ) : (
                  written.map((s) => (
                    <tr key={s.id.toString()}>
                      <td>
                        <SeriesCell s={s} />
                      </td>
                      <td>
                        <StatusTag status={s.status} issuanceOpen={s.legs.issuanceOpen} compact />
                      </td>
                      <td className="num">{fmtUnits(s.unitsOutstanding, 2)}</td>
                      <td className="num">
                        {fmtUnits(s.unitsAvailable, 2)}
                        <span className="text-ink-3"> / {fmtUnits(s.params.maxUnits, 0)}</span>
                      </td>
                      <td className="num">{fmtUsdc(s.lockedLiability)} USDC</td>
                      <td className="num">{fmtUsdc(maxLiabilityFor(s.unitsOutstanding, s.params))} USDC</td>
                      <td className="num">
                        {s.premiumQuote !== undefined ? (
                          `${fmtUsdc(s.premiumQuote)} USDC`
                        ) : (
                          <span className="text-ink-3">indexer offline</span>
                        )}
                      </td>
                      <td>
                        <LockedBackingCell s={s} />
                      </td>
                      <td className="num">
                        <span className="inline-flex flex-wrap justify-end gap-2">
                          <StopIssuanceButton s={s} />
                          <CloseSeriesButton s={s} />
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            )}
          </table>
        </div>
      </Card>
    </div>
  );
}
