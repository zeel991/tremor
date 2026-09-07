#!/usr/bin/env python3
"""
Tremor v2 market-pricing reference.

Independent, 60-digit-precision model of every executable formula in `src/libs/VariancePricing.sol`,
written from the specification rather than transcribed from the Solidity, so the two are a genuine
cross-check. Output: test/vectors/pricing_vectors.json, consumed by test/MarketPricing.t.sol.

Definitions (must match VariancePricing.sol exactly):

  decayedSkew      = trunc_toward_zero(skew * expWad(ln(1/2) * dt / halfLife) / 1e18)
  forward          = clamp(anchor + decayedSkew, 0, cap)
  projected        = floor((realizedSoFar * elapsed + forward * remaining) / (elapsed + remaining))
  ask              = min(ceil(projected * (10_000 + s) / 10_000), cap)
  bid              = min(floor(projected * (10_000 - s) / 10_000), cap)
  askSlope         = ceil(impact * remaining * (10_000 + s) / (duration * 10_000))
  bidSlope         = floor(impact * remaining * (10_000 - s) / (duration * 10_000))
  premium(u)       = ceil(unitNotional * (ask * u + ceil(askSlope * u^2 / 2e18)) / 1e36)
  unitsFor(x)      = floor(2X / (ask + ceilSqrt(ask^2 + ceil(2 * askSlope * X / 1e18)))),
                     X = floor(amountIn * 1e36 / unitNotional);  == floor(X / ask) when askSlope == 0
  proceeds(u)      = floor(unitNotional * (bid * u - floor(bidSlope * u^2 / 2e18)) / 1e36)
  unitsToCap       = floor((cap - ask) * 1e18 / askSlope)
  unitsToZeroBid   = floor(bid * 1e18 / bidSlope)
  payoutPerUnit    = floor(unitNotional * min(finalVariance, cap) / 1e18)
  maxLiability(u)  = ceil(u * unitNotional * cap / 1e36)
  finalLiability(u)= ceil(u * payoutPerUnit / 1e18)

`expWad` is Solady's; the reference reproduces it as a high-precision exponential floored to WAD, which
is exact for the decay factors used here to well beyond the 1e-12 tolerance the suite asserts.
"""
import json
import os
import random
from decimal import Decimal, getcontext

getcontext().prec = 60

WAD = 10**18
WAD2 = 10**36
BPS = 10_000
YEAR = 31_536_000
LN_HALF_WAD = -693_147_180_559_945_309


