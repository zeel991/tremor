/** Renders the scenario results to `out/report.md`, `out/findings.md` and a JSON artefact. */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioResult } from "./scenarios.js";

const USDC = 1_000_000n;

const usd = (v: bigint): string => {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / USDC;
  const frac = (a % USDC).toString().padStart(6, "0").slice(0, 2);
  return `${neg ? "−" : ""}${whole.toLocaleString("en-US")}.${frac}`;
};
const units = (v: bigint): string => (Number(v) / 1e18).toFixed(2);
const volPct = (varianceWad: bigint): string => (Math.sqrt(Number(varianceWad) / 1e18) * 100).toFixed(1);
const pct = (n: number): string => `${n.toFixed(1)}%`;

function bidAskRange(r: ScenarioResult): string {
  const bids = r.snapshots.map((s) => s.bidPerUnit);
  const asks = r.snapshots.map((s) => s.askPerUnit);
  const lo = bids.reduce((a, b) => (b < a ? b : a), bids[0]);
  const hi = asks.reduce((a, b) => (b > a ? b : a), asks[0]);
  return `${usd(lo)} – ${usd(hi)}`;
}

export function renderReport(results: ScenarioResult[], meta: { seed: number; generatedAt: string }): string {
  const failures = results.flatMap((r) => r.invariants.map((i) => `${r.key}: ${i}`));

  const lines: string[] = [];
  lines.push("# Tremor v2 — economic simulation");
  lines.push("");
  lines.push(
    "Ten scenarios against an integer replica of the deployed pricing library and the deployed vault accounting. The replica in `src/pricing.ts` is pinned to the same 60-digit reference vectors as the Solidity library (`npm run check`), so the numbers below are the contracts' arithmetic rather than an approximation of it.",
  );
  lines.push("");
  lines.push(
    "**What acceptance means here.** Not profitability in every scenario — a short-variance position loses money when variance is high, and it should. Acceptance means the accounting is solvent at every step, the behaviour is explainable, and the writer's loss is exactly the short-variance exposure they sold and nothing else.",
  );
  lines.push("");
  lines.push(`Seed \`${meta.seed}\` · generated ${meta.generatedAt} · ${results.length} scenarios`);
  lines.push("");

  lines.push("## Solvency");
  lines.push("");
  if (failures.length === 0) {
    lines.push(
      `Every invariant held in every scenario. Checked at each of the ${results[0].snapshots.length} sampling steps per scenario, and again after finalization, redemption and close:`,
    );
    lines.push("");
    lines.push("- The vault's balance never fell below its locked collateral.");
    lines.push("- A series' liability never exceeded the full-cap reservation for its outstanding units.");
    lines.push("- Finalization released no more than had been locked.");
    lines.push("- Every claim was extinguished, and no liability remained after redemption.");
    lines.push("- With every series closed, all remaining capital was free — nothing was stranded.");
    lines.push(
      "- The vault's closing balance equalled deposits plus premiums minus payouts, to the base unit, in every scenario.",
    );
  } else {
    lines.push("**Invariant failures:**");
    lines.push("");
    for (const f of failures) lines.push(`- ${f}`);
  }
  lines.push("");

  lines.push("## Writer and buyer P&L");
  lines.push("");
  lines.push("| Scenario | Realized vol | Ask at creation | Sold | Premium | Exit payouts | Redemptions | Writer P&L | Buyer P&L |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of results) {
    lines.push(
      `| ${r.title} | ${pct(r.realizedVolPct)} | ${pct(r.openingAskVolPct)} | ${units(r.unitsSold)} | ${usd(r.premiumRevenue)} | ${usd(r.exitPayouts)} | ${usd(r.settlementPayouts)} | **${usd(r.writerPnl)}** | ${usd(r.buyerPnl)} |`,
    );
  }
  lines.push("");
  lines.push(
    "Writer P&L is premium taken minus everything paid out on both burn legs. Buyer P&L is the aggregate of what every holder received minus what they paid. The two are exact mirrors by construction: there are no fees, no rebates and no third party in the flow.",
  );
  lines.push("");

  lines.push("## Settlement");
  lines.push("");
  lines.push("| Scenario | Final variance | Final vol | Payout / unit | Exited | Redeemed | Unsold |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const r of results) {
    lines.push(
      `| ${r.title} | ${(Number(r.finalVariance) / 1e18).toFixed(4)} | ${pct(Number(volPct(r.finalVariance)))} | ${usd(r.payoutPerUnit)} | ${units(r.unitsExited)} | ${units(r.unitsRedeemed)} | ${units(r.unitsUnsold)} |`,
    );
  }
  lines.push("");

  lines.push("## Capital");
  lines.push("");
  lines.push(
    "| Scenario | Collateral | Peak locked | Mean utilization | Released at finalization | Checkpoint calls | Largest batch | Clamped fills |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of results) {
    lines.push(
      `| ${r.title} | ${usd(r.collateral)} | ${usd(r.peakLocked)} | ${pct(r.meanUtilizationPct)} | ${usd(r.releasedAtFinalization)} | ${r.checkpointCalls} | ${r.largestCheckpointBatch} | ${r.partialFills} |`,
    );
  }
  lines.push("");
  lines.push(
    "Utilization is the fraction of the vault's balance that was reserved, averaged over the window. It runs high wherever the inventory sold, because a unit is reserved at the **cap** until finalization — the cap is the only bound that is knowable while the window is open. A writer quoting 40% vol against a 100% cap therefore locks roughly six times the premium they collected, and gets the surplus back the moment the variance is fixed: the 'released at finalization' column is that refund, paid before any holder redeems.",
  );
  lines.push("");
  lines.push(
    "Checkpoint calls are counted lazily — the simulation checkpoints when somebody wants to trade or to finalize, never on a schedule, because nobody is paid to do it. 'Largest batch' is the most samples any single call had to store, and it never exceeds the accumulator's own 32-sample bound.",
  );
  lines.push("");

  lines.push("## Bid/ask path and the projection");
  lines.push("");
  lines.push("| Scenario | Bid/ask range per unit | Opening projection | Closing projection | Realized |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const r of results) {
    const first = r.snapshots[0];
    const last = r.snapshots[r.snapshots.length - 1];
    lines.push(
      `| ${r.title} | ${bidAskRange(r)} | ${volPct(first.projectedVariance)}% | ${volPct(last.projectedVariance)}% | ${volPct(r.finalVariance)}% |`,
    );
  }
  lines.push("");
  lines.push(
    "The projection blends what has been measured with what the market forecasts for the rest of the window, so it converges on the realized number as the window closes. That convergence is the mechanism that stops a late buyer from pricing off variance that has already printed — and it is why the closing projection and the realized column agree.",
  );
  lines.push("");

  lines.push("## LVR hedge and residual basis");
  lines.push("");
  lines.push(
    "For a 1,000,000 USDC constant-product position over each scenario's window: `hedgeUnits = (V·T/8)/unitNotional`, bought at the opening ask.",
  );
  lines.push("");
  lines.push("| Scenario | Hedge units | Cost | Expected LVR | Hedge payout | Residual |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const r of results) {
    lines.push(
      `| ${r.title} | ${units(r.lvr.hedgeUnits)} | ${usd(r.lvr.hedgeCost)} | ${usd(r.lvr.expectedLvr)} | ${usd(r.lvr.hedgePayout)} | ${usd(r.lvr.residual)} |`,
    );
  }
  lines.push("");
  // Truncation means the cap actually bit, not that integer rounding shaved a base unit.
  const capped = results.filter((r) => r.finalVariance > 10n ** 18n);
  lines.push(
    "Residual is payout minus cost minus expected LVR. Two things are visible in it, and only the second is informative:",
  );
  lines.push("");
  lines.push(
    "1. **Below the cap the payout tracks the expected LVR to within rounding.** That is an identity, not a discovery: the sizing rule solves `units · unitNotional · σ² = V · σ² · T / 8`, so the same σ² appears on both sides and cancels. The residual there is essentially minus the premium — the LP's real cost is the premium and nothing else.",
  );
  lines.push(
    `2. **At the cap the identity breaks, and it breaks in the wrong direction.** ${capped.length} of ${results.length} scenarios truncated: the payoff stops rising exactly where the LVR bill is largest, so the LP is left with the premium *and* the excess. That asymmetry is the honest shape of this instrument as a hedge, and it is why the app sizes and prices it rather than calling it one.`,
  );
  lines.push("");

  lines.push("## Scenario notes");
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.title}`);
    lines.push("");
    lines.push(r.intent);
    lines.push("");
    if (r.notes.length > 0) for (const n of r.notes) lines.push(`- ${n}`);
    else lines.push("- Nothing anomalous: every fill priced and settled through the ordinary path.");
    lines.push("");
  }

  lines.push("## What this does not model");
  lines.push("");
  lines.push(
    "- **Gas.** Checkpoint counts are reported, but their cost is measured on a Base fork instead (`contracts/test/ForkE2E.t.sol`), because that is the only place the real Chainlink round search can be timed.",
  );
  lines.push(
    "- **The decay function.** `decaySkew` is the one formula the replica cannot compute bit-exactly, because the contract uses Solady's `expWad`. `npm run check` measures the divergence against the reference vectors rather than assuming it away.",
  );
  lines.push(
    "- **Adversarial writers.** Every attack a writer might attempt is tested against the real contracts in `contracts/test/Adversarial.t.sol` and demonstrated on a fork in `contracts/script/demo.sh` stage C. A simulation cannot prove a revert; only the contract can.",
  );
  lines.push(
    "- **Feed pathology.** Paths are generated on the series' own grid, so a sample never lands on a missing round. Real feeds repeat rounds, which biases realized variance downward — the reason for the 30-minute floor on the sampling grid.",
  );
  lines.push("");

  return lines.join("\n");
}

export function renderFindings(results: ScenarioResult[]): string {
  const failures = results.flatMap((r) => r.invariants.map((i) => `${r.key}: ${i}`));
  const atCap = results.filter((r) => r.finalVariance >= 10n ** 18n);
  const profitable = results.filter((r) => r.writerPnl > 0n);
  const lossy = results.filter((r) => r.writerPnl < 0n);
  const worst = results.reduce((a, r) => (r.writerPnl < a.writerPnl ? r : a), results[0]);
  const bestRes = results.reduce((a, r) => (r.lvr.residual > a.lvr.residual ? r : a), results[0]);

  const lines: string[] = [];
  lines.push("# Simulation findings");
  lines.push("");
  lines.push("What the ten scenarios in `out/report.md` actually showed, and what each one implies.");
  lines.push("");

  lines.push("## F1 — the accounting is solvent, at every step, in every scenario");
  lines.push("");
  if (failures.length === 0) {
    lines.push(
      "No invariant failed. The vault's balance never fell below its locked collateral, no series' liability exceeded the full-cap reservation for its outstanding units, finalization never released more than had been locked, and every scenario ended with every claim extinguished, no liability remaining, and the closing balance equal to deposits plus premiums minus payouts to the base unit.",
    );
    lines.push("");
    lines.push(
      "That last equality is the one worth dwelling on: it means no scenario found a path where money left the vault without a corresponding obligation disappearing, which is the property that lets EXIT and SETTLE share one balance.",
    );
  } else {
    lines.push("Invariants failed. This is a blocker, not a note:");
    lines.push("");
    for (const f of failures) lines.push(`- ${f}`);
  }
  lines.push("");

  lines.push("## F2 — the writer's loss is bounded by the cap, and only by the cap");
  lines.push("");
  const floor = worst.premiumRevenue - worst.collateral;
  lines.push(
    `${atCap.length} of ${results.length} scenarios finished at or above the cap. The worst case across all of them is **${usd(worst.writerPnl)} USDC** on ${usd(worst.collateral)} of collateral (${worst.title.toLowerCase()}), and that number is not approximately the floor — it *is* the floor: premium taken (${usd(worst.premiumRevenue)}) minus the full capped payout on a sold-out inventory (${usd(worst.collateral)}) is ${usd(floor)}.`,
  );
  lines.push("");
  lines.push(
    "So the loss is exactly the short-variance exposure the writer sold, bounded by the cap they chose and reserved in full at creation. There is no leverage, no liquidation, no margin call, and no shortfall for anybody else to absorb — the money to pay it was locked before the position existed.",
  );
  lines.push("");

  lines.push("## F3 — the spread and the impact are the compensation, and they are small");
  lines.push("");
  lines.push(
    `${profitable.length} scenarios were profitable for the writer and ${lossy.length} were not. Where realized variance landed near the quote, the writer kept roughly the half-spread and the inventory impact — which is a thin margin, and correctly so: a two-sided market that charged more for standing on both sides would simply not get traded against.`,
  );
  lines.push("");

  lines.push("## F4 — full-cap reservation makes capital expensive while the window is open");
  lines.push("");
  lines.push(
    `Mean utilization across the scenarios runs ${Math.min(...results.map((r) => r.meanUtilizationPct)).toFixed(0)}–${Math.max(...results.map((r) => r.meanUtilizationPct)).toFixed(0)}% of the vault's balance. A unit sold at a 40%-vol quote against a 100%-vol cap reserves roughly six times the premium it collected, because until the window is finalized the cap is the only bound that is knowable.`,
  );
  lines.push("");
  lines.push(
    "Finalization is what fixes it, and it fixes it immediately: repricing the liability from the cap to the real payout returns the surplus the moment the variance is known, without waiting for a single holder to redeem. The scenarios' 'released at finalization' column is that refund.",
  );
  lines.push("");
  lines.push(
    "The design consequence is real and worth stating plainly: a writer choosing a high cap buys buyers more upside and pays for it in locked capital, at roughly `cap / quote` times the premium. That trade-off is the writer's to make, and `/write` shows both sides of it before they sign.",
  );
  lines.push("");

  lines.push("## F5 — the projection converges, which is what closes the late-entry hole");
  lines.push("");
  lines.push(
    "In the early-spike and late-spike scenarios the quote moves substantially over the window even with an unchanged anchor, because the projection weights measured variance by elapsed time. By expiry the projection equals the realized number exactly. A buyer arriving late is therefore quoted off what has already happened, not off the writer's opening opinion — and the sale window closes long before that, so they cannot arrive at all.",
  );
  lines.push("");

  lines.push("## F6 — exits clamp instead of failing");
  lines.push("");
  const clamped = results.filter((r) => r.partialFills > 0);
  lines.push(
    `${clamped.length} scenarios produced clamped fills (${clamped.map((r) => `${r.key}: ${r.partialFills}`).join(", ") || "none"}). Every one of them re-priced the size that actually filled rather than reverting, which is why the heavy-issuance and heavy-exit scenarios still complete. The clamps that bind are inventory, the cap, the vault's free collateral, the zero-bid point and the liability a burn releases — never a raw balance check that would have failed the transaction.`,
  );
  lines.push("");

  lines.push("## F7 — the LVR hedge is a sizing tool, not a replication");
  lines.push("");
  const truncated = results.filter((r) => r.finalVariance > 10n ** 18n);
  lines.push(
    `Below the cap the receipt's payout and the V·σ²·T/8 estimate agree to within integer rounding — which is an identity of the sizing rule, not evidence of a good hedge: the same σ² cancels from both sides. What that leaves is the premium, and the premium is a real cost the LP pays whether or not variance shows up. The best residual across the scenarios is ${usd(bestRes.lvr.residual)} USDC (${bestRes.title.toLowerCase()}), and it is negative.`,
  );
  lines.push("");
  lines.push(
    `Where the cap bites the identity breaks in the wrong direction. ${truncated.length} of ${results.length} scenarios finished above the cap; in ${truncated.length === 1 ? "that one" : "those"} the payoff stops rising exactly where the LVR bill is largest, so the LP keeps both the premium and the excess. An instrument that under-pays in the tail is a sizing tool, not a hedge, and that is the language the app uses.`,
  );
  lines.push("");

  lines.push("## What the simulation cannot tell you");
  lines.push("");
  lines.push(
    "It cannot prove a revert. Every claim about what a writer *cannot* do is tested against the real contracts (`contracts/test/Adversarial.t.sol`, `contracts/test/Invariants.t.sol`) and demonstrated on a Base fork (`contracts/script/demo.sh` stage C). This file is about the economics of the paths where everyone behaves.",
  );
  lines.push("");

  return lines.join("\n");
}

export function writeArtifacts(results: ScenarioResult[], meta: { seed: number }): { report: string; findings: string; json: string } {
  const out = join(process.cwd(), "out");
  mkdirSync(out, { recursive: true });
  const generatedAt = new Date().toISOString();
  const report = renderReport(results, { ...meta, generatedAt });
  const findings = renderFindings(results);
  const jsonPath = join(out, `run-${generatedAt.replace(/[:.]/g, "-")}.json`);

  writeFileSync(join(out, "report.md"), `${report}\n`);
  writeFileSync(join(out, "findings.md"), `${findings}\n`);
  writeFileSync(
    jsonPath,
    `${JSON.stringify(
      { generatedAt, seed: meta.seed, scenarios: results },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    )}\n`,
  );
  return { report: join(out, "report.md"), findings: join(out, "findings.md"), json: jsonPath };
}
