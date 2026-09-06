import { BigInt, Bytes } from "@graphprotocol/graph-ts";

export const LEG_ISSUE = "issue";
export const LEG_EXIT = "exit";
export const LEG_SETTLE = "settle";

/** A per-log identity that is unique across the whole subgraph. */
export function logId(txHash: Bytes, logIndex: BigInt): Bytes {
  return txHash.concatI32(logIndex.toI32());
}

export function zero(): BigInt {
  return BigInt.zero();
}
