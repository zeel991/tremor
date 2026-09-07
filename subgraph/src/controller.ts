import { BigInt, Bytes } from "@graphprotocol/graph-ts";

import { Receipt, Vault as VaultTemplate } from "../generated/templates";
import {
  Exited,
  Finalized,
  Issued,
  IssuanceStopped,
  SeriesClosed,
  SeriesCreated,
  Settled,
  VaultCreated,
  WorthlessBurned,
} from "../generated/Controller/Controller";
import { Finalization, Order, ReceiptIndex, Series, Vault } from "../generated/schema";
import { LEG_EXIT, LEG_ISSUE, LEG_SETTLE, zero } from "./shared";

/**
 * A writer's protected maker vault. The template is started here so every later deposit, withdrawal
 * and lock change on that vault is indexed, which is what makes the writer page's history real
 * rather than a reconstruction.
 */
export function handleVaultCreated(event: VaultCreated): void {
  const vault = new Vault(event.params.vault);
  vault.writer = event.params.writer;
  vault.quoteToken = event.params.quoteToken;
  vault.createdAt = event.block.timestamp;
  vault.createdBlock = event.block.number;
  vault.transactionHash = event.transaction.hash;
  vault.totalDeposited = zero();
  vault.totalWithdrawn = zero();
  vault.lastReportedBalance = zero();
  vault.lastReportedLocked = zero();
  vault.updatedAt = event.block.timestamp;
  vault.save();
  VaultTemplate.create(event.params.vault);
}

export function handleSeriesCreated(event: SeriesCreated): void {
  const id = event.params.seriesId.toString();
  const series = new Series(id);
  const p = event.params.params;
  series.writer = event.params.writer;
  series.vault = event.params.vault;
  series.receipt = event.params.receipt;
  series.quoteToken = p.quoteToken;
  series.feed = p.feed;
  series.issueOrderHash = event.params.issueOrderHash;
  series.exitOrderHash = event.params.exitOrderHash;
  series.settlementOrderHash = event.params.settlementOrderHash;
  series.start = p.start;
  series.expiry = p.expiry;
  series.saleEnd = p.saleEnd;
  series.sampleInterval = p.sampleInterval;
  series.unitNotional = p.unitNotional;
  series.capVariance = p.capVariance;
  series.anchorVariance = p.anchorVariance;
  series.impactPerUnit = p.impactPerUnit;
  series.halfLife = p.halfLife;
  series.halfSpreadBps = BigInt.fromI32(p.halfSpreadBps);
  series.maxUnits = p.maxUnits;
  series.createdAt = event.block.timestamp;
  series.createdBlock = event.block.number;
  series.transactionHash = event.transaction.hash;
  series.unitsIssued = zero();
  series.unitsExited = zero();
  series.unitsSettled = zero();
  series.unitsBurnedWorthless = zero();
  series.premiumCollected = zero();
  series.exitPaid = zero();
  series.settlementPaid = zero();
  series.lastReportedOutstanding = zero();
  series.lastReportedLocked = zero();
  series.processedThrough = p.start;
  series.lastRoundId = zero();
  series.save();

  // All three legs, keyed by the Aqua strategy hash so a `Swapped` can be attributed to one of them.
  saveOrder(event.params.issueOrderHash, id, LEG_ISSUE, event.params.vault);
  saveOrder(event.params.exitOrderHash, id, LEG_EXIT, event.params.vault);
  saveOrder(event.params.settlementOrderHash, id, LEG_SETTLE, event.params.vault);

  const index = new ReceiptIndex(event.params.receipt);
  index.series = id;
  index.save();
  Receipt.create(event.params.receipt);
}

function saveOrder(hash: Bytes, seriesId: string, leg: string, maker: Bytes): void {
  const order = new Order(hash);
  order.series = seriesId;
  order.leg = leg;
  order.maker = maker;
  order.save();
}

export function handleIssued(event: Issued): void {
  const series = Series.load(event.params.seriesId.toString());
  if (series === null) return;
  series.unitsIssued = series.unitsIssued.plus(event.params.units);
  series.premiumCollected = series.premiumCollected.plus(event.params.premium);
  series.lastReportedOutstanding = event.params.newOutstanding;
  series.lastReportedLocked = event.params.newLocked;
  series.save();
}

export function handleExited(event: Exited): void {
  const series = Series.load(event.params.seriesId.toString());
  if (series === null) return;
  series.unitsExited = series.unitsExited.plus(event.params.units);
  series.exitPaid = series.exitPaid.plus(event.params.amountOut);
  series.lastReportedOutstanding = event.params.newOutstanding;
  series.lastReportedLocked = event.params.newLocked;
  series.save();
}

export function handleSettled(event: Settled): void {
  const series = Series.load(event.params.seriesId.toString());
  if (series === null) return;
  series.unitsSettled = series.unitsSettled.plus(event.params.units);
  series.settlementPaid = series.settlementPaid.plus(event.params.amountOut);
  series.lastReportedOutstanding = event.params.newOutstanding;
  series.lastReportedLocked = event.params.newLocked;
  series.save();
}

export function handleWorthlessBurned(event: WorthlessBurned): void {
  const series = Series.load(event.params.seriesId.toString());
  if (series === null) return;
  series.unitsBurnedWorthless = series.unitsBurnedWorthless.plus(event.params.units);
  series.lastReportedOutstanding = series.lastReportedOutstanding.minus(event.params.units);
  series.save();
}

export function handleFinalized(event: Finalized): void {
  const id = event.params.seriesId.toString();
  const series = Series.load(id);
  if (series === null) return;
  const f = new Finalization(id);
  f.series = id;
  f.finalVariance = event.params.finalVariance;
  f.cappedVariance = event.params.cappedVariance;
  f.payoutPerUnit = event.params.payoutPerUnit;
  f.outstandingUnits = event.params.outstandingUnits;
  f.releasedCollateral = event.params.releasedCollateral;
  // Whoever paid for the transaction. Finalization is permissionless, so this is worth recording:
  // it is the evidence that no privileged key was involved.
  f.caller = event.transaction.from;
  f.timestamp = event.block.timestamp;
  f.block = event.block.number;
  f.transactionHash = event.transaction.hash;
  f.save();

  series.finalization = id;
  series.lastReportedLocked = series.lastReportedLocked.minus(event.params.releasedCollateral);
  series.save();
}

export function handleIssuanceStopped(event: IssuanceStopped): void {
  const series = Series.load(event.params.seriesId.toString());
  if (series === null) return;
  series.issuanceStoppedAt = event.block.timestamp;
  series.save();
}

export function handleSeriesClosed(event: SeriesClosed): void {
  const series = Series.load(event.params.seriesId.toString());
  if (series === null) return;
  series.closedAt = event.block.timestamp;
  series.lastReportedLocked = zero();
  series.save();
}
