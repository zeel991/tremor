/**
 * Write flows. Every flow simulates, asks the wallet to confirm, waits for the receipt, and reports
 * per-step state for the UI's progress list. Amounts are bigint end to end.
 *
 * The twelve flows are the whole product surface:
 *
 *   writer   CREATE_VAULT · DEPOSIT · CREATE_SERIES · STOP_ISSUANCE · WITHDRAW_FREE
 *   holder   BUY · EXIT · REDEEM · BURN_WORTHLESS
 *   anyone   CHECKPOINT · FINALIZE · CLOSE_SERIES
 *
 * The last three are deliberately unprivileged: checkpointing and finalization are what make
 * path-dependent settlement work, and nothing in Tremor may depend on a keeper remembering to do them.
 */
"use client";

import { useCallback, useState } from "react";
import { getAccount, getWalletClient, switchChain } from "wagmi/actions";
import {
  parseEventLogs,
  type Address,
  type Hex,
  type TransactionReceipt,
  type WriteContractParameters,
} from "viem";
import { activeChain } from "@/config/chains";
import { wagmiConfig } from "./wagmi";
import {
  ADDR,
  accumulatorAbi,
  controllerAbi,
  erc20Abi,
  portfolioMarketAbi,
  routerAbi,
  vaultAbi,
  takerSpender,
} from "./contracts";
import {
  buildTakerData,
  erc20Allowance,
  legDirection,
  publicClient,
  quoteExitExactIn,
  quoteIssueExactIn,
  quoteIssueExactOut,
  quoteSettleExactIn,
  readCheckpointProgress,
  readOrder,
} from "./chain";
import { BPS } from "./format";
import { Leg, maxSeriesLiability, type SeriesParams, type SeriesState } from "./series";
import {
  exitMode,
  issueMode,
  maxGroupLiability,
  receiptFor,
  settleMode,
  type GroupParams as PortfolioGroupParams,
  type GroupState,
  type Side,
} from "./portfolio";
import {
  portfolioIsAToB,
  quoteGroup,
  readGroupCheckpointProgress,
  readOrderFor,
} from "./portfolio-chain";

// ---------------------------------------------------------------- step model

export type TxPhase = "todo" | "preparing" | "confirm" | "pending" | "confirmed" | "skipped" | "failed" | "rejected";

export interface StepPlan {
  key: string;
  label: string;
  detail?: string;
}
export interface StepState extends StepPlan {
  phase: TxPhase;
  hash?: Hex;
  error?: string;
  note?: string;
}
export type Reporter = (key: string, patch: Partial<StepState>) => void;

export interface FlowCtx {
  account: Address;
  report: Reporter;
}

export function isUserRejection(e: unknown): boolean {
  const err = e as {
    code?: unknown;
    cause?: { code?: unknown; name?: string; cause?: { code?: unknown } };
    name?: string;
    shortMessage?: string;
    message?: string;
  };
  const code = err?.code ?? err?.cause?.code ?? err?.cause?.cause?.code;
  if (code === 4001 || code === "ACTION_REJECTED") return true;
  const name = err?.name ?? err?.cause?.name;
  if (name === "UserRejectedRequestError") return true;
  const msg = String(err?.shortMessage ?? err?.message ?? "");
  return /user rejected|user denied|rejected the request/i.test(msg);
}

export function errorMessage(e: unknown): string {
  const err = e as {
    shortMessage?: string;
    message?: string;
    cause?: { shortMessage?: string; message?: string; reason?: string };
  };
  return (
    err?.cause?.reason ??
    err?.shortMessage ??
    err?.cause?.shortMessage ??
    err?.message ??
    err?.cause?.message ??
    String(e)
  );
}

/** Simulate → wallet confirm → wait receipt, reporting each phase. */
async function sendTx(
  ctx: FlowCtx,
  key: string,
  simulate: () => Promise<{ request: unknown }>,
  onHash?: (hash: Hex) => void,
): Promise<TransactionReceipt> {
  ctx.report(key, { phase: "preparing", error: undefined });
  const { request } = await simulate();
  const wallet = await getWalletClient(wagmiConfig, { chainId: activeChain.id });
  ctx.report(key, { phase: "confirm" });
  const hash = await wallet.writeContract(request as WriteContractParameters);
  onHash?.(hash);
  ctx.report(key, { phase: "pending", hash });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") {
    ctx.report(key, { phase: "failed", error: "Transaction reverted" });
    throw new Error("Transaction reverted on-chain");
  }
  ctx.report(key, { phase: "confirmed" });
  return receipt;
}

async function ensureAllowance(
  ctx: FlowCtx,
  key: string,
  token: Address,
  spender: Address,
  needed: bigint,
): Promise<void> {
  ctx.report(key, { phase: "preparing" });
  const current = await erc20Allowance(token, ctx.account, spender);
  if (current >= needed) {
    ctx.report(key, { phase: "skipped", note: "Allowance already sufficient" });
    return;
  }
  await sendTx(ctx, key, () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, needed],
    }),
  );
}

const DEADLINE_SECONDS = 20 * 60;
const nowSec = (): number => Math.floor(Date.now() / 1000);
const clampSlippage = (bps: number): bigint => BigInt(Math.max(0, Math.min(5000, Math.round(bps))));

