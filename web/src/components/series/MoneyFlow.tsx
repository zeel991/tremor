import { useId } from "react";

const STEPS = [
  ["01", "Writer funds a vault"],
  ["02", "Three strategies ship to Aqua"],
  ["03", "Buyer pays the ask"],
  ["04", "Collateral locks at the cap"],
  ["05", "Anyone checkpoints the window"],
  ["06", "Anyone finalizes the variance"],
  ["07", "Holder exits or redeems"],
  ["08", "Receipts burn, collateral frees"],
] as const;

/**
 * A plain-language lifecycle map, in the order the money actually moves.
 *
 * It describes primary issuance and the two burn paths. It is not an order book: there is one maker per
 * series — the writer's vault — and no matching engine anywhere.
 */
export function MoneyFlow() {
  const id = useId();
  return (
    <section className="money-flow card" aria-labelledby={`${id}-title`}>
      <div className="card-head">
        <div>
          <h2 id={`${id}-title`} className="h-card">
            How this receipt pays
          </h2>
          <p className="card-meta">One maker, three legs, two ways a receipt can be burned</p>
        </div>
      </div>
      <ol className="money-flow-steps">
        {STEPS.map(([number, label], index) => (
          <li key={number}>
            <span className="money-flow-number">{number}</span>
            <span>{label}</span>
            {index < STEPS.length - 1 ? (
              <span className="money-flow-arrow" aria-hidden="true">
                →
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <details className="money-flow-details">
        <summary>Technical details</summary>
        <div className="money-flow-opcodes">
          <span>
            <code>0x02</code> Salt
          </span>
          <span>
            <code>0x20</code> Deadline
          </span>
          <span>
            <code>0x04</code> Extruction → TremorMarketEngine
          </span>
        </div>
        <p>
          Three stock SwapVM instructions, no custom opcodes: Tremor&apos;s pricing lives behind the
          built-in <code>Extruction</code>, which is why these programs run on the unmodified official
          <code>AquaSwapVMRouter</code>. EXIT and SETTLE additionally carry a <code>postTransferIn</code>{" "}
          hook on the receipt, and that burn is the only thing that releases the writer&apos;s collateral.
        </p>
      </details>
    </section>
  );
}
