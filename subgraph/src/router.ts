import { Swapped } from "../generated/Router/Router";
import { Fill, Order } from "../generated/schema";
import { LEG_ISSUE, logId } from "./shared";

/**
 * A fill of one of a series' three legs, attributed by order hash.
 *
 * `units` is always the receipt side and `quoteAmount` always the quote side. ISSUE takes the quote
 * token in; EXIT and SETTLE take receipts in and pay the quote token out. Normalising here means a
 * client charting a price never has to know which leg it is looking at.
 */
export function handleSwapped(event: Swapped): void {
  const order = Order.load(event.params.orderHash);
  if (order === null) return;

  const fill = new Fill(logId(event.transaction.hash, event.logIndex));
  fill.series = order.series;
  fill.orderHash = event.params.orderHash;
  fill.leg = order.leg;
  fill.makerVault = event.params.maker;
  fill.taker = event.params.taker;
  fill.tokenIn = event.params.tokenIn;
  fill.tokenOut = event.params.tokenOut;
  fill.amountIn = event.params.amountIn;
  fill.amountOut = event.params.amountOut;
  if (order.leg == LEG_ISSUE) {
    fill.quoteAmount = event.params.amountIn;
    fill.units = event.params.amountOut;
  } else {
    fill.units = event.params.amountIn;
    fill.quoteAmount = event.params.amountOut;
  }
  fill.timestamp = event.block.timestamp;
  fill.block = event.block.number;
  fill.transactionHash = event.transaction.hash;
  fill.save();
}