function swappedAmounts(receipt: TransactionReceipt): { amountIn: bigint; amountOut: bigint } | undefined {
  try {
    const logs = parseEventLogs({ abi: routerAbi, eventName: "Swapped", logs: receipt.logs });
    const l = logs[0];
    return l ? { amountIn: l.args.amountIn, amountOut: l.args.amountOut } : undefined;
  } catch {
    return undefined;
  }
}

/** What a swap flow reports back. `partial` means a clamp bound the fill below what was asked for. */
export interface SwapResult {
  hash: Hex;
  amountIn?: bigint;
  amountOut?: bigint;
  requested: bigint;
  partial: boolean;
}

// ---------------------------------------------------------------- writer: vault

export const CREATE_VAULT_PLAN: StepPlan[] = [
  {
    key: "createVault",
    label: "Create maker vault",
    detail: "A non-upgradeable vault at a deterministic address, owned by you",
  },
];

export async function runCreateVault(ctx: FlowCtx): Promise<{ hash: Hex; vault: Address }> {
  const receipt = await sendTx(ctx, "createVault", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.seriesFactory,
      abi: controllerAbi,
      functionName: "createVault",
    }),
  );
  const logs = parseEventLogs({ abi: controllerAbi, eventName: "VaultCreated", logs: receipt.logs });
  const vault =
    logs[0]?.args.vault ??
    (await publicClient.readContract({
      address: ADDR.seriesFactory,
      abi: controllerAbi,
      functionName: "vaultOf",
      args: [ctx.account],
    }));
  return { hash: receipt.transactionHash, vault };
}

export const DEPOSIT_PLAN: StepPlan[] = [
  { key: "approve", label: "Approve USDC", detail: "Allow your vault to pull the deposit" },
  { key: "deposit", label: "Fund the vault", detail: "Collateral the vault holds, not your wallet" },
];

export async function runDeposit(ctx: FlowCtx, vault: Address, amount: bigint): Promise<Hex> {
  if (amount <= 0n) throw new Error("Enter an amount to deposit");
  await ensureAllowance(ctx, "approve", ADDR.usdc, vault, amount);
  const receipt = await sendTx(ctx, "deposit", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: vault,
      abi: vaultAbi,
      functionName: "deposit",
      args: [amount],
    }),
  );
  return receipt.transactionHash;
}

export const WITHDRAW_FREE_PLAN: StepPlan[] = [
  {
    key: "withdraw",
    label: "Withdraw free collateral",
    detail: "Only what is not reserved for outstanding receipts",
  },
];

export async function runWithdrawFree(
  ctx: FlowCtx,
  vault: Address,
  amount: bigint,
  recipient: Address,
): Promise<Hex> {
  if (amount <= 0n) throw new Error("Enter an amount to withdraw");
  const receipt = await sendTx(ctx, "withdraw", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: vault,
      abi: vaultAbi,
      functionName: "withdrawFree",
      args: [amount, recipient],
    }),
  );
  return receipt.transactionHash;
}

// ---------------------------------------------------------------- writer: series

export const CREATE_SERIES_PLAN: StepPlan[] = [
  { key: "vault", label: "Maker vault", detail: "Created if you do not have one yet" },
  { key: "approve", label: "Approve USDC", detail: "Allow your vault to pull the collateral" },
  { key: "fund", label: "Fund the vault", detail: "Enough to back the whole inventory at the cap" },
  {
    key: "create",
    label: "Create and ship",
    detail: "Mints the receipts and ships ISSUE, EXIT and SETTLE to Aqua in one transaction",
  },
];

export interface CreateSeriesResult {
  id: bigint;
  receipt: Address;
  vault: Address;
  createHash: Hex;
}

/**
 * Persisted checkpoint for the create flow, so a page reload between "wallet confirmed" and "receipt
 * mined" resumes instead of creating a second series.
 *
 * The key is versioned (`tremor:v2:…`) on purpose: a v1 checkpoint describes a seller-as-maker series
 * against different contract addresses, and resuming one against v2 would be worse than starting over.
 */
interface CreateCheckpoint {
  account: Address;
  createHash: Hex;
  id?: string;
  receipt?: Address;
}

function createCheckpointKey(account: Address, vault: Address, p: SeriesParams): string {
  const values = [
    p.feed,
    p.quoteToken,
    p.start,
    p.expiry,
    p.saleEnd,
    p.sampleInterval,
    p.unitNotional.toString(),
    p.capVariance.toString(),
    p.anchorVariance.toString(),
    p.impactPerUnit.toString(),
    p.halfLife,
    p.halfSpreadBps,
    p.maxUnits.toString(),
  ];
  return `tremor:v2:create:${ADDR.chainId}:${ADDR.seriesFactory.toLowerCase()}:${account.toLowerCase()}:${vault.toLowerCase()}:${values.join(":")}`;
}

/** Drops any checkpoint written by an earlier design, once, so stale keys cannot accumulate. */
export function purgeLegacyCheckpoints(): void {
  if (typeof window === "undefined") return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith("tremor:write:")) doomed.push(key);
    }
    doomed.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* storage unavailable; nothing to clean */
  }
}

function loadCreateCheckpoint(key: string): CreateCheckpoint | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return undefined;
    return JSON.parse(raw) as CreateCheckpoint;
  } catch {
    window.localStorage.removeItem(key);
    return undefined;
  }
}

