import { BigInt, Bytes } from "@graphprotocol/graph-ts";

import {
  GroupCreated,
  PortfolioIssued,
  PortfolioExited,
  PortfolioSettled,
  GroupFinalized,
  ExitBufferFunded,
  ExitBufferWithdrawn,
  WorthlessBurned,
} from "../generated/PortfolioMarket/PortfolioMarket";
import { PortfolioGroup, PortfolioEvent } from "../generated/schema";

const WAD: BigInt = BigInt.fromString("1000000000000000000");

function zero(): BigInt {
  return BigInt.fromI32(0);
}

/**
 * Floor division: floor(units * ppu / 1e18)
 * Exactly mirrors PortfolioMath.finalSideLiability / settleProceeds in TremorPortfolioMarket.sol.
 */
export function finalSideLiability(units: BigInt, ppu: BigInt): BigInt {
  return units.times(ppu).div(WAD);
}

export function handleGroupCreated(event: GroupCreated): void {
  const id = event.params.groupId.toString();
  const group = new PortfolioGroup(id);
  const p = event.params.params;

  group.groupId = event.params.groupId;
  group.writer = event.params.writer;
  group.vault = event.params.vault;
  group.highReceipt = event.params.highReceipt;
  group.calmReceipt = event.params.calmReceipt;
  group.feed = p.feed;
  group.quoteToken = p.quoteToken;
  group.start = p.start;
  group.expiry = p.expiry;
  group.saleEnd = p.saleEnd;
  group.sampleInterval = p.sampleInterval;
  group.capVariance = p.capVariance;
  group.capPayoutPerUnit = p.capPayoutPerUnit;
  group.maxUnitsPerSide = p.maxUnitsPerSide;
  group.askHigh = p.askHigh;
  group.bidHigh = p.bidHigh;
  group.askCalm = p.askCalm;
  group.bidCalm = p.bidCalm;

  group.highOutstanding = zero();
  group.calmOutstanding = zero();
  group.reserveLocked = zero();
  group.exitBuffer = zero();
  group.finalized = false;

  group.createdBlock = event.block.number;
  group.createdTx = event.transaction.hash;
  group.createdAt = event.block.timestamp;
  group.updatedAt = event.block.timestamp;

  group.save();

  const evId = event.transaction.hash.concatI32(event.logIndex.toI32());
  const ev = new PortfolioEvent(evId);
  ev.group = id;
  ev.eventType = "group_created";
  ev.actor = event.params.writer;
  ev.units = zero();
  ev.amount = zero();
  ev.blockNumber = event.block.number;
  ev.txHash = event.transaction.hash;
  ev.logIndex = event.logIndex;
  ev.timestamp = event.block.timestamp;
  ev.save();
}

export function handlePortfolioIssued(event: PortfolioIssued): void {
  const id = event.params.groupId.toString();
  const group = PortfolioGroup.load(id);
  if (group == null) return;

  group.highOutstanding = event.params.highOutstanding;
  group.calmOutstanding = event.params.calmOutstanding;
  group.reserveLocked = event.params.reserveLocked;
  group.updatedAt = event.block.timestamp;
  group.save();

  const evId = event.transaction.hash.concatI32(event.logIndex.toI32());
  const ev = new PortfolioEvent(evId);
  ev.group = id;
  ev.eventType = "issued";
  ev.actor = event.params.buyer;
  ev.side = event.params.high ? "high" : "calm";
  ev.units = event.params.units;
  ev.amount = event.params.premium;
  ev.newOutstanding = event.params.high ? event.params.highOutstanding : event.params.calmOutstanding;
  ev.newReserve = event.params.reserveLocked;
  ev.blockNumber = event.block.number;
  ev.txHash = event.transaction.hash;
  ev.logIndex = event.logIndex;
  ev.timestamp = event.block.timestamp;
  ev.save();
}

export function handlePortfolioExited(event: PortfolioExited): void {
  const id = event.params.groupId.toString();
  const group = PortfolioGroup.load(id);
  if (group == null) return;

  if (event.params.high) {
    group.highOutstanding = group.highOutstanding.minus(event.params.units);
  } else {
    group.calmOutstanding = group.calmOutstanding.minus(event.params.units);
  }
  group.reserveLocked = event.params.reserveLocked;
  if (event.params.bufferDrawn.gt(zero())) {
    group.exitBuffer = group.exitBuffer.minus(event.params.bufferDrawn);
  }
  group.updatedAt = event.block.timestamp;
  group.save();

  const evId = event.transaction.hash.concatI32(event.logIndex.toI32());
  const ev = new PortfolioEvent(evId);
  ev.group = id;
  ev.eventType = "exited";
  ev.actor = event.params.holder;
  ev.side = event.params.high ? "high" : "calm";
  ev.units = event.params.units;
  ev.amount = event.params.amountOut;
  ev.newOutstanding = event.params.high ? group.highOutstanding : group.calmOutstanding;
  ev.newReserve = event.params.reserveLocked;
  ev.newBuffer = group.exitBuffer;
  ev.blockNumber = event.block.number;
  ev.txHash = event.transaction.hash;
  ev.logIndex = event.logIndex;
  ev.timestamp = event.block.timestamp;
  ev.save();
}

