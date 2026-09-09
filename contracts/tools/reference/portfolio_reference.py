#!/usr/bin/env python3
"""Independent reference model for the v3 portfolio mathematics.

Computes, in exact rational arithmetic (fractions.Fraction), the quantities
`PortfolioMath.sol` implements in integer arithmetic, and emits
test/vectors/portfolio_vectors.json for `PortfolioVectors.t.sol` to pin against.

For each case (S, h, c, finalVariance, capVariance):
  x            = min(finalVariance / capVariance, 1)                  (WAD, floored)
  reserve      = ceil(max(h, c) * S / 1e18)
  high_ppu     = floor(S * x / 1e18)
  calm_ppu     = S - high_ppu
  final_locked = floor(h * high_ppu / 1e18) + floor(c * calm_ppu / 1e18)
  worst        = max over a dense rational grid of x' in [0,1] of
                 floor(h*hp(x')/1e18) + floor(c*cp(x')/1e18)          (801 points + endpoints)

and asserts reserve >= worst and reserve >= final_locked exactly.
"""

import json
import math
import os
from fractions import Fraction

WAD = 10**18


def x_wad(final_variance: int, cap: int) -> int:
    if final_variance >= cap:
        return WAD
    return final_variance * WAD // cap


def high_ppu(s: int, x: int) -> int:
    return s * x // WAD


def reserve(h: int, c: int, s: int) -> int:
    return -((-max(h, c) * s) // WAD)  # ceil


def final_locked(h: int, c: int, s: int, x: int) -> int:
    hp = high_ppu(s, x)
    cp = s - hp
    return h * hp // WAD + c * cp // WAD


def worst_case(h: int, c: int, s: int) -> int:
    worst = 0
    for i in range(0, 802):
        x = Fraction(i, 801) if i <= 801 else Fraction(1)
        xw = math.floor(x * WAD)
        worst = max(worst, final_locked(h, c, s, xw))
    return worst


def main() -> None:
    cases = []
    scales = [1, 3, 10**6, 999_999, 10**7]
    quantities = [
        (0, 0),
        (1, 0),
        (10**18, 10**18),
        (100 * 10**18, 100 * 10**18),
        (100 * 10**18, 40 * 10**18),
        (7, 13),
        (10**18 + 1, 10**18 - 1),
        (12345678901234567890, 9876543210987654321),
        (1000 * 10**18, 1),
    ]
    variances = [(0, 10**18), (3 * 10**17, 10**18), (10**18, 10**18), (25 * 10**17, 10**18), (5 * 10**17, 4 * 10**18)]

    for s in scales:
        for h, c in quantities:
            for fv, cap in variances:
                x = x_wad(fv, cap)
                r = reserve(h, c, s)
                hp = high_ppu(s, x)
                cp = s - hp
                fl = final_locked(h, c, s, x)
                w = worst_case(h, c, s)
                assert hp + cp == s
                assert r >= w, (s, h, c)
                assert r >= fl
                cases.append(
                    {
                        "s": str(s),
                        "h": str(h),
                        "c": str(c),
                        "final_variance": str(fv),
                        "cap_variance": str(cap),
                        "x_wad": str(x),
                        "reserve": str(r),
                        "high_ppu": str(hp),
                        "calm_ppu": str(cp),
                        "final_locked": str(fl),
                        "worst_case": str(w),
                    }
                )

    out = {
        "generator": "tools/reference/portfolio_reference.py",
        "arithmetic": "exact rational (fractions.Fraction) / exact integer",
        "n_cases": len(cases),
        "cases": cases,
    }
    path = os.path.join(os.path.dirname(__file__), "..", "..", "test", "vectors", "portfolio_vectors.json")
    with open(os.path.abspath(path), "w") as f:
        json.dump(out, f, indent=1)
    print(f"wrote {len(cases)} cases")


if __name__ == "__main__":
    main()