function saveCreateCheckpoint(key: string, value: CreateCheckpoint): void {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function createdSeries(receipt: TransactionReceipt): { id: bigint; receipt: Address } {
  const logs = parseEventLogs({ abi: controllerAbi, eventName: "SeriesCreated", logs: receipt.logs });
  const event = logs[0];
  if (!event) throw new Error("SeriesCreated event not found in receipt");
  return { id: event.args.seriesId, receipt: event.args.receipt };
}

export interface CreateSeriesInput {
  params: SeriesParams;
  /** The vault to write from. Omit to create or load the caller's own. */
  vault?: Address;
  /** Extra collateral to deposit on top of what the vault already holds free. */
  depositAmount?: bigint;
  backdatedDemo?: boolean;
}

export async function runCreateSeries(ctx: FlowCtx, input: CreateSeriesInput): Promise<CreateSeriesResult> {
  const { params } = input;

  // 1. The vault. `createVault` is idempotent on chain, so this is safe to call either way.
  ctx.report("vault", { phase: "preparing" });
  const existing = await publicClient.readContract({
    address: ADDR.seriesFactory,
    abi: controllerAbi,
    functionName: "vaultOf",
    args: [ctx.account],
  });
  let vault = input.vault ?? existing;
  if (!vault || vault === "0x0000000000000000000000000000000000000000") {
    const created = await runCreateVault(ctx);
    vault = created.vault;
  } else {
    ctx.report("vault", { phase: "skipped", note: `Using ${vault}` });
  }

  // 2. Collateral. A series can only sell its whole inventory if the vault can back it at the cap.
  const required = maxSeriesLiability(params);
  const free = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "freeQuote" });
  const shortfall = required > free ? required - free : 0n;
  const deposit = input.depositAmount !== undefined ? input.depositAmount : shortfall;
  if (deposit > 0n) {
    await ensureAllowance(ctx, "approve", params.quoteToken, vault, deposit);
    await sendTx(ctx, "fund", () =>
      publicClient.simulateContract({
        account: ctx.account,
        address: vault,
        abi: vaultAbi,
        functionName: "deposit",
        args: [deposit],
      }),
    );
  } else {
    ctx.report("approve", { phase: "skipped", note: "No deposit needed" });
    ctx.report("fund", { phase: "skipped", note: "The vault already backs this series" });
  }

  // 3. Create. This one transaction deploys the receipt, pins all three order hashes and ships all
  //    three Aqua strategies, so there is no window in which a series exists but cannot be traded.
  const key = createCheckpointKey(ctx.account, vault, params);
  let checkpoint = loadCreateCheckpoint(key);
  if (checkpoint && (checkpoint.id === undefined || checkpoint.receipt === undefined)) {
    ctx.report("create", {
      phase: "pending",
      hash: checkpoint.createHash,
      note: "Recovering the submitted creation transaction",
    });
    const recovered = await publicClient.waitForTransactionReceipt({
      hash: checkpoint.createHash,
      confirmations: 1,
    });
    if (recovered.status !== "success") {
      window.localStorage.removeItem(key);
      throw new Error("The saved creation transaction reverted; retrying will start a new series");
    }
    const found = createdSeries(recovered);
    checkpoint = { ...checkpoint, id: found.id.toString(), receipt: found.receipt };
    saveCreateCheckpoint(key, checkpoint);
    ctx.report("create", { phase: "confirmed", hash: checkpoint.createHash });
  }
  if (!checkpoint) {
    const fn = input.backdatedDemo ? "createBackdatedDemoSeries" : "createSeries";
    const created = await sendTx(
      ctx,
      "create",
      () =>
        publicClient.simulateContract({
          account: ctx.account,
          address: ADDR.seriesFactory,
          abi: controllerAbi,
          functionName: fn,
          args: [vault, params],
        }),
      (createHash) => saveCreateCheckpoint(key, { account: ctx.account, createHash }),
    );
    const found = createdSeries(created);
    checkpoint = {
      account: ctx.account,
      createHash: created.transactionHash,
      id: found.id.toString(),
      receipt: found.receipt,
    };
    saveCreateCheckpoint(key, checkpoint);
  }
  const { id, receipt: receiptToken, createHash } = checkpoint;
  if (id === undefined || receiptToken === undefined) throw new Error("Creation checkpoint is incomplete");
  ctx.report("create", { note: `Series #${id} · ${receiptToken}` });
  window.localStorage.removeItem(key);
  return { id: BigInt(id), receipt: receiptToken, vault, createHash };
}

export const STOP_ISSUANCE_PLAN: StepPlan[] = [
  {
    key: "stop",
    label: "Stop issuance",
    detail: "Permanently closes new sales. Exit and redemption stay open.",
  },
];

export async function runStopIssuance(ctx: FlowCtx, id: bigint): Promise<Hex> {
  const receipt = await sendTx(ctx, "stop", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.seriesFactory,
      abi: controllerAbi,
      functionName: "stopIssuance",
      args: [id],
    }),
  );
  return receipt.transactionHash;
}

export const CLOSE_SERIES_PLAN: StepPlan[] = [
  {
    key: "close",
    label: "Close series",
    detail: "Docks the strategies, burns unsold inventory, releases the residual",
  },
];

export async function runCloseSeries(ctx: FlowCtx, id: bigint): Promise<Hex> {
  const receipt = await sendTx(ctx, "close", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.seriesFactory,
      abi: controllerAbi,
      functionName: "closeSeries",
      args: [id],
    }),
  );
  return receipt.transactionHash;
}