export function handlePortfolioSettled(event: PortfolioSettled): void {
  const id = event.params.groupId.toString();
  const group = PortfolioGroup.load(id);
  if (group == null) return;

  if (event.params.high) {
    group.highOutstanding = group.highOutstanding.minus(event.params.units);
  } else {
    group.calmOutstanding = group.calmOutstanding.minus(event.params.units);
  }
  group.reserveLocked = event.params.reserveLocked;
  group.updatedAt = event.block.timestamp;
  group.save();

  const evId = event.transaction.hash.concatI32(event.logIndex.toI32());
  const ev = new PortfolioEvent(evId);
  ev.group = id;
  ev.eventType = "settled";
  ev.actor = event.params.holder;
  ev.side = event.params.high ? "high" : "calm";
  ev.units = event.params.units;
  ev.amount = event.params.amountOut;
  ev.newOutstanding = event.params.high ? group.highOutstanding : group.calmOutstanding;
  ev.newReserve = event.params.reserveLocked;
  ev.blockNumber = event.block.number;
  ev.txHash = event.transaction.hash;
  ev.logIndex = event.logIndex;
  ev.timestamp = event.block.timestamp;
  ev.save();
}

export function handleGroupFinalized(event: GroupFinalized): void {
  const id = event.params.groupId.toString();
  const group = PortfolioGroup.load(id);
  if (group == null) return;

  group.finalized = true;
  group.finalVariance = event.params.finalVariance;
  group.highPpu = event.params.highPayoutPerUnit;
  group.calmPpu = event.params.calmPayoutPerUnit;

  // Exact contract logic from onFinalize in TremorPortfolioMarket.sol:
  // uint256 newLocked = finalSideLiability(highOutstanding, hp) + finalSideLiability(calmOutstanding, cp);
  // g.reserveLocked = newLocked;
  // g.exitBuffer = 0;
  const highLiability = finalSideLiability(group.highOutstanding, event.params.highPayoutPerUnit);
  const calmLiability = finalSideLiability(group.calmOutstanding, event.params.calmPayoutPerUnit);
  group.reserveLocked = highLiability.plus(calmLiability);
  group.exitBuffer = zero();

  group.updatedAt = event.block.timestamp;
  group.save();

  const evId = event.transaction.hash.concatI32(event.logIndex.toI32());
  const ev = new PortfolioEvent(evId);
  ev.group = id;
  ev.eventType = "finalized";
  ev.units = zero();
  // releasedCollateral is the collateral released to the writer, NOT remaining reserve
  ev.amount = event.params.releasedCollateral;
  ev.newReserve = group.reserveLocked;
  ev.newBuffer = zero();
  ev.blockNumber = event.block.number;
  ev.txHash = event.transaction.hash;
  ev.logIndex = event.logIndex;
  ev.timestamp = event.block.timestamp;
  ev.save();
}

export function handleExitBufferFunded(event: ExitBufferFunded): void {
  const id = event.params.groupId.toString();
  const group = PortfolioGroup.load(id);
  if (group == null) return;

  group.exitBuffer = event.params.newBuffer;
  group.updatedAt = event.block.timestamp;
  group.save();

  const evId = event.transaction.hash.concatI32(event.logIndex.toI32());
  const ev = new PortfolioEvent(evId);
  ev.group = id;
  ev.eventType = "buffer_funded";
  ev.actor = event.params.payer;
  ev.units = zero();
  ev.amount = event.params.amount;
  ev.newBuffer = event.params.newBuffer;
  ev.blockNumber = event.block.number;
  ev.txHash = event.transaction.hash;
  ev.logIndex = event.logIndex;
  ev.timestamp = event.block.timestamp;
  ev.save();
}

export function handleExitBufferWithdrawn(event: ExitBufferWithdrawn): void {
  const id = event.params.groupId.toString();
  const group = PortfolioGroup.load(id);
  if (group == null) return;

  group.exitBuffer = event.params.newBuffer;
  group.updatedAt = event.block.timestamp;
  group.save();

  const evId = event.transaction.hash.concatI32(event.logIndex.toI32());
  const ev = new PortfolioEvent(evId);
  ev.group = id;
  ev.eventType = "buffer_withdrawn";
  ev.units = zero();
  ev.amount = event.params.amount;
  ev.newBuffer = event.params.newBuffer;
  ev.blockNumber = event.block.number;
  ev.txHash = event.transaction.hash;
  ev.logIndex = event.logIndex;
  ev.timestamp = event.block.timestamp;
  ev.save();
}

export function handleWorthlessBurned(event: WorthlessBurned): void {
  const id = event.params.groupId.toString();
  const group = PortfolioGroup.load(id);
  if (group != null) {
    if (event.params.high) {
      group.highOutstanding = group.highOutstanding.minus(event.params.units);
    } else {
      group.calmOutstanding = group.calmOutstanding.minus(event.params.units);
    }
    group.updatedAt = event.block.timestamp;
    group.save();
  }

  const evId = event.transaction.hash.concatI32(event.logIndex.toI32());
  const ev = new PortfolioEvent(evId);
  ev.group = id;
  ev.eventType = "worthless_burned";
  ev.actor = event.params.holder;
  ev.side = event.params.high ? "high" : "calm";
  ev.units = event.params.units;
  ev.amount = zero();
  if (group != null) {
    ev.newOutstanding = event.params.high ? group.highOutstanding : group.calmOutstanding;
  }
  ev.blockNumber = event.block.number;
  ev.txHash = event.transaction.hash;
  ev.logIndex = event.logIndex;
  ev.timestamp = event.block.timestamp;
  ev.save();
}
