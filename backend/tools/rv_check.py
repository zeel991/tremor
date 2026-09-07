#!/usr/bin/env python3
"""Reference vectors for the off-chain realized-variance math (ARCHITECTURE §1).

    r_i = ln(P_i / P_{i-1}),  RV = sum(r_i^2) * 31_536_000 / (expiry - start)

Prints JSON with the vectors used by `src/rv.rs` unit tests. Run: python3 tools/rv_check.py
"""
import json, math
from decimal import Decimal, getcontext

getcontext().prec = 50
YEAR = Decimal(31_536_000)

def rv(prices, span):
    s = Decimal(0)
    for a, b in zip(prices, prices[1:]):
        r = (Decimal(b) / Decimal(a)).ln()
        s += r * r
    return s * YEAR / Decimal(span)

vectors = {}

# 1. flat path: 25 samples hourly (24 intervals) -> zero variance
flat = [3000.0] * 25
vectors["flat_24h"] = {"prices": flat, "span": 86400, "rv": str(rv(flat, 86400))}

# 2. alternating +1% / -1% hourly for 24h: r = +-ln(1.01), RV = 24 * ln(1.01)^2 * 365
alt = [3000.0]
for i in range(24):
    alt.append(alt[-1] * (1.01 if i % 2 == 0 else 1 / 1.01))
closed = 24 * Decimal(1.01).ln() ** 2 * 365
vectors["alternating_1pct_24h"] = {"prices": alt, "span": 86400, "rv": str(rv(alt, 86400)), "closed_form": str(closed)}

# 3. big move: +50% then flat over a 1h window -> RV far above any sane cap; off-chain never caps
big = [2000.0, 3000.0, 3000.0]
vectors["uncapped_big_move"] = {"prices": big, "span": 3600, "rv": str(rv(big, 3600))}

# 4. irregular: 7 daily samples
daily = [2500.0, 2450.0, 2600.0, 2580.0, 2700.0, 2650.0, 2610.0]
vectors["weekly_daily"] = {"prices": daily, "span": 6 * 86400, "rv": str(rv(daily, 6 * 86400))}

print(json.dumps(vectors, indent=2))