// ---------------------------------------------------------------- holder: buy

export const BUY_PLAN: StepPlan[] = [
  { key: "approve", label: "Approve USDC", detail: "Allow the router to pull the premium" },
  { key: "swap", label: "Buy receipts", detail: "router.swap on the ISSUE leg" },
];

export interface BuyParams {
  state: SeriesState;
  mode: "exactIn" | "exactOut";
  /** Quote base units when exactIn, receipt units when exactOut. */
  amount: bigint;
  slippageBps: number;
}

/**
 * The ISSUE leg.
 *
 * The engine clamps a fill to whichever binds first: Aqua's receipt inventory, the vault's free
 * collateral, or the distance from the current ask to the cap. That is handled twice over:
 *
 *   1. the order is sized against a fresh quote, so the allowance and the threshold are quoted for a
 *      fill that can actually happen; and
 *   2. `allowPartialFill` is set, so if a clamp tightens between the quote and execution the swap
 *      fills small instead of reverting on TakerTraits' `takerAmount == amountIn/amountOut` check.
 *
 * Under partial fill the threshold is a limit rate — TakerTraits pro-rates it by the fraction filled —
 * so it is quoted against the taker amount sent, not against the clamped result.
 */
export async function runBuy(ctx: FlowCtx, p: BuyParams): Promise<SwapResult> {
  const id = p.state.id;
  const isExactIn = p.mode === "exactIn";
  const slip = clampSlippage(p.slippageBps);
  let takerAmount: bigint;
  let quoteNeeded: bigint;
  let threshold: bigint;

  if (isExactIn) {
    const q = await quoteIssueExactIn(id, p.amount);
    if (q.units === 0n) {
      throw new Error("This amount buys 0 units — the market is at its cap, sold out, or the amount is dust");
    }
    takerAmount = q.premium;
    quoteNeeded = q.premium;
    threshold = (q.units * (BPS - slip)) / BPS;
  } else {
    const q = await quoteIssueExactOut(id, p.amount);
    if (q.filledUnits === 0n) {
      throw new Error("No units available — the market is at its cap, sold out, or the vault is fully committed");
    }
    takerAmount = q.filledUnits;
    quoteNeeded = (q.premium * (BPS + slip)) / BPS;
    threshold = quoteNeeded;
  }
  const clamped = takerAmount < p.amount;
  await ensureAllowance(ctx, "approve", p.state.params.quoteToken, takerSpender(), quoteNeeded);

  ctx.report("swap", {
    phase: "preparing",
    note: clamped ? "Partial fill: sized to what the market can actually sell" : undefined,
  });
  const [order, isAToB] = await Promise.all([readOrder(id, Leg.Issue), legDirection(id, Leg.Issue)]);
  const takerData = await buildTakerData(ctx.account, isExactIn, isAToB, threshold, nowSec() + DEADLINE_SECONDS, true);
  const receipt = await sendTx(ctx, "swap", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.router,
      abi: routerAbi,
      functionName: "swap",
      args: [order, takerAmount, takerData],
    }),
  );
  const amounts = swappedAmounts(receipt);
  const filled = (isExactIn ? amounts?.amountIn : amounts?.amountOut) ?? takerAmount;
  return { hash: receipt.transactionHash, ...amounts, requested: p.amount, partial: filled < p.amount };
}

// ---------------------------------------------------------------- holder: exit

export const EXIT_PLAN: StepPlan[] = [
  { key: "approve", label: "Approve receipts", detail: "Allow the router to pull your receipts" },
  { key: "swap", label: "Sell at the bid", detail: "router.swap on the EXIT leg — the receipts are burned" },
];

export interface ExitParams {
  state: SeriesState;
  units: bigint;
  slippageBps: number;
}

/**
 * The EXIT leg: an executable bid before expiry.
 *
 * This is the leg v1 did not have. The proceeds are bounded by the liability that burning these
 * receipts releases, which is exactly what lets EXIT and SETTLE share one reserve: whichever leg
 * consumes a receipt, the receipt is gone.
 */
export async function runExit(ctx: FlowCtx, p: ExitParams): Promise<SwapResult> {
  const id = p.state.id;
  const slip = clampSlippage(p.slippageBps);
  const q = await quoteExitExactIn(id, p.units);
  if (q.filledUnits === 0n || q.quoteOut === 0n) throw new Error("The exit bid is zero for this size");
  const minOut = (q.quoteOut * (BPS - slip)) / BPS;
  await ensureAllowance(ctx, "approve", p.state.receipt, takerSpender(), q.filledUnits);

  ctx.report("swap", {
    phase: "preparing",
    note: q.filledUnits < p.units ? "Partial fill: sized to what is outstanding" : undefined,
  });
  const [order, isAToB] = await Promise.all([readOrder(id, Leg.Exit), legDirection(id, Leg.Exit)]);
  const takerData = await buildTakerData(ctx.account, true, isAToB, minOut, nowSec() + DEADLINE_SECONDS, true);
  const receipt = await sendTx(ctx, "swap", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.router,
      abi: routerAbi,
      functionName: "swap",
      args: [order, q.filledUnits, takerData],
    }),
  );
  const amounts = swappedAmounts(receipt);
  const filled = amounts?.amountIn ?? q.filledUnits;
  return { hash: receipt.transactionHash, ...amounts, requested: p.units, partial: filled < p.units };
}

