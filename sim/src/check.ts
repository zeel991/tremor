/**
 * `npm run check` — pin `src/pricing.ts` against the Solidity library's own reference vectors.
 *
 * The simulation's conclusions are only worth anything if its arithmetic is the contracts'
 * arithmetic. These are the same 60 cases, generated at 60 decimal digits by
 * `contracts/tools/reference/pricing_reference.py`, that `contracts/test/MarketPricing.t.sol` uses.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as P from "./pricing.js";

interface Case {
  name: string;
  [k: string]: string;
}

const file = join(process.cwd(), "..", "contracts", "test", "vectors", "pricing_vectors.json");
const doc = JSON.parse(readFileSync(file, "utf8")) as { n_cases: number; cases: Case[] };
if (doc.cases.length !== doc.n_cases) {
  console.error(`vector file claims ${doc.n_cases} cases but holds ${doc.cases.length}`);
  process.exit(1);
}

let checks = 0;
let failures = 0;
const fail = (name: string, what: string, got: bigint, want: bigint): void => {
  failures += 1;
  console.error(`${name}: ${what} got ${got}, want ${want}`);
};
const eq = (name: string, what: string, got: bigint, want: bigint): void => {
  checks += 1;
  if (got !== want) fail(name, what, got, want);
};

/** The only inexact formula: the contract uses Solady's expWad, this uses Math.exp. */
let worstDecayError = 0;

for (const c of doc.cases) {
  const B = (k: string): bigint => BigInt(c[k]);
  const N = (k: string): number => Number(c[k]);

  // decaySkew — measured, not asserted exact.
  {
    const got = P.decaySkew(B("skew"), B("dt"), N("half_life"));
    const want = B("decayed_skew");
    const scale = want === 0n ? 1n : (want < 0n ? -want : want);
    const diff = got > want ? got - want : want - got;
    const rel = Number(diff) / Number(scale);
    if (rel > worstDecayError) worstDecayError = rel;
    checks += 1;
    if (rel > 1e-9) fail(c.name, "decaySkew relative error above 1e-9", got, want);
  }

  eq(c.name, "forwardVariance", P.forwardVariance(B("anchor"), B("decayed_skew"), B("cap")), B("forward"));
  eq(
    c.name,
    "projectedVariance",
    P.projectedVariance(B("realized"), B("elapsed"), B("forward"), B("remaining")),
    B("projected"),
  );
  eq(c.name, "annualize", P.annualize(B("sum_squared"), B("elapsed")), B("annualized"));

  const ba = P.bidAskVariance(B("projected"), N("spread"), B("cap"));
  eq(c.name, "bidVariance", ba.bidVariance, B("bid_variance"));
  eq(c.name, "askVariance", ba.askVariance, B("ask_variance"));

  eq(
    c.name,
    "askImpactSlope",
    P.askImpactSlope(B("impact"), B("remaining"), B("elapsed") + B("remaining"), N("spread")),
    B("ask_slope"),
  );
  eq(
    c.name,
    "bidImpactSlope",
    P.bidImpactSlope(B("impact"), B("remaining"), B("elapsed") + B("remaining"), N("spread")),
    B("bid_slope"),
  );

  eq(
    c.name,
    "issuePremium",
    P.issuePremium(B("ask_variance"), B("ask_slope"), B("notional"), B("units")),
    B("premium"),
  );
  eq(
    c.name,
    "issueUnitsFor",
    P.issueUnitsFor(B("ask_variance"), B("ask_slope"), B("notional"), B("amount_in")),
    B("units_for"),
  );
  eq(c.name, "issueUnitsToCap", P.issueUnitsToCap(B("ask_variance"), B("ask_slope"), B("cap")), B("units_to_cap"));
  eq(
    c.name,
    "issueUnitsToCollateral",
    P.issueUnitsToCollateral(
      B("outstanding"),
      P.maxLiability(B("outstanding"), B("notional"), B("cap")),
      B("free"),
      B("notional"),
      B("cap"),
    ),
    B("units_to_collateral"),
  );

  eq(
    c.name,
    "exitProceeds",
    P.exitProceeds(B("bid_variance"), B("bid_slope"), B("notional"), B("exit_units")),
    B("exit_proceeds"),
  );
  eq(c.name, "exitUnitsToZeroBid", P.exitUnitsToZeroBid(B("bid_variance"), B("bid_slope")), B("units_to_zero_bid"));

  eq(c.name, "payoutPerUnit", P.payoutPerUnit(B("final_variance"), B("cap"), B("notional")), B("payout_per_unit"));
  eq(c.name, "settleProceeds", P.settleProceeds(B("units"), B("payout_per_unit")), B("settle_proceeds"));
  eq(c.name, "maxLiability", P.maxLiability(B("units"), B("notional"), B("cap")), B("max_liability"));
  eq(c.name, "finalLiability", P.finalLiability(B("units"), B("payout_per_unit")), B("final_liability"));
  eq(
    c.name,
    "maxLiability(outstanding)",
    P.maxLiability(B("outstanding"), B("notional"), B("cap")),
    B("locked_for_outstanding"),
  );
}

console.log(
  `${doc.cases.length} vector cases · ${checks} checks · ${failures} failures · worst decaySkew relative error ${worstDecayError.toExponential(2)}`,
);
if (failures > 0) process.exit(1);
