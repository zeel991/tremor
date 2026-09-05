import { Checkpointed } from "../generated/Accumulator/Accumulator";
import { Checkpoint, Series } from "../generated/schema";
import { logId } from "./shared";

/**
 * One bounded step of the observation window. `caller` is recorded because checkpointing is
 * permissionless: the history of who moved the window forward is part of the evidence that nobody
 * had to be trusted to.
 */
export function handleCheckpointed(event: Checkpointed): void {
  const id = event.params.seriesId.toString();
  const series = Series.load(id);
  if (series === null) return;

  const c = new Checkpoint(logId(event.transaction.hash, event.logIndex));
  c.series = id;
  c.fromSample = event.params.fromSample;
  c.toSample = event.params.toSample;
  c.processedThrough = event.params.processedThrough;
  c.lastRoundId = event.params.lastRoundId;
  c.sumSquaredReturns = event.params.sumSquaredReturnsWad;
  c.caller = event.transaction.from;
  c.timestamp = event.block.timestamp;
  c.block = event.block.number;
  c.transactionHash = event.transaction.hash;
  c.save();

  series.processedThrough = c.processedThrough;
  series.lastRoundId = event.params.lastRoundId;
  series.save();
}