def ceil_div(a, b):
    return -(-a // b)


def isqrt_ceil(n):
    r = isqrt(n)
    return r if r * r == n else r + 1


def isqrt(n):
    if n == 0:
        return 0
    x = int(Decimal(n).sqrt())
    while x * x > n:
        x -= 1
    while (x + 1) * (x + 1) <= n:
        x += 1
    return x


def exp_wad(x_wad):
    """Solady expWad for x <= 0: floor(exp(x/1e18) * 1e18), saturating to 0 far from the origin."""
    if x_wad <= -42_139_678_854_452_767_551:
        return 0
    return int((Decimal(x_wad) / WAD).exp() * WAD)


def decay_skew(skew, dt, half_life):
    if skew == 0 or dt == 0 or half_life == 0:
        return skew
    factor = exp_wad(LN_HALF_WAD * dt // half_life)
    # Solidity integer division truncates toward zero for signed values.
    q = abs(skew) * factor // WAD
    return q if skew > 0 else -q


def forward_variance(anchor, decayed, cap):
    v = anchor + decayed
    if v <= 0:
        return 0
    return min(v, cap)


def projected_variance(realized, elapsed, forward, remaining):
    duration = elapsed + remaining
    if duration == 0:
        return forward
    return (realized * elapsed + forward * remaining) // duration


def bid_ask(projected, half_spread_bps, cap):
    ask = min(ceil_div(projected * (BPS + half_spread_bps), BPS), cap)
    bid = min(projected * (BPS - half_spread_bps) // BPS, cap)
    return bid, ask


def ask_slope(impact, remaining, duration, half_spread_bps):
    if impact == 0 or remaining == 0 or duration == 0:
        return 0
    return ceil_div(impact * remaining * (BPS + half_spread_bps), duration * BPS)


def bid_slope(impact, remaining, duration, half_spread_bps):
    if impact == 0 or remaining == 0 or duration == 0:
        return 0
    return impact * remaining * (BPS - half_spread_bps) // (duration * BPS)


def issue_premium(ask, slope, unit_notional, units):
    if units == 0:
        return 0
    integral = ask * units + ceil_div(slope * units * units, 2 * WAD)
    return ceil_div(unit_notional * integral, WAD2)


def issue_units_for(ask, slope, unit_notional, amount_in):
    if ask == 0 or amount_in == 0:
        return 0
    x = amount_in * WAD2 // unit_notional
    if slope == 0:
        return x // ask
    discriminant = ask * ask + ceil_div(2 * slope * x, WAD)
    root = isqrt_ceil(discriminant)
    return (2 * x) // (ask + root)


def issue_units_to_cap(ask, slope, cap):
    if ask >= cap:
        return 0
    if slope == 0:
        return None  # unbounded
    return (cap - ask) * WAD // slope


def issue_units_to_collateral(outstanding, locked, free, unit_notional, cap):
    allowed = locked + free
    denominator = unit_notional * cap
    if denominator == 0:
        return None
    total = allowed * WAD2 // denominator
    return total - outstanding if total > outstanding else 0


def exit_proceeds(bid, slope, unit_notional, units):
    if units == 0:
        return 0
    gross = bid * units
    impact = slope * units * units // (2 * WAD)
    return unit_notional * (gross - impact) // WAD2


def exit_units_to_zero_bid(bid, slope):
    if slope == 0:
        return None
    return bid * WAD // slope


def payout_per_unit(final_variance, cap, unit_notional):
    return unit_notional * min(final_variance, cap) // WAD


def settle_proceeds(units, ppu):
    return units * ppu // WAD


def max_liability(units, unit_notional, cap):
    if units == 0:
        return 0
    return ceil_div(units * unit_notional * cap, WAD2)


def final_liability(units, ppu):
    if units == 0:
        return 0
    return ceil_div(units * ppu, WAD)


def annualize(sum_squared, elapsed):
    if elapsed == 0:
        return 0
    return sum_squared * YEAR // elapsed


UNBOUNDED = (1 << 256) - 1


def build_cases():
    rng = random.Random(20260908)
    cases = []

    def add(name, **kw):
        anchor = kw["anchor"]
        cap = kw["cap"]
        skew = kw["skew"]
        dt = kw["dt"]
        half_life = kw["half_life"]
        realized = kw["realized"]
        elapsed = kw["elapsed"]
        remaining = kw["remaining"]
        impact = kw["impact"]
        spread = kw["spread"]
        notional = kw["notional"]
        units = kw["units"]
        amount_in = kw["amount_in"]
        outstanding = kw["outstanding"]
        free = kw["free"]

        duration = elapsed + remaining
        decayed = decay_skew(skew, dt, half_life)
        forward = forward_variance(anchor, decayed, cap)
        projected = projected_variance(realized, elapsed, forward, remaining)
        bid, ask = bid_ask(projected, spread, cap)
        a_slope = ask_slope(impact, remaining, duration, spread)
        b_slope = bid_slope(impact, remaining, duration, spread)
        locked = max_liability(outstanding, notional, cap)
        to_cap = issue_units_to_cap(ask, a_slope, cap)
        to_zero = exit_units_to_zero_bid(bid, b_slope)
        capacity = issue_units_to_collateral(outstanding, locked, free, notional, cap)
        exit_units = units if to_zero is None else min(units, to_zero)
        ppu = payout_per_unit(kw["final_variance"], cap, notional)

        cases.append(
            {
                "name": name,
                "anchor": str(anchor),
                "cap": str(cap),
                "skew": str(skew),
                "dt": str(dt),
                "half_life": str(half_life),
                "realized": str(realized),
                "elapsed": str(elapsed),
                "remaining": str(remaining),
                "impact": str(impact),
                "spread": str(spread),
                "notional": str(notional),
                "units": str(units),
                "amount_in": str(amount_in),
                "outstanding": str(outstanding),
                "free": str(free),
                "final_variance": str(kw["final_variance"]),
                "sum_squared": str(kw["sum_squared"]),
                # expectations
                "decayed_skew": str(decayed),
                "forward": str(forward),
                "projected": str(projected),
                "bid_variance": str(bid),
                "ask_variance": str(ask),
                "ask_slope": str(a_slope),
                "bid_slope": str(b_slope),
                "premium": str(issue_premium(ask, a_slope, notional, units)),
                "units_for": str(issue_units_for(ask, a_slope, notional, amount_in)),
                "units_to_cap": str(UNBOUNDED if to_cap is None else to_cap),
                "units_to_collateral": str(UNBOUNDED if capacity is None else capacity),
                "exit_units": str(exit_units),
                "exit_proceeds": str(exit_proceeds(bid, b_slope, notional, exit_units)),
                "units_to_zero_bid": str(UNBOUNDED if to_zero is None else to_zero),
                "payout_per_unit": str(ppu),
                "settle_proceeds": str(settle_proceeds(units, ppu)),
                "max_liability": str(max_liability(units, notional, cap)),
                "final_liability": str(final_liability(units, ppu)),
                "locked_for_outstanding": str(locked),
                "annualized": str(annualize(kw["sum_squared"], elapsed)),
            }
        )

    base = dict(
        anchor=250_000_000_000_000_000,
        cap=10**18,
        skew=0,
        dt=0,
        half_life=6 * 3600,
        realized=0,
        elapsed=0,
        remaining=7 * 86400,
        impact=10**16,
        spread=200,
        notional=100_000_000,
        units=10 * 10**18,
        amount_in=1_000_000_000,
        outstanding=0,
        free=100_000_000_000,
        final_variance=300_000_000_000_000_000,
        sum_squared=5_000_000_000_000_000,
    )

    add("fresh forward market", **base)
    add("positive skew, one half-life old", **{**base, "skew": 5 * 10**16, "dt": 6 * 3600})
    add("negative skew, no decay", **{**base, "skew": -5 * 10**16, "dt": 3 * 86400, "half_life": 0})
    add("skew decayed to dust", **{**base, "skew": 10**17, "dt": 365 * 86400, "half_life": 300})
    add("skew below zero floor", **{**base, "skew": -(10**18), "dt": 0})
    add("skew above the cap", **{**base, "skew": 3 * 10**18, "dt": 0})
    add(
        "half elapsed, realized under the market",
        **{**base, "realized": 10**17, "elapsed": 3 * 86400 + 43200, "remaining": 3 * 86400 + 43200},
    )
    add(
        "half elapsed, realized over the cap",
        **{**base, "realized": 2 * 10**18, "elapsed": 3 * 86400, "remaining": 4 * 86400},
    )
    add("at expiry, projection is realized", **{**base, "realized": 4 * 10**17, "elapsed": 7 * 86400, "remaining": 0})
    add("zero impact, flat book", **{**base, "impact": 0})
    add("widest allowed spread", **{**base, "spread": 2000})
    add("tightest allowed spread", **{**base, "spread": 10})
    add("collateral almost exhausted", **{**base, "outstanding": 90 * 10**18, "free": 1_000_000_000})
    add("no free collateral", **{**base, "outstanding": 50 * 10**18, "free": 0})
    add("one wei of quote in", **{**base, "amount_in": 1})
    add("single base unit of receipt", **{**base, "units": 1})
    add("final variance above the cap", **{**base, "final_variance": 9 * 10**18})
    add("final variance zero", **{**base, "final_variance": 0})
    add(
        "big notional and units",
        **{
            **base,
            "notional": 1_000_000_000_000,
            "units": 1_000 * 10**18,
            "amount_in": 10**15,
            "free": 10**24,
        },
    )
    add("cap at the factory ceiling", **{**base, "cap": 4 * 10**18, "impact": 4 * 10**18})

    for i in range(40):
        cap = rng.randrange(10**16, 4 * 10**18)
        anchor = rng.randrange(1, cap + 1)
        remaining = rng.randrange(0, 40 * 86400)
        elapsed = rng.randrange(0, 40 * 86400)
        notional = rng.randrange(1, 10**12)
        outstanding = rng.randrange(0, 10**21)
        add(
            f"random {i}",
            anchor=anchor,
            cap=cap,
            skew=rng.randrange(-(10**19), 10**19),
            dt=rng.randrange(0, 90 * 86400),
            half_life=rng.choice([0, 300, 3600, 6 * 3600, 30 * 86400]),
            realized=rng.randrange(0, 10**19),
            elapsed=elapsed,
            remaining=remaining,
            impact=rng.randrange(0, cap + 1),
            spread=rng.randrange(10, 2001),
            notional=notional,
            units=rng.randrange(1, 10**21),
            amount_in=rng.randrange(1, 10**14),
            outstanding=outstanding,
            free=rng.randrange(0, 10**15),
            final_variance=rng.randrange(0, 5 * 10**18),
            sum_squared=rng.randrange(0, 10**18),
        )

    return cases


def main():
    cases = build_cases()
    out = {
        "generator": "tools/reference/pricing_reference.py",
        "precision": 60,
        "n_cases": len(cases),
        "cases": cases,
    }
    path = os.path.join(os.path.dirname(__file__), "..", "..", "test", "vectors", "pricing_vectors.json")
    path = os.path.normpath(path)
    with open(path, "w") as fh:
        json.dump(out, fh, indent=1)
    print(f"wrote {len(out['cases'])} cases to {path}")


if __name__ == "__main__":
    main()
