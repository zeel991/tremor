import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import {
  Leg,
  Status,
  breakEvenVariance,
  canBuy,
  canClose,
  canExit,
  canRedeem,
  checkpointsBehind,
  effectiveVariance,
  exitProceeds,
  isFinalized,
  issuePremium,
  legFrom,
  matchesFilter,
  maxLiabilityFor,
  maxPayoutPerUnit,
  maxSeriesLiability,
  needsCheckpoint,
  needsFinalize,
  needsWorthlessBurn,
  payoutFor,
  perUnitPrice,
  receiptSymbol,
  sortSeries,
  statusFrom,
  type SeriesParams,
  type SeriesState,
} from "./series";

const WAD = 10n ** 18n;

const params: SeriesParams = {
  feed: zeroAddress,
  quoteToken: zeroAddress,
  start: 1_000,
  expiry: 1_000 + 604_800,
  saleEnd: 1_000 + 151_200,
  sampleInterval: 3_600,
  unitNotional: 100_000_000n,
  capVariance: WAD,
  anchorVariance: WAD / 4n,
  impactPerUnit: WAD / 100n,
  halfLife: 21_600,
  halfSpreadBps: 200,
  maxUnits: 100n * WAD,
};

/** A live, fully collateralized series with nothing sold and the checkpoints current. */
function state(over: Partial<SeriesState> = {}): SeriesState {
  const zeroHash = `0x${"00".repeat(32)}` as const;
  return {
    id: 1n,
    writer: zeroAddress,
    vault: zeroAddress,
    receipt: zeroAddress,
    params: { ...params },
    issueOrderHash: zeroHash,
    exitOrderHash: zeroHash,
    settlementOrderHash: zeroHash,
    status: Status.Live,
    legs: {
      issuanceOpen: true,
      exitOpen: true,
      settleOpen: false,
      issueLegActive: true,
      exitLegActive: true,
      settleLegActive: true,
    },
    quote: {
      marketVariance: WAD / 4n,
      projectedVariance: WAD / 4n,
      realizedVarianceSoFar: 0n,
      bidVariance: 245_000_000_000_000_000n,
      askVariance: 255_000_000_000_000_000n,
      bidPerUnit: 24_500_000n,
      askPerUnit: 25_500_000n,
      maxPayoutPerUnit: 100_000_000n,
    },
    unitsOutstanding: 0n,
    unitsAvailable: params.maxUnits,
    lockedLiability: 0n,
    finalVariance: 0n,
    payoutPerUnit: 0n,
    oracle: {
      samplesStored: 3,
      samplesAvailable: 3,
      samplesTotal: 169,
      processedThrough: 8_200,
      checkpointsCurrent: true,
    },
    fullyCollateralized: true,
    vaultState: {
      vault: zeroAddress,
      owner: zeroAddress,
      balance: 10_000_000_000n,
      locked: 0n,
      free: 10_000_000_000n,
      aquaAllowance: 2n ** 256n - 1n,
      allowanceSufficient: true,
    },
    source: "chain",
    ...over,
  };
}

// ---------------------------------------------------------------- executable arithmetic

/**
 * The reference vectors the Solidity library is tested against, generated at 60 significant digits.
 *
 * The frontend implements a strict subset of `VariancePricing`, and every function it does implement
 * has to agree with the chain to the last base unit — a UI that rounds differently from the engine
 * quotes a premium the engine will not accept.
 */
const vectors = JSON.parse(
  readFileSync(join(__dirname, "../../../contracts/test/vectors/pricing_vectors.json"), "utf8"),
) as {
  n_cases: number;
  cases: Array<Record<string, string>>;
};

