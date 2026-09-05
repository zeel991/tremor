import { MechanismFigure } from "./MechanismFigure";

type FigureKind = "write" | "buy" | "settle" | "hedge";

const STEPS: Array<{ n: string; kind: FigureKind; title: string; scene: string; caption: string; body: string; code: string }> = [
  {
    n: "01",
    kind: "write",
    title: "Write",
    scene: "Three strategies, one vault",
    caption: "one transaction · no admin, no upgrade path",
    body: "createSeries deploys the receipt, mints the inventory into the writer's own vault and ships ISSUE, EXIT and SETTLE to 1inch Aqua — all in one transaction. The writer never approves Aqua and never ships anything themselves.",
    code: "factory.createSeries(vault, params)",
  },
  {
    n: "02",
    kind: "buy",
    title: "Buy",
    scene: "A bid and an ask, both executable",
    caption: "skew per fill · half-life decay · capped",
    body: "The market quotes both sides around what it projects for the window. Buying lifts the quote, exiting lowers it, and the skew decays back on a half-life. Every unit sold reserves its capped payout in the vault before the fill can settle.",
    code: "premium = N·(ask·u + slope·u²/2)",
  },
  {
    n: "03",
    kind: "settle",
    title: "Settle",
    scene: "Variance is a sum of squares",
    caption: "RV = Σ ln(Pᵢ/Pᵢ₋₁)² · 365d/T",
    body: "Anyone walks the window forward in bounded permissionless checkpoints, and anyone finalizes it. Then every receipt redeems for unitNotional·min(RV, cap) — no keeper, no deadline, nothing needed from the writer.",
    code: "RV = Σ ln(Pᵢ/Pᵢ₋₁)² · 365d / T",
  },
  {
    n: "04",
    kind: "hedge",
    title: "Hedge",
    scene: "Gross variance estimate",
    caption: "V·σ²·T/8 compared with a capped payout",
    body: "Estimate the gross LVR variance notional from pool value and horizon, then compare the executable cost and the available depth. Premium, the cap, discrete expiries and oracle basis keep it from being an exact hedge.",
    code: "units = (V·T/8) / unitNotional",
  },
];

/** Four principle cards with protocol-specific diagrams and a large step numeral outside, bottom-right. */
export function HowItWorks() {
  return (
    <div className="grid gap-x-10 gap-y-10 md:grid-cols-2">
      {STEPS.map((s, i) => (
        <div key={s.n} className={`grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4 ${i % 2 === 1 ? "md:mt-10" : ""}`}>
          <article className="card card-2 flex flex-col gap-5">
            <h3 className="h-card">{s.title}</h3>
            <div className="flex flex-col gap-2">
              <MechanismFigure kind={s.kind} />
              <div className="flex items-baseline justify-between gap-3">
                <span className="ornament-title">{s.scene}</span>
                <span className="ornament-caption text-right">{s.caption}</span>
              </div>
            </div>
            <p className="body">{s.body}</p>
            <code className="mono text-[12px] text-ink-3">{s.code}</code>
          </article>
          <span className="step-num" aria-hidden="true">
            {s.n}
          </span>
        </div>
      ))}
    </div>
  );
}