// ---------------------------------------------------------------- holder: redeem

export const REDEEM_PLAN: StepPlan[] = [
  { key: "approve", label: "Approve receipts", detail: "Allow the router to pull your receipts" },
  { key: "swap", label: "Redeem at final variance", detail: "router.swap on the SETTLE leg" },
];

export interface RedeemParams {
  state: SeriesState;
  units: bigint;
  slippageBps: number;
}

export async function runRedeem(ctx: FlowCtx, p: RedeemParams): Promise<SwapResult> {
  const id = p.state.id;
  const slip = clampSlippage(p.slippageBps);
  const q = await quoteSettleExactIn(id, p.units);
  if (q.quoteOut === 0n) {
    throw new Error("This series finalized worthless; burn the receipts instead of redeeming them");
  }
  const minOut = (q.quoteOut * (BPS - slip)) / BPS;
  await ensureAllowance(ctx, "approve", p.state.receipt, takerSpender(), q.filledUnits);

  ctx.report("swap", { phase: "preparing" });
  const [order, isAToB] = await Promise.all([readOrder(id, Leg.Settle), legDirection(id, Leg.Settle)]);
  const takerData = await buildTakerData(ctx.account, true, isAToB, minOut, nowSec() + DEADLINE_SECONDS, true);
  const receipt = await sendTx(ctx, "swap", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.router,
      abi: routerAbi,
      functionName: "swap",
      args: [order, q.filledUnits, takerData],
    }),
  );
  const amounts = swappedAmounts(receipt);
  const filled = amounts?.amountIn ?? q.filledUnits;
  return { hash: receipt.transactionHash, ...amounts, requested: p.units, partial: filled < p.units };
}

export const BURN_WORTHLESS_PLAN: StepPlan[] = [
  {
    key: "burn",
    label: "Burn worthless receipts",
    detail: "A zero payout cannot go through SwapVM, which rejects a zero-output swap",
  },
];

export async function runBurnWorthless(ctx: FlowCtx, id: bigint, units: bigint): Promise<Hex> {
  if (units <= 0n) throw new Error("Enter the units to burn");
  const receipt = await sendTx(ctx, "burn", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.seriesFactory,
      abi: controllerAbi,
      functionName: "burnWorthless",
      args: [id, units],
    }),
  );
  return receipt.transactionHash;
}

// ---------------------------------------------------------------- anyone: the oracle

export const CHECKPOINT_PLAN: StepPlan[] = [
  {
    key: "checkpoint",
    label: "Update the market",
    detail: "Stores the Chainlink samples that have passed. Anyone can do this.",
  },
];

/**
 * Walks the observation window forward in bounded steps.
 *
 * `maxSamples` is capped by the accumulator itself (32), so a long window takes several transactions.
 * That is the point: v1 computed the whole window inside the first settlement, which made the first
 * redeemer pay for every sample and made a long window unsettleable at any gas price.
 */
export async function runCheckpoint(
  ctx: FlowCtx,
  id: bigint,
  maxSamples: number,
): Promise<{ hash: Hex; stored: number; available: number; done: boolean }> {
  const budget = Math.max(1, Math.min(32, Math.round(maxSamples)));
  const receipt = await sendTx(ctx, "checkpoint", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.accumulator,
      abi: accumulatorAbi,
      functionName: "checkpoint",
      args: [id, budget],
    }),
  );
  const after = await readCheckpointProgress(id);
  const done = after.stored >= after.available;
  ctx.report("checkpoint", {
    note: done
      ? `Window is current: ${after.stored} of ${after.total} samples`
      : `${after.stored} of ${after.available} samples stored — run it again`,
  });
  return { hash: receipt.transactionHash, stored: after.stored, available: after.available, done };
}

export const FINALIZE_PLAN: StepPlan[] = [
  {
    key: "finalize",
    label: "Finalize variance",
    detail: "Fixes the final realized variance and the payout. Anyone can do this.",
  },
];

export async function runFinalize(ctx: FlowCtx, id: bigint): Promise<Hex> {
  const receipt = await sendTx(ctx, "finalize", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.accumulator,
      abi: accumulatorAbi,
      functionName: "finalize",
      args: [id],
    }),
  );
  return receipt.transactionHash;
}

// ================================================================ portfolio ("paired markets")

// The group flows mirror the series flows above, against `TremorPortfolioMarket` and its own
// `VarianceAccumulator`. Trading goes through the same router; only the order source differs.

export const CREATE_GROUP_PLAN: StepPlan[] = [
  { key: "vault", label: "Maker vault", detail: "Created if you do not have one yet" },
  { key: "approve", label: "Approve USDC", detail: "Allow your vault to pull the collateral" },
  { key: "fund", label: "Fund the vault", detail: "Enough to back one full side at the cap" },
  {
    key: "create",
    label: "Create the paired market",
    detail: "Mints HIGH and CALM receipts and ships all six legs in one transaction",
  },
];

export interface CreateGroupInput {
  params: PortfolioGroupParams;
  vault?: Address;
  /** Extra collateral to deposit on top of what the vault already holds free. */
  depositAmount?: bigint;
  backdatedDemo?: boolean;
}

export interface CreateGroupResult {
  id: bigint;
  vault: Address;
  createHash: Hex;
}

