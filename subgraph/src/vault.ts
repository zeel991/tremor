import { BigInt, Bytes, dataSource } from "@graphprotocol/graph-ts";

import {
  Deposited,
  FreeWithdrawn,
  LockedDecreased,
  LockedIncreased,
  ReceiptRegistered,
  StrategyDocked,
  StrategyShipped,
} from "../generated/templates/Vault/Vault";
import { Vault, VaultAction } from "../generated/schema";
import { logId } from "./shared";

/**
 * Records one vault event and folds it into the vault's running totals.
 *
 * The totals are indexed history, not a live read: a client that needs the current balance, lock and
 * free collateral asks `TremorLens`, which reads the vault itself. What this gives is the trail — who
 * funded the vault, what the writer took out, and when each lock moved.
 */
function record(
  kind: string,
  txHash: Bytes,
  logIndex: BigInt,
  timestamp: BigInt,
  block: BigInt,
  actor: Bytes | null,
  amount: BigInt | null,
  balance: BigInt | null,
  locked: BigInt | null,
  reference: Bytes | null,
): void {
  const address = dataSource.address();
  const vault = Vault.load(address);
  if (vault === null) return;

  const action = new VaultAction(logId(txHash, logIndex));
  action.vault = address;
  action.kind = kind;
  action.actor = actor;
  action.amount = amount;
  action.balance = balance;
  action.locked = locked;
  action.reference = reference;
  action.timestamp = timestamp;
  action.block = block;
  action.transactionHash = txHash;
  action.save();

  if (balance !== null) vault.lastReportedBalance = balance as BigInt;
  if (locked !== null) vault.lastReportedLocked = locked as BigInt;
  vault.updatedAt = timestamp;
  vault.save();
}

export function handleDeposited(event: Deposited): void {
  const vault = Vault.load(dataSource.address());
  if (vault !== null) {
    vault.totalDeposited = vault.totalDeposited.plus(event.params.amount);
    vault.save();
  }
  record(
    "deposited",
    event.transaction.hash,
    event.logIndex,
    event.block.timestamp,
    event.block.number,
    event.params.payer,
    event.params.amount,
    event.params.newBalance,
    event.params.lockedBalance,
    null,
  );
}

export function handleFreeWithdrawn(event: FreeWithdrawn): void {
  const vault = Vault.load(dataSource.address());
  if (vault !== null) {
    vault.totalWithdrawn = vault.totalWithdrawn.plus(event.params.amount);
    vault.save();
  }
  record(
    "freeWithdrawn",
    event.transaction.hash,
    event.logIndex,
    event.block.timestamp,
    event.block.number,
    event.params.recipient,
    event.params.amount,
    event.params.newBalance,
    event.params.lockedBalance,
    null,
  );
}

export function handleLockedIncreased(event: LockedIncreased): void {
  record(
    "lockedIncreased",
    event.transaction.hash,
    event.logIndex,
    event.block.timestamp,
    event.block.number,
    null,
    event.params.amount,
    null,
    event.params.lockedBalance,
    null,
  );
}

export function handleLockedDecreased(event: LockedDecreased): void {
  record(
    "lockedDecreased",
    event.transaction.hash,
    event.logIndex,
    event.block.timestamp,
    event.block.number,
    null,
    event.params.amount,
    null,
    event.params.lockedBalance,
    null,
  );
}

export function handleReceiptRegistered(event: ReceiptRegistered): void {
  record(
    "receiptRegistered",
    event.transaction.hash,
    event.logIndex,
    event.block.timestamp,
    event.block.number,
    null,
    null,
    null,
    null,
    event.params.receipt,
  );
}

export function handleStrategyShipped(event: StrategyShipped): void {
  record(
    "strategyShipped",
    event.transaction.hash,
    event.logIndex,
    event.block.timestamp,
    event.block.number,
    null,
    null,
    null,
    null,
    event.params.strategyHash,
  );
}

export function handleStrategyDocked(event: StrategyDocked): void {
  record(
    "strategyDocked",
    event.transaction.hash,
    event.logIndex,
    event.block.timestamp,
    event.block.number,
    null,
    null,
    null,
    null,
    event.params.strategyHash,
  );
}
