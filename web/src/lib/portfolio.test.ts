import { describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import {
  GroupStatus,
  PMode,
  calmPpuFor,
  exitAvailability,
  exitFunded,
  exitMode,
  finalizedReserve,
  groupCanBuy,
  groupCanExit,
  groupCanRedeem,
  groupExitProceeds,
  groupIssuePremium,
  groupNeedsWorthlessBurn,
  groupSettleProceeds,
  groupStatus,
  highPpuFor,
  issueMode,
  liveReserve,
  maxGroupLiability,
  reserveFor,
  reserveReleasedByBurn,
  settleMode,
  sortGroups,
  standaloneCapsFor,
  vaultFreeCollateral,
  xWadFor,
  type GroupParams,
  type GroupState,
} from "./portfolio";

const WAD = 10n ** 18n;
/** S = 100 USDC per 1e18 units. */
const S = 100_000_000n;

const params: GroupParams = {
  feed: zeroAddress,
  quoteToken: zeroAddress,
  start: 1_000,
  expiry: 1_000 + 604_800,
  saleEnd: 1_000 + 151_200,
  sampleInterval: 3_600,
  capVariance: WAD,
  capPayoutPerUnit: S,
  maxUnitsPerSide: 100n * WAD,
  askHigh: 40_000_000n,
  bidHigh: 30_000_000n,
  askCalm: 70_000_000n,
  bidCalm: 60_000_000n,
};

function group(over: Partial<GroupState> = {}): GroupState {
  return {
    id: 1n,
    writer: zeroAddress,
    vault: zeroAddress,
    highReceipt: zeroAddress,
    calmReceipt: zeroAddress,
    highOutstanding: 0n,
    calmOutstanding: 0n,
    reserveLocked: 0n,
    exitBuffer: 0n,
    standaloneCaps: 0n,
    finalized: false,
    finalVariance: 0n,
    xWad: 0n,
    highPpu: 0n,
    calmPpu: 0n,
    params,
    source: "chain",
    ...over,
  };
}

describe("mode mapping", () => {
  it("maps sides to the PMode enum exactly", () => {
    expect(issueMode("high")).toBe(PMode.IssueHigh);
    expect(issueMode("calm")).toBe(PMode.IssueCalm);
    expect(exitMode("high")).toBe(PMode.ExitHigh);
    expect(exitMode("calm")).toBe(PMode.ExitCalm);
    expect(settleMode("high")).toBe(PMode.SettleHigh);
    expect(settleMode("calm")).toBe(PMode.SettleCalm);
  });
});

describe("reserve", () => {
  it("is the max side times S, rounded up — never the sum", () => {
    const h = 10n * WAD;
    const c = 4n * WAD;
    expect(liveReserve(h, c, S)).toBe((h * S + WAD - 1n) / WAD);
    expect(liveReserve(h, c, S)).toBe(liveReserve(h, 0n, S));
    expect(liveReserve(h, c, S)).toBeLessThan(standaloneCapsFor(h, c, S));
  });

  it("rounds the live reserve up", () => {
    // 1 wei of units still reserves 1 base unit.
    expect(liveReserve(1n, 0n, S)).toBe(1n);
    expect(liveReserve(0n, 0n, S)).toBe(0n);
  });

  it("standalone caps are the sum of both sides' caps", () => {
    expect(standaloneCapsFor(10n * WAD, 4n * WAD, S)).toBe(1_000_000_000n + 400_000_000n);
  });

  it("after finalization it is the floored sum of both sides' fixed payouts", () => {
    const x = WAD / 4n;
    const hp = highPpuFor(S, x);
    const cp = calmPpuFor(S, x);
    expect(finalizedReserve(3n * WAD, 5n * WAD, hp, cp)).toBe((3n * WAD * hp) / WAD + (5n * WAD * cp) / WAD);
  });
});

describe("complementary payouts", () => {
  it("sum to S exactly for any x, including awkward rounding", () => {
    for (const fv of [0n, 1n, WAD / 3n, WAD / 2n, (WAD * 2n) / 3n, WAD - 1n, WAD, 2n * WAD]) {
      const x = xWadFor(fv, WAD);
      expect(highPpuFor(S, x) + calmPpuFor(S, x)).toBe(S);
    }
  });

  it("clamps x at 1 above the cap", () => {
    expect(xWadFor(5n * WAD, WAD)).toBe(WAD);
    expect(highPpuFor(S, xWadFor(5n * WAD, WAD))).toBe(S);
    expect(calmPpuFor(S, xWadFor(5n * WAD, WAD))).toBe(0n);
  });

  it("zero cap variance yields x = 0", () => {
    expect(xWadFor(WAD, 0n)).toBe(0n);
  });
});

describe("exit released", () => {
  it("equals reserve(before) − reserve(after)", () => {
    const g = group({ highOutstanding: 10n * WAD, calmOutstanding: 4n * WAD });
    const burn = 3n * WAD;
    const before = reserveFor(g, g.highOutstanding, g.calmOutstanding);
    const after = reserveFor(g, g.highOutstanding - burn, g.calmOutstanding);
    expect(reserveReleasedByBurn(g, "high", burn)).toBe(before - after);
  });

  it("releases nothing while the other side still binds the reserve", () => {
    const g = group({ highOutstanding: 10n * WAD, calmOutstanding: 6n * WAD });
    // Burning CALM leaves max(h, c) = h unchanged.
    expect(reserveReleasedByBurn(g, "calm", 4n * WAD)).toBe(0n);
    // Burning the binding HIGH side lowers the max and releases collateral.
    expect(reserveReleasedByBurn(g, "high", 4n * WAD)).toBeGreaterThan(0n);
    // ... but only down to where CALM starts binding.
    expect(reserveReleasedByBurn(g, "high", 10n * WAD)).toBe(liveReserve(10n * WAD, 0n, S) - liveReserve(0n, 6n * WAD, S));
  });

  it("returns zero rather than going negative on an oversized burn", () => {
    const g = group({ highOutstanding: WAD });
    expect(reserveReleasedByBurn(g, "high", 2n * WAD)).toBe(0n);
  });
});

describe("fixed-quote pricing", () => {
  it("issue premium rounds up, exit and settle round down", () => {
    const units = WAD / 3n;
    expect(groupIssuePremium(units, params.askHigh)).toBe((units * params.askHigh + WAD - 1n) / WAD);
    expect(groupExitProceeds(units, params.bidHigh)).toBe((units * params.bidHigh) / WAD);
    expect(groupSettleProceeds(units, 50_000_000n)).toBe((units * 50_000_000n) / WAD);
    expect(groupIssuePremium(0n, params.askHigh)).toBe(0n);
  });
});

describe("exit funding", () => {
  it("available = reserve released by this burn + exit buffer", () => {
    const g = group({ highOutstanding: 10n * WAD, calmOutstanding: 10n * WAD, exitBuffer: 5_000_000n });
    const { needed, available } = exitAvailability(g, "calm", 2n * WAD);
    // Burning CALM below HIGH releases no reserve; only the buffer is available.
    expect(available).toBe(5_000_000n);
    expect(needed).toBe(groupExitProceeds(2n * WAD, params.bidCalm));
    expect(exitFunded(g, "calm", 2n * WAD)).toBe(available >= needed);
  });

  it("a one-sided book funds exits out of the released reserve alone", () => {
    const g = group({ highOutstanding: 10n * WAD });
    // Released per unit is S (100 USDC), bid is 30 USDC — always funded.
    expect(exitFunded(g, "high", 3n * WAD)).toBe(true);
  });
});

describe("status and predicates", () => {
  const t = params;
  it("walks the lifecycle from times plus the finalized flag", () => {
    const g = group();
    expect(groupStatus(g, t.start - 1)).toBe(GroupStatus.Upcoming);
    expect(groupStatus(g, t.start)).toBe(GroupStatus.Open);
    expect(groupStatus(g, t.saleEnd)).toBe(GroupStatus.Trading);
    expect(groupStatus(g, t.expiry)).toBe(GroupStatus.AwaitingFinalization);
    const fin = group({ finalized: true, highOutstanding: WAD });
    expect(groupStatus(fin, t.expiry + 1)).toBe(GroupStatus.Finalized);
    expect(groupStatus(group({ finalized: true }), t.expiry + 1)).toBe(GroupStatus.Settled);
  });

  it("canBuy only during the sale window and never after finalization", () => {
    const g = group();
    expect(groupCanBuy(g, t.start)).toBe(true);
    expect(groupCanBuy(g, t.start - 1)).toBe(false);
    expect(groupCanBuy(g, t.saleEnd)).toBe(false);
    expect(groupCanBuy(group({ finalized: true }), t.start)).toBe(false);
  });

  it("canExit needs an open window and outstanding units on that side", () => {
    const g = group({ highOutstanding: WAD });
    expect(groupCanExit(g, "high", t.saleEnd)).toBe(true);
    expect(groupCanExit(g, "calm", t.saleEnd)).toBe(false);
    expect(groupCanExit(g, "high", t.expiry)).toBe(false);
    expect(groupCanExit(group({ finalized: true, highOutstanding: WAD }), "high", t.saleEnd)).toBe(false);
  });

  it("canRedeem needs finalization and a nonzero payout; worthless sides burn instead", () => {
    const x = xWadFor(WAD, WAD); // x = 1: HIGH pays S, CALM pays 0
    const fin = group({
      finalized: true,
      xWad: x,
      highPpu: highPpuFor(S, x),
      calmPpu: calmPpuFor(S, x),
      highOutstanding: WAD,
      calmOutstanding: WAD,
    });
    expect(groupCanRedeem(fin, "high")).toBe(true);
    expect(groupCanRedeem(fin, "calm")).toBe(false);
    expect(groupNeedsWorthlessBurn(fin, "calm")).toBe(true);
    expect(groupNeedsWorthlessBurn(fin, "high")).toBe(false);
    expect(groupNeedsWorthlessBurn(group(), "calm")).toBe(false);
  });
});

describe("derivations", () => {
  it("max group liability funds the whole one-sided inventory at the cap", () => {
    expect(maxGroupLiability(params)).toBe((params.maxUnitsPerSide * S + WAD - 1n) / WAD);
  });

  it("free collateral never goes negative", () => {
    expect(vaultFreeCollateral(10n, 4n)).toBe(6n);
    expect(vaultFreeCollateral(4n, 10n)).toBe(0n);
  });

  it("sortGroups ranks open and trading groups first", () => {
    const open = group({ id: 1n });
    const fin = group({ id: 2n, finalized: true, highOutstanding: WAD });
    const sorted = sortGroups([fin, open], params.start + 1);
    expect(sorted[0].id).toBe(1n);
  });

  it("fmtPriceUsdc handles micro-cent payouts and standard prices with proper precision", async () => {
    const { fmtPriceUsdc } = await import("./format");
    expect(fmtPriceUsdc(0n)).toBe("0.00");
    // Group 1 exact values on Base Sepolia:
    expect(fmtPriceUsdc(427n)).toBe("0.000427");
    expect(fmtPriceUsdc(999573n)).toBe("0.999573");
    expect(fmtPriceUsdc(300_000n)).toBe("0.30");
    expect(fmtPriceUsdc(280_000n)).toBe("0.28");
    expect(fmtPriceUsdc(1_000_000n)).toBe("1.00");
  });
});
