#!/usr/bin/env python3
"""
Tremor realized-variance reference (ARCHITECTURE.md §1 / §3.3).

Generates synthetic Chainlink-style round histories (irregular timestamps, multiple phases with
overlaps and gaps) and computes the expected annualized realized variance with arbitrary-precision
Decimal arithmetic. Output: test/vectors/rv_vectors.json, consumed by test/RealizedVariance.t.sol.

Sampling definition (must match RealizedVariance.sol exactly):
  t_i = start + i*interval, i = 0..n
  P_i = answer of the latest round with updatedAt <= t_i, resolved PHASE-FIRST: the highest phase whose
        first round has updatedAt <= t_i wins; inside it, the largest round with updatedAt <= t_i.
  r_i = ln(P_i / P_{i-1});  RV = sum(r_i^2) * 31_536_000 / (end - start)   (WAD)
"""
import json
import os
import random
from decimal import Decimal, getcontext, ROUND_HALF_EVEN

getcontext().prec = 80
WAD = Decimal(10) ** 18
YEAR = 31_536_000
DEC = 8                      # feed decimals
SCALE = 10 ** (18 - DEC)     # 8 -> 18 dec

BASE_T = 1_800_000_000       # tests vm.warp to a time after every window end


def gbm_path(rng, p0, n, vol_per_step, drift=0.0):
    p = Decimal(p0)
    out = []
    for _ in range(n):
        z = Decimal(rng.gauss(drift, vol_per_step))
        p = p * z.exp()
        out.append(int(p))  # 8-dec integer answer
    return out


def sample(phases, t):
    """phases: list of dicts {phase, rounds:[(answer, updatedAt)]} sorted by phase asc. Returns (answer, roundId)."""
    for ph in sorted(phases, key=lambda x: -x["phase"]):
        rounds = ph["rounds"]
        if not rounds or rounds[0][1] > t:
            continue
        # largest round with updatedAt <= t (updatedAt monotone within a phase)
        lo, hi = 0, len(rounds) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if rounds[mid][1] <= t:
                lo = mid
            else:
                hi = mid - 1
        return rounds[lo][0], (ph["phase"] << 64) | (lo + 1)
    raise ValueError("window predates feed at t=%d" % t)


def expected(phases, start, end, interval):
    n = (end - start) // interval
    assert (end - start) % interval == 0 and n >= 1
    prices, rids = [], []
    for i in range(n + 1):
        a, rid = sample(phases, start + i * interval)
        prices.append(a * SCALE)
        rids.append(rid)
    s = Decimal(0)
    for i in range(1, n + 1):
        r = (Decimal(prices[i]) / Decimal(prices[i - 1])).ln()
        s += r * r
    rv = s * YEAR / Decimal(end - start)
    rv_wad = int((rv * WAD).to_integral_value(rounding=ROUND_HALF_EVEN))
    return rv_wad, n, prices, rids


def irregular_times(rng, t0, t1, mean_gap, jitter, big_gaps=()):
    """Round timestamps in [t0, t1) with jitter and optional forced long gaps [(from, to), ...]."""
    ts = []
    t = t0
    while t < t1:
        skip = False
        for a, b in big_gaps:
            if a <= t < b:
                t = b
                skip = True
                break
        if skip:
            continue
        ts.append(t)
        t += max(30, int(rng.gauss(mean_gap, jitter)))
    return ts


def make_case(name, phases_spec, start, end, interval):
    phases = [{"phase": p, "rounds": r} for p, r in phases_spec]
    rv_wad, n, prices, rids = expected(phases, start, end, interval)
    return {
        "name": name,
        "decimals": DEC,
        "start": start,
        "end": end,
        "interval": interval,
        "n_phases": len(phases),
        "phases": [
            {
                "phase": ph["phase"],
                "answers": [str(a) for a, _ in ph["rounds"]],
                "updated_ats": [t for _, t in ph["rounds"]],
            }
            for ph in phases
        ],
        "expected_rv_wad": str(rv_wad),
        "n_samples": n,
        "sample_prices": [str(p) for p in prices],
        "sample_round_ids": [str(r) for r in rids],
    }