export async function runCreateGroup(ctx: FlowCtx, input: CreateGroupInput): Promise<CreateGroupResult> {
  const { params } = input;

  // 1. The vault, from the portfolio market's own registry.
  ctx.report("vault", { phase: "preparing" });
  const existing = await publicClient.readContract({
    address: ADDR.portfolioMarket,
    abi: portfolioMarketAbi,
    functionName: "vaultOf",
    args: [ctx.account],
  });
  let vault = input.vault ?? existing;
  if (!vault || vault === "0x0000000000000000000000000000000000000000") {
    const receipt = await sendTx(ctx, "vault", () =>
      publicClient.simulateContract({
        account: ctx.account,
        address: ADDR.portfolioMarket,
        abi: portfolioMarketAbi,
        functionName: "createVault",
      }),
    );
    const logs = parseEventLogs({ abi: portfolioMarketAbi, eventName: "VaultCreated", logs: receipt.logs });
    vault =
      logs[0]?.args.vault ??
      (await publicClient.readContract({
        address: ADDR.portfolioMarket,
        abi: portfolioMarketAbi,
        functionName: "vaultOf",
        args: [ctx.account],
      }));
  } else {
    ctx.report("vault", { phase: "skipped", note: `Using ${vault}` });
  }

  // 2. Collateral. The reserve is max(high, calm)·S, so one full side at the cap backs the whole group.
  const required = maxGroupLiability(params);
  const free = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "freeQuote" });
  const shortfall = required > free ? required - free : 0n;
  const deposit = input.depositAmount !== undefined ? input.depositAmount : shortfall;
  if (deposit > 0n) {
    await ensureAllowance(ctx, "approve", params.quoteToken, vault, deposit);
    await sendTx(ctx, "fund", () =>
      publicClient.simulateContract({
        account: ctx.account,
        address: vault,
        abi: vaultAbi,
        functionName: "deposit",
        args: [deposit],
      }),
    );
  } else {
    ctx.report("approve", { phase: "skipped", note: "No deposit needed" });
    ctx.report("fund", { phase: "skipped", note: "The vault already backs this group" });
  }

  // 3. Create.
  const fn = input.backdatedDemo ? "createBackdatedDemoGroup" : "createGroup";
  const wire = {
    feed: params.feed,
    quoteToken: params.quoteToken,
    start: params.start,
    expiry: params.expiry,
    saleEnd: params.saleEnd,
    sampleInterval: params.sampleInterval,
    capVariance: params.capVariance,
    capPayoutPerUnit: params.capPayoutPerUnit,
    maxUnitsPerSide: params.maxUnitsPerSide,
    askHigh: params.askHigh,
    bidHigh: params.bidHigh,
    askCalm: params.askCalm,
    bidCalm: params.bidCalm,
  };
  const created = await sendTx(ctx, "create", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.portfolioMarket,
      abi: portfolioMarketAbi,
      functionName: fn,
      args: [vault, wire],
    }),
  );
  const logs = parseEventLogs({ abi: portfolioMarketAbi, eventName: "GroupCreated", logs: created.logs });
  const event = logs[0];
  if (!event) throw new Error("GroupCreated event not found in receipt");
  ctx.report("create", { note: `Group #${event.args.groupId.toString()}` });
  return { id: event.args.groupId, vault, createHash: created.transactionHash };
}

export const BUY_GROUP_PLAN: StepPlan[] = [
  { key: "approve", label: "Approve USDC", detail: "Allow the router to pull the premium" },
  { key: "swap", label: "Buy the side", detail: "router.swap on the group's ISSUE leg" },
];

export interface BuyGroupParams {
  group: GroupState;
  side: Side;
  /** Receipt units, exact-out. */
  units: bigint;
  slippageBps: number;
}

export async function runBuyGroup(ctx: FlowCtx, p: BuyGroupParams): Promise<SwapResult> {
  const slip = clampSlippage(p.slippageBps);
  // Re-quote on chain immediately before signing; the fixed ask is only ever a UI estimate.
  const q = await quoteGroup(p.group, "issue", p.side, false, p.units, ctx.account);
  if (q.amountOut === 0n) {
    throw new Error("No units available — the side is at its per-side cap or the sale has closed");
  }
  const takerAmount = q.amountOut; // clamped units the market can actually sell
  const maxIn = (q.amountIn * (BPS + slip)) / BPS;
  const clamped = takerAmount < p.units;
  await ensureAllowance(ctx, "approve", p.group.params.quoteToken, takerSpender(), maxIn);

  ctx.report("swap", {
    phase: "preparing",
    note: clamped ? "Partial fill: sized to what the market can actually sell" : undefined,
  });
  const mode = issueMode(p.side);
  const order = await readOrderFor(p.group.id, mode);
  const isAToB = portfolioIsAToB(mode, p.group.params.quoteToken, receiptFor(p.group, p.side));
  const takerData = await buildTakerData(ctx.account, false, isAToB, maxIn, nowSec() + DEADLINE_SECONDS, true);
  const receipt = await sendTx(ctx, "swap", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.router,
      abi: routerAbi,
      functionName: "swap",
      args: [order, takerAmount, takerData],
    }),
  );
  const amounts = swappedAmounts(receipt);
  const filled = amounts?.amountOut ?? takerAmount;
  return { hash: receipt.transactionHash, ...amounts, requested: p.units, partial: filled < p.units };
}

