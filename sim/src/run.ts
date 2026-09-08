/**
 * `npm run sim` — run every scenario and write the report.
 *
 *   npm run sim                 all ten scenarios, seed 1
 *   npm run sim -- --seed 7     a different set of price paths
 *   npm run sim -- --only at-cap,late-spike
 */

import { SCENARIOS, runScenario, type ScenarioResult } from "./scenarios.js";
import { writeArtifacts } from "./report.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const seed = Number(arg("seed") ?? 1);
const only = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);
const now = 1_800_000_000; // a fixed epoch, so a run is reproducible from the seed alone

const specs = only ? SCENARIOS.filter((s) => only.includes(s.key)) : SCENARIOS;
if (specs.length === 0) {
  console.error(`no scenarios matched --only. Available: ${SCENARIOS.map((s) => s.key).join(", ")}`);
  process.exit(2);
}

const results: ScenarioResult[] = [];
let failed = 0;
for (const spec of specs) {
  process.stdout.write(`${spec.key.padEnd(20)} `);
  try {
    const r = runScenario(spec, now, seed);
    results.push(r);
    const usd = (v: bigint) => (Number(v) / 1e6).toFixed(2);
    console.log(
      `realized ${r.realizedVolPct.toFixed(1)}% vol · sold ${(Number(r.unitsSold) / 1e18).toFixed(2)} units · writer ${usd(r.writerPnl)} USDC · ${r.invariants.length === 0 ? "invariants OK" : `${r.invariants.length} INVARIANT FAILURES`}`,
    );
    if (r.invariants.length > 0) failed += r.invariants.length;
  } catch (e) {
    failed += 1;
    console.log(`THREW: ${(e as Error).message}`);
  }
}

if (results.length > 0) {
  const paths = writeArtifacts(results, { seed });
  console.log(`\nwrote ${paths.report}\nwrote ${paths.findings}\nwrote ${paths.json}`);
}

if (failed > 0) {
  console.error(`\n${failed} invariant failure(s) — this is a blocker, not a note.`);
  process.exit(1);
}
