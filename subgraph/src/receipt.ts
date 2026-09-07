import { Address, BigInt, Bytes, dataSource } from "@graphprotocol/graph-ts";

import { Transfer } from "../generated/templates/Receipt/Receipt";
import { ReceiptBalance, ReceiptIndex, Series } from "../generated/schema";

const ZERO = Address.zero();

function balanceId(seriesId: string, account: Address): Bytes {
  return Bytes.fromUTF8(seriesId + ":" + account.toHexString());
}

/**
 * Loads an account's receipt balance, creating it at zero if this is its first transfer.
 *
 * The previous version constructed a fresh entity every time, so every transfer overwrote the balance
 * with a single delta instead of accumulating. Loading first is what makes a running balance actually
 * run.
 */
function balanceFor(seriesId: string, account: Address, receipt: Bytes): ReceiptBalance {
  const id = balanceId(seriesId, account);
  let balance = ReceiptBalance.load(id);
  if (balance === null) {
    balance = new ReceiptBalance(id);
    balance.series = seriesId;
    balance.account = account;
    balance.receipt = receipt;
    balance.units = BigInt.zero();
  }
  return balance as ReceiptBalance;
}

/**
 * Tracks receipt ownership, including mints (`from == 0`, the vault receiving its inventory) and burns
 * (`to == 0`, an exit or a settlement consuming a claim). Both burn legs end in a burn, which is what
 * makes exit and settlement mutually exclusive, so the zero-address transfers are the interesting ones.
 */
export function handleReceiptTransfer(event: Transfer): void {
  const receipt = dataSource.address();
  const index = ReceiptIndex.load(receipt);
  if (index === null) return;
  const series = Series.load(index.series);
  if (series === null) return;

  const amount = event.params.value;
  if (event.params.from != ZERO) {
    const from = balanceFor(series.id, event.params.from, receipt);
    from.units = from.units.minus(amount);
    from.updatedAt = event.block.timestamp;
    from.save();
  }
  if (event.params.to != ZERO) {
    const to = balanceFor(series.id, event.params.to, receipt);
    to.units = to.units.plus(amount);
    to.updatedAt = event.block.timestamp;
    to.save();
  }
}