export const EXIT_GROUP_PLAN: StepPlan[] = [
  { key: "approve", label: "Approve receipts", detail: "Allow the router to pull your receipts" },
  { key: "swap", label: "Sell at the writer's bid", detail: "router.swap on the group's EXIT leg — the receipts are burned" },
];

export interface ExitGroupParams {
  group: GroupState;
  side: Side;
  units: bigint;
  slippageBps: number;
}

export async function runExitGroup(ctx: FlowCtx, p: ExitGroupParams): Promise<SwapResult> {
  const slip = clampSlippage(p.slippageBps);
  const q = await quoteGroup(p.group, "exit", p.side, true, p.units, ctx.account);
  if (q.amountOut === 0n) throw new Error("The exit bid is zero for this size");
  const minOut = (q.amountOut * (BPS - slip)) / BPS;
  const token = receiptFor(p.group, p.side);
  await ensureAllowance(ctx, "approve", token, takerSpender(), q.amountIn);

  ctx.report("swap", {
    phase: "preparing",
    note: q.amountIn < p.units ? "Partial fill: sized to what the exit liquidity can pay" : undefined,
  });
  const mode = exitMode(p.side);
  const order = await readOrderFor(p.group.id, mode);
  const isAToB = portfolioIsAToB(mode, p.group.params.quoteToken, token);
  const takerData = await buildTakerData(ctx.account, true, isAToB, minOut, nowSec() + DEADLINE_SECONDS, true);
  const receipt = await sendTx(ctx, "swap", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.router,
      abi: routerAbi,
      functionName: "swap",
      args: [order, q.amountIn, takerData],
    }),
  );
  const amounts = swappedAmounts(receipt);
  const filled = amounts?.amountIn ?? q.amountIn;
  return { hash: receipt.transactionHash, ...amounts, requested: p.units, partial: filled < p.units };
}

export const REDEEM_GROUP_PLAN: StepPlan[] = [
  { key: "approve", label: "Approve receipts", detail: "Allow the router to pull your receipts" },
  { key: "swap", label: "Redeem at the fixed payout", detail: "router.swap on the group's SETTLE leg" },
];

export async function runRedeemGroup(ctx: FlowCtx, p: ExitGroupParams): Promise<SwapResult> {
  const slip = clampSlippage(p.slippageBps);
  const q = await quoteGroup(p.group, "settle", p.side, true, p.units, ctx.account);
  if (q.amountOut === 0n) {
    throw new Error("This side finalized worthless; burn the receipts instead of redeeming them");
  }
  const minOut = (q.amountOut * (BPS - slip)) / BPS;
  const token = receiptFor(p.group, p.side);
  await ensureAllowance(ctx, "approve", token, takerSpender(), q.amountIn);

  ctx.report("swap", { phase: "preparing" });
  const mode = settleMode(p.side);
  const order = await readOrderFor(p.group.id, mode);
  const isAToB = portfolioIsAToB(mode, p.group.params.quoteToken, token);
  const takerData = await buildTakerData(ctx.account, true, isAToB, minOut, nowSec() + DEADLINE_SECONDS, true);
  const receipt = await sendTx(ctx, "swap", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.router,
      abi: routerAbi,
      functionName: "swap",
      args: [order, q.amountIn, takerData],
    }),
  );
  const amounts = swappedAmounts(receipt);
  const filled = amounts?.amountIn ?? q.amountIn;
  return { hash: receipt.transactionHash, ...amounts, requested: p.units, partial: filled < p.units };
}

// ---- exit buffer (writer-managed early-exit liquidity; settlement backing is untouched by all three)

export const ALLOCATE_EXIT_BUFFER_PLAN: StepPlan[] = [
  { key: "approve", label: "Approve USDC", detail: "Only if the vault needs a top-up first" },
  { key: "fund", label: "Fund the vault", detail: "Deposit any shortfall before allocating" },
  { key: "allocate", label: "Allocate exit buffer", detail: "Locks free vault collateral for early exits" },
];

export async function runAllocateExitBuffer(ctx: FlowCtx, groupId: bigint, vault: Address, amount: bigint): Promise<Hex> {
  if (amount <= 0n) throw new Error("Enter an amount to allocate");
  const free = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "freeQuote" });
  const shortfall = amount > free ? amount - free : 0n;
  if (shortfall > 0n) {
    await ensureAllowance(ctx, "approve", ADDR.usdc, vault, shortfall);
    await sendTx(ctx, "fund", () =>
      publicClient.simulateContract({
        account: ctx.account,
        address: vault,
        abi: vaultAbi,
        functionName: "deposit",
        args: [shortfall],
      }),
    );
  } else {
    ctx.report("approve", { phase: "skipped", note: "Vault already holds enough free collateral" });
    ctx.report("fund", { phase: "skipped", note: "No deposit needed" });
  }
  const receipt = await sendTx(ctx, "allocate", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.portfolioMarket,
      abi: portfolioMarketAbi,
      functionName: "allocateExitBuffer",
      args: [groupId, amount],
    }),
  );
  return receipt.transactionHash;
}

export const FUND_EXIT_BUFFER_PLAN: StepPlan[] = [
  { key: "approve", label: "Approve USDC", detail: "Allow the portfolio market to pull the funding" },
  { key: "fund", label: "Fund exit buffer", detail: "Anyone can add early-exit liquidity" },
];