def main():
    rng = random.Random(20260902)
    cases = []

    # 1) single phase, ~10 min rounds with jitter, 1 day @ 1h (24 samples), ~60% annualized vol
    t0 = BASE_T - 3 * 86400
    ts = irregular_times(rng, t0, t0 + 2 * 86400, 600, 240)
    ans = gbm_path(rng, 4_000_00000000, len(ts), 0.6 * (600 / YEAR) ** 0.5)
    cases.append(make_case("single_phase_1d_1h", [(1, list(zip(ans, ts)))], t0 + 3600, t0 + 3600 + 86400, 3600))

    # 2) irregular spacing incl. 3h gaps (several samples share a round -> zero returns), 2 days @ 2h
    t0 = BASE_T - 5 * 86400
    gaps = [(t0 + 20 * 3600, t0 + 23 * 3600 + 17), (t0 + 30 * 3600, t0 + 34 * 3600 + 5)]
    ts = irregular_times(rng, t0, t0 + 3 * 86400, 900, 800, gaps)
    ans = gbm_path(rng, 2_400_00000000, len(ts), 0.8 * (900 / YEAR) ** 0.5)
    cases.append(make_case("irregular_gaps_2d_2h", [(1, list(zip(ans, ts)))], t0 + 1800, t0 + 1800 + 2 * 86400, 7200))

    # 3) phase crossing WITH overlap: phase 2 starts while phase 1 still posts a few rounds after it.
    #    Phase precedence must pick phase 2 as soon as its first round is <= t_i.
    t0 = BASE_T - 10 * 86400
    ts1 = irregular_times(rng, t0, t0 + 5 * 86400 + 1500, 500, 200)         # phase 1 runs a bit past switch
    ans1 = gbm_path(rng, 3_000_00000000, len(ts1), 0.5 * (500 / YEAR) ** 0.5)
    switch = t0 + 5 * 86400
    ts2 = irregular_times(rng, switch, t0 + 9 * 86400, 480, 200)
    ans2 = gbm_path(rng, ans1[-1], len(ts2), 0.5 * (480 / YEAR) ** 0.5)
    cases.append(make_case("phase_crossing_overlap_7d_2h",
                           [(1, list(zip(ans1, ts1))), (2, list(zip(ans2, ts2)))],
                           t0 + 86400, t0 + 8 * 86400, 7200))

    # 4) phase crossing with a GAP (phase 1 stops, phase 2 begins 40 min later), 3 phases total,
    #    window starts inside phase 2 and ends in phase 3 -> exercises _findLast on a non-current phase.
    t0 = BASE_T - 12 * 86400
    ts1 = irregular_times(rng, t0, t0 + 2 * 86400, 600, 100)
    ans1 = gbm_path(rng, 1_800_00000000, len(ts1), 0.4 * (600 / YEAR) ** 0.5)
    ts2 = irregular_times(rng, t0 + 2 * 86400 + 2400, t0 + 7 * 86400, 700, 300)
    ans2 = gbm_path(rng, ans1[-1], len(ts2), 0.9 * (700 / YEAR) ** 0.5)
    ts3 = irregular_times(rng, t0 + 7 * 86400 + 60, t0 + 11 * 86400, 550, 250)
    ans3 = gbm_path(rng, ans2[-1], len(ts3), 0.7 * (550 / YEAR) ** 0.5)
    cases.append(make_case("phase_gap_three_phases_5d_1h",
                           [(1, list(zip(ans1, ts1))), (2, list(zip(ans2, ts2))), (3, list(zip(ans3, ts3)))],
                           t0 + 4 * 86400, t0 + 9 * 86400, 3600))

    # 5) extreme vol -> RV far above 1e18 (cap test on-chain)
    t0 = BASE_T - 2 * 86400
    ts = irregular_times(rng, t0, t0 + 86400 + 7200, 300, 60)
    ans = gbm_path(rng, 2_000_00000000, len(ts), 4.0 * (300 / YEAR) ** 0.5)
    cases.append(make_case("extreme_vol_1d_1h", [(1, list(zip(ans, ts)))], t0 + 600, t0 + 600 + 86400, 3600))

    # 6) flat prices -> RV == 0 exactly
    t0 = BASE_T - 86400
    ts = irregular_times(rng, t0, t0 + 43200, 600, 100)
    ans = [2_500_00000000] * len(ts)
    cases.append(make_case("flat_zero_rv_6h_30m", [(1, list(zip(ans, ts)))], t0 + 1800, t0 + 1800 + 6 * 3600, 1800))

    out = {"n_cases": len(cases), "year": YEAR, "cases": cases}
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.normpath(os.path.join(here, "..", "..", "test", "vectors", "rv_vectors.json"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(out, f, indent=1)
    for c in cases:
        rv = Decimal(c["expected_rv_wad"]) / WAD
        print("%-32s n=%-4d rounds=%-5d RV=%.6f  vol=%.2f%%" % (
            c["name"], c["n_samples"], sum(len(p["answers"]) for p in c["phases"]), rv, (rv.sqrt() * 100)))
    print("wrote", path)


if __name__ == "__main__":
    main()