describe("pricing agrees with the Solidity reference vectors", () => {
  it("loaded every case", () => {
    expect(vectors.cases.length).toBe(vectors.n_cases);
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  it("prices the ISSUE integral exactly", () => {
    for (const c of vectors.cases) {
      expect(
        issuePremium(BigInt(c.notional), BigInt(c.ask_variance), BigInt(c.ask_slope), BigInt(c.units)),
      ).toBe(BigInt(c.premium));
    }
  });

  it("prices the EXIT integral exactly", () => {
    for (const c of vectors.cases) {
      expect(
        exitProceeds(BigInt(c.notional), BigInt(c.bid_variance), BigInt(c.bid_slope), BigInt(c.exit_units)),
      ).toBe(BigInt(c.exit_proceeds));
    }
  });

  it("derives the payout per unit and the settlement proceeds exactly", () => {
    for (const c of vectors.cases) {
      const ppu = BigInt(c.payout_per_unit);
      expect(perUnitPrice(BigInt(c.notional), BigInt(c.final_variance) < BigInt(c.cap) ? BigInt(c.final_variance) : BigInt(c.cap))).toBe(ppu);
      expect(payoutFor(BigInt(c.units), ppu)).toBe(BigInt(c.settle_proceeds));
    }
  });

  it("reserves the same maximum liability the contract does", () => {
    for (const c of vectors.cases) {
      expect(maxLiabilityFor(BigInt(c.units), { unitNotional: BigInt(c.notional), capVariance: BigInt(c.cap) })).toBe(
        BigInt(c.max_liability),
      );
    }
  });

  it("caps the payout per unit at the cap variance", () => {
    for (const c of vectors.cases) {
      expect(maxPayoutPerUnit({ unitNotional: BigInt(c.notional), capVariance: BigInt(c.cap) })).toBe(
        (BigInt(c.notional) * BigInt(c.cap)) / WAD,
      );
    }
  });
});

describe("series financial math", () => {
  it("reserves the rounded-up full-inventory liability", () => {
    // 100 units × 100 USDC × 1.0 variance = 10,000 USDC
    expect(maxSeriesLiability(params)).toBe(10_000_000_000n);
    expect(maxLiabilityFor(params.maxUnits, params)).toBe(maxSeriesLiability(params));
    expect(maxLiabilityFor(0n, params)).toBe(0n);
  });

  it("rounds the reservation up, never down", () => {
    // One base unit of receipt: the exact liability is 1e-18 USDC, which has to reserve a whole unit.
    expect(maxLiabilityFor(1n, params)).toBe(1n);
  });

  it("never lets a buyer beat the market by splitting a fill", () => {
    const slope = params.impactPerUnit;
    const ask = 255_000_000_000_000_000n;
    const first = 3n * WAD;
    const second = 5n * WAD;
    const split =
      issuePremium(params.unitNotional, ask, slope, first) +
      issuePremium(params.unitNotional, ask + (slope * first) / WAD, slope, second);
    const whole = issuePremium(params.unitNotional, ask, slope, first + second);
    expect(split).toBeGreaterThanOrEqual(whole);
    // The two differ only by the integral's two ceilings, never by a discount worth exploiting.
    expect(split - whole).toBeLessThanOrEqual(2n);
  });

  it("never lets an exiter beat the bid by splitting a sale", () => {
    const slope = 9_800_000_000_000_000n;
    const bid = 245_000_000_000_000_000n;
    const first = 3n * WAD;
    const second = 5n * WAD;
    const split =
      exitProceeds(params.unitNotional, bid, slope, first) +
      exitProceeds(params.unitNotional, bid - (slope * first) / WAD, slope, second);
    const whole = exitProceeds(params.unitNotional, bid, slope, first + second);
    expect(split).toBeLessThanOrEqual(whole);
  });

  it("floors the exit at zero rather than paying a negative bid", () => {
    expect(exitProceeds(params.unitNotional, WAD / 100n, WAD, 100n * WAD)).toBe(0n);
    expect(exitProceeds(params.unitNotional, WAD, WAD, 0n)).toBe(0n);
    expect(issuePremium(params.unitNotional, WAD, WAD, 0n)).toBe(0n);
  });

  it("derives the break-even variance from what was actually paid", () => {
    const units = 2n * WAD;
    // 2 units at 25 USDC each break even at 0.25 variance == 50% vol.
    expect(breakEvenVariance(50_000_000n, units, params.unitNotional)).toBe(WAD / 4n);
    expect(breakEvenVariance(50_000_000n, 0n, params.unitNotional)).toBe(0n);
    expect(breakEvenVariance(50_000_000n, units, 0n)).toBe(0n);
  });

  it("caps the payout at the cap variance", () => {
    const units = 2n * WAD;
    // Realized 2.0 against a 1.0 cap still pays the cap: 2 units × 100 USDC × 1.0.
    expect(payoutFor(units, maxPayoutPerUnit(params))).toBe(200_000_000n);
  });
});

// ---------------------------------------------------------------- normalization

describe("normalization", () => {
  it("normalizes status inputs from both sources", () => {
    expect(statusFrom(1n)).toBe(Status.Live);
    expect(statusFrom("finalized")).toBe(Status.Finalized);
    expect(statusFrom("expired_unfinalized")).toBe(Status.ExpiredUnfinalized);
    expect(statusFrom("closed")).toBe(Status.Closed);
    expect(statusFrom("3")).toBe(Status.Finalized);
    expect(statusFrom("bad")).toBe(Status.Upcoming);
    expect(statusFrom(99)).toBe(Status.Upcoming);
  });

  it("normalizes leg inputs from both sources", () => {
    expect(legFrom("issue")).toBe(Leg.Issue);
    expect(legFrom("exit")).toBe(Leg.Exit);
    expect(legFrom("settle")).toBe(Leg.Settle);
    expect(legFrom(3n)).toBe(Leg.Settle);
    expect(legFrom("nonsense")).toBe(Leg.None);
    expect(legFrom(9)).toBe(Leg.None);
  });

  it("names the receipt after its expiry day", () => {
    expect(receiptSymbol({ params })).toMatch(/^tVAR-ETH-\d{6}$/);
  });
});

// ---------------------------------------------------------------- lifecycle gating

describe("lifecycle gating", () => {
  it("allows both sides of a live, current market", () => {
    const s = state();
    expect(canBuy(s)).toBe(true);
    expect(canExit(s)).toBe(true);
    expect(canRedeem(s)).toBe(false);
  });

  it("refuses to quote either side while the checkpoints are behind", () => {
    const s = state({
      oracle: { samplesStored: 3, samplesAvailable: 9, samplesTotal: 169, processedThrough: 8_200, checkpointsCurrent: false },
    });
    expect(canBuy(s)).toBe(false);
    expect(canExit(s)).toBe(false);
    expect(checkpointsBehind(s)).toBe(6);
    expect(needsCheckpoint(s)).toBe(true);
  });

  it("closes issuance without closing the exit", () => {
    const s = state({
      legs: { ...state().legs, issuanceOpen: false },
    });
    expect(canBuy(s)).toBe(false);
    expect(canExit(s)).toBe(true);
  });

  it("offers finalization only once the window is complete", () => {
    const partial = state({
      status: Status.ExpiredUnfinalized,
      oracle: { samplesStored: 100, samplesAvailable: 169, samplesTotal: 169, processedThrough: 0, checkpointsCurrent: false },
    });
    expect(needsFinalize(partial)).toBe(false);
    const complete = state({
      status: Status.ExpiredUnfinalized,
      oracle: { samplesStored: 169, samplesAvailable: 169, samplesTotal: 169, processedThrough: 0, checkpointsCurrent: true },
    });
    expect(needsFinalize(complete)).toBe(true);
  });

  it("burns rather than redeems a series that finalized worthless", () => {
    const worthless = state({
      status: Status.Finalized,
      legs: { ...state().legs, issuanceOpen: false, exitOpen: false, settleOpen: true },
      unitsOutstanding: 5n * WAD,
      payoutPerUnit: 0n,
      finalVariance: 0n,
    });
    expect(canRedeem(worthless)).toBe(false);
    expect(needsWorthlessBurn(worthless)).toBe(true);
    expect(isFinalized(worthless)).toBe(true);

    const paying = state({
      status: Status.Finalized,
      legs: { ...state().legs, issuanceOpen: false, exitOpen: false, settleOpen: true },
      unitsOutstanding: 5n * WAD,
      payoutPerUnit: 30_000_000n,
      finalVariance: 3n * WAD / 10n,
    });
    expect(canRedeem(paying)).toBe(true);
    expect(needsWorthlessBurn(paying)).toBe(false);
    expect(effectiveVariance(paying)).toBe(3n * WAD / 10n);
  });

  it("refuses to close a series with receipts still outstanding", () => {
    expect(canClose(state({ unitsOutstanding: 1n }))).toBe(false);
    expect(canClose(state({ unitsOutstanding: 0n }))).toBe(true);
    expect(canClose(state({ status: Status.Closed, unitsOutstanding: 0n }))).toBe(false);
  });

  it("shows the realized variance so far until the final one is fixed", () => {
    const live = state({ quote: { ...state().quote, realizedVarianceSoFar: WAD / 5n } });
    expect(effectiveVariance(live)).toBe(WAD / 5n);
  });
});

// ---------------------------------------------------------------- list behaviour

describe("list behaviour", () => {
  it("sorts live markets first and expiries ascending", () => {
    const closed = state({ id: 1n, status: Status.Closed });
    const live = state({ id: 2n, status: Status.Live, params: { ...params, expiry: 900_000 } });
    const liveSooner = state({ id: 3n, status: Status.Live, params: { ...params, expiry: 800_000 } });
    const upcoming = state({ id: 4n, status: Status.Upcoming });
    const sorted = sortSeries([closed, live, liveSooner, upcoming]);
    expect(sorted.map((s) => s.id)).toEqual([3n, 2n, 4n, 1n]);
  });

  it("filters by lifecycle state and by whether issuance is open", () => {
    const s = state();
    expect(matchesFilter(s, "all")).toBe(true);
    expect(matchesFilter(s, "live")).toBe(true);
    expect(matchesFilter(s, "closed")).toBe(false);
    expect(matchesFilter(s, "issuanceOpen")).toBe(true);
    expect(matchesFilter(state({ legs: { ...s.legs, issuanceOpen: false } }), "issuanceOpen")).toBe(false);
  });
});