export async function runFundExitBuffer(ctx: FlowCtx, groupId: bigint, amount: bigint): Promise<Hex> {
  if (amount <= 0n) throw new Error("Enter an amount to fund");
  await ensureAllowance(ctx, "approve", ADDR.usdc, ADDR.portfolioMarket, amount);
  const receipt = await sendTx(ctx, "fund", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.portfolioMarket,
      abi: portfolioMarketAbi,
      functionName: "fundExitBuffer",
      args: [groupId, amount],
    }),
  );
  return receipt.transactionHash;
}

export const WITHDRAW_EXIT_BUFFER_PLAN: StepPlan[] = [
  { key: "withdraw", label: "Withdraw exit buffer", detail: "Unused early-exit liquidity, back to the vault's free balance" },
];

export async function runWithdrawExitBuffer(ctx: FlowCtx, groupId: bigint, amount: bigint): Promise<Hex> {
  if (amount <= 0n) throw new Error("Enter an amount to withdraw");
  const receipt = await sendTx(ctx, "withdraw", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.portfolioMarket,
      abi: portfolioMarketAbi,
      functionName: "withdrawExitBuffer",
      args: [groupId, amount],
    }),
  );
  return receipt.transactionHash;
}

// ---- the group's own accumulator (permissionless, same shape as the series one)

export async function runGroupCheckpoint(
  ctx: FlowCtx,
  id: bigint,
  maxSamples: number,
): Promise<{ hash: Hex; stored: number; available: number; done: boolean }> {
  const budget = Math.max(1, Math.min(32, Math.round(maxSamples)));
  const receipt = await sendTx(ctx, "checkpoint", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.portfolioAccumulator,
      abi: accumulatorAbi,
      functionName: "checkpoint",
      args: [id, budget],
    }),
  );
  const after = await readGroupCheckpointProgress(id);
  const done = after.stored >= after.available;
  ctx.report("checkpoint", {
    note: done
      ? `Window is current: ${after.stored} of ${after.total} samples`
      : `${after.stored} of ${after.available} samples stored — run it again`,
  });
  return { hash: receipt.transactionHash, stored: after.stored, available: after.available, done };
}

export async function runGroupFinalize(ctx: FlowCtx, id: bigint): Promise<Hex> {
  const receipt = await sendTx(ctx, "finalize", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.portfolioAccumulator,
      abi: accumulatorAbi,
      functionName: "finalize",
      args: [id],
    }),
  );
  return receipt.transactionHash;
}

export const BURN_WORTHLESS_GROUP_PLAN: StepPlan[] = [
  {
    key: "burn",
    label: "Burn worthless receipts",
    detail: "A zero payout cannot go through SwapVM, which rejects a zero-output swap",
  },
];

export async function runBurnWorthlessGroup(ctx: FlowCtx, groupId: bigint, high: boolean, units: bigint): Promise<Hex> {
  if (units <= 0n) throw new Error("Enter the units to burn");
  const receipt = await sendTx(ctx, "burn", () =>
    publicClient.simulateContract({
      account: ctx.account,
      address: ADDR.portfolioMarket,
      abi: portfolioMarketAbi,
      functionName: "burnWorthless",
      args: [groupId, high, units],
    }),
  );
  return receipt.transactionHash;
}

// ---------------------------------------------------------------- hook

export interface TxFlow<R> {
  steps: StepState[];
  running: boolean;
  error?: string;
  result?: R;
  run: (fn: (ctx: FlowCtx) => Promise<R>) => Promise<R | undefined>;
  reset: () => void;
}

export function useTxFlow<R>(plan: StepPlan[]): TxFlow<R> {
  const fresh = useCallback((): StepState[] => plan.map((p) => ({ ...p, phase: "todo" })), [plan]);
  const [steps, setSteps] = useState<StepState[]>(() => plan.map((p) => ({ ...p, phase: "todo" })));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<R | undefined>();

  const report: Reporter = useCallback((key, patch) => {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }, []);

  const reset = useCallback(() => {
    setSteps(fresh());
    setError(undefined);
    setResult(undefined);
  }, [fresh]);

  const run = useCallback(
    async (fn: (ctx: FlowCtx) => Promise<R>): Promise<R | undefined> => {
      setSteps(fresh());
      setError(undefined);
      setResult(undefined);
      setRunning(true);
      try {
        const acct = getAccount(wagmiConfig);
        if (!acct.address) throw new Error("Connect a wallet first");
        if (ADDR.chainId !== activeChain.id) {
          throw new Error("Deployment manifest does not match the configured chain");
        }
        if (acct.chainId !== activeChain.id) {
          await switchChain(wagmiConfig, { chainId: activeChain.id });
        }
        const r = await fn({ account: acct.address, report });
        setResult(r);
        return r;
      } catch (e) {
        const rejected = isUserRejection(e);
        const msg = rejected ? "Rejected in wallet" : errorMessage(e);
        setSteps((prev) =>
          prev.map((s) =>
            s.phase === "preparing" || s.phase === "confirm" || s.phase === "pending"
              ? { ...s, phase: rejected ? "rejected" : "failed", error: msg }
              : s,
          ),
        );
        setError(msg);
        return undefined;
      } finally {
        setRunning(false);
      }
    },
    [fresh, report],
  );

  return { steps, running, error, result, run, reset };
}
