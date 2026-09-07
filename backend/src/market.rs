//! Off-chain replica of `contracts/src/libs/VariancePricing.sol`, used to draw the market chart.
//!
//! This is a REPLICA, not an authority. Anything a user can execute against — the ask they pay, the bid
//! they hit, the payout they redeem — comes from `TremorLens`, which calls the same engine the router
//! does. What lives here is the historical path: what the market's bid and ask were at each point in
//! the past, reconstructed from indexed fills and checkpoints, because no contract stores that.
//!
//! Every formula is integer arithmetic in the same order as the Solidity, with one documented
//! exception: the inventory-skew decay factor `2^(-dt/halfLife)` is evaluated in floating point and
//! then floored to WAD, because Solady's `expWad` is a rational approximation this replica has no
//! reason to reproduce bit-for-bit. Its relative error is around 1e-16, which is four orders of
//! magnitude below the smallest pixel of a chart and never reaches an executable number.

// This module is a complete replica of `VariancePricing.sol`, including the parts the current API
// endpoints do not read. Keeping the whole library here is deliberate: it is what makes the file
// checkable against the Solidity as a unit, and its tests exercise every function.
#![allow(dead_code)]

use alloy::primitives::{I256, U256};
use serde::Serialize;

pub const WAD: u128 = 1_000_000_000_000_000_000;
pub const WAD2: u128 = 1_000_000_000_000_000_000_000_000_000_000_000_000;
pub const BPS: u64 = 10_000;
pub const YEAR: u64 = 31_536_000;

fn wad() -> U256 {
    U256::from(WAD)
}

fn wad2() -> U256 {
    U256::from(WAD2)
}

fn ceil_div(a: U256, b: U256) -> U256 {
    if b.is_zero() {
        U256::ZERO
    } else {
        (a + b - U256::from(1)) / b
    }
}

/// Immutable series terms, as integers.
#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub start: u64,
    pub expiry: u64,
    pub sample_interval: u64,
    pub unit_notional: u128,
    pub cap_variance: u128,
    pub anchor_variance: u128,
    pub impact_per_unit: u128,
    pub half_life: u32,
    pub half_spread_bps: u16,
}

/// One indexed flow: units sold (positive) or bought back (negative) at a moment in time.
#[derive(Clone, Copy, Debug)]
pub struct Flow {
    pub t: u64,
    pub units_delta: i128,
}

/// One indexed checkpoint: the window covered and the accumulated sum of squared log returns.
#[derive(Clone, Copy, Debug)]
pub struct Checkpoint {
    pub t: u64,
    pub processed_through: u64,
    /// WAD sum of squared log returns at that point.
    pub sum_squared_returns: u128,
}

/// One point on the market chart. Every field is a decimal string so the browser never sees a float
/// where an integer was meant; the `*_float` conveniences are for axis scaling only.
#[derive(Clone, Debug, Serialize)]
pub struct MarketPoint {
    pub t: u64,
    pub processed_through: u64,
    pub realized_variance: String,
    pub realized_vol: f64,
    pub market_variance: String,
    pub market_vol: f64,
    pub projected_variance: String,
    pub projected_vol: f64,
    pub bid_variance: String,
    pub ask_variance: String,
    pub bid_per_unit: String,
    pub ask_per_unit: String,
    pub checkpoints_fresh: bool,
}

/// `2^(-dt/halfLife)` scaled to WAD, floored. `halfLife == 0` means the skew never decays.
fn decay_factor_wad(dt: u64, half_life: u32) -> u128 {
    if half_life == 0 || dt == 0 {
        return WAD;
    }
    let exponent = -(dt as f64) / (half_life as f64);
    let factor = 2f64.powf(exponent);
    if !factor.is_finite() || factor <= 0.0 {
        return 0;
    }
    (factor * WAD as f64).floor() as u128
}

/// Signed inventory skew (WAD) at time `t`, replaying flows in order with decay between them.
///
/// The contract decays the stored skew to "now" and adds the new impact on every fill, so replaying
/// the same sequence in the same order is what reproduces it — decaying each flow independently from
/// its own timestamp would not, because the decay is applied to the running total.
pub fn skew_at(p: &Params, flows: &[Flow], t: u64) -> I256 {
    let mut skew = I256::ZERO;
    let mut last = p.start;
    for f in flows.iter().filter(|f| f.t <= t) {
        skew = decay_skew(skew, f.t.saturating_sub(last), p.half_life);
        let magnitude = U256::from(f.units_delta.unsigned_abs()) * U256::from(p.impact_per_unit)
            / U256::from(WAD);
        let delta = I256::try_from(magnitude).unwrap_or(I256::ZERO);
        skew = if f.units_delta >= 0 {
            skew.saturating_add(delta)
        } else {
            skew.saturating_sub(delta)
        };
        last = f.t;
    }
    decay_skew(skew, t.saturating_sub(last), p.half_life)
}

fn decay_skew(skew: I256, dt: u64, half_life: u32) -> I256 {
    if skew.is_zero() || dt == 0 || half_life == 0 {
        return skew;
    }
    let factor = U256::from(decay_factor_wad(dt, half_life));
    let negative = skew.is_negative();
    let magnitude = skew.unsigned_abs() * factor / U256::from(WAD);
    let out = I256::try_from(magnitude).unwrap_or(I256::ZERO);
    if negative {
        -out
    } else {
        out
    }
}

/// `clamp(anchor + decayedSkew, 0, cap)`.
pub fn forward_variance(p: &Params, decayed_skew: I256) -> U256 {
    let anchor = I256::try_from(U256::from(p.anchor_variance)).unwrap_or(I256::ZERO);
    let v = anchor.saturating_add(decayed_skew);
    if v.is_negative() {
        return U256::ZERO;
    }
    let v = v.unsigned_abs();
    v.min(U256::from(p.cap_variance))
}

/// `(realizedSoFar * elapsed + forward * remaining) / duration`, unclamped.
pub fn projected_variance(realized: U256, elapsed: u64, forward: U256, remaining: u64) -> U256 {
    let duration = elapsed.saturating_add(remaining);
    if duration == 0 {
        return forward;
    }
    (realized * U256::from(elapsed) + forward * U256::from(remaining)) / U256::from(duration)
}

/// `floor(sumSquaredReturns * 31_536_000 / elapsed)`.
pub fn annualize(sum_squared_returns: u128, elapsed: u64) -> U256 {
    if elapsed == 0 {
        return U256::ZERO;
    }
    U256::from(sum_squared_returns) * U256::from(YEAR) / U256::from(elapsed)
}

/// `(bid, ask)`: the half-spread applied to the projection, then clamped to the cap so a quote can
/// never promise more than a receipt can pay.
pub fn bid_ask_variance(projected: U256, half_spread_bps: u16, cap: u128) -> (U256, U256) {
    let bps = U256::from(BPS);
    let cap = U256::from(cap);
    let ask = ceil_div(projected * (bps + U256::from(half_spread_bps)), bps).min(cap);
    let bid = (projected * (bps - U256::from(half_spread_bps)) / bps).min(cap);
    (bid, ask)
}

/// `floor(unitNotional * variance / 1e18)`.
pub fn per_unit_price(unit_notional: u128, variance: U256) -> U256 {
    U256::from(unit_notional) * variance / wad()
}

/// `floor(unitNotional * min(finalVariance, cap) / 1e18)`.
pub fn payout_per_unit(final_variance: U256, cap: u128, unit_notional: u128) -> U256 {
    let capped = final_variance.min(U256::from(cap));
    U256::from(unit_notional) * capped / wad()
}

/// `ceil(units * unitNotional * cap / 1e36)`.
pub fn max_liability(units: U256, unit_notional: u128, cap: u128) -> U256 {
    if units.is_zero() {
        return U256::ZERO;
    }
    ceil_div(units * U256::from(unit_notional) * U256::from(cap), wad2())
}

/// The checkpoint state in force at time `t`: the window covered and the variance accumulated.
fn checkpoint_at(p: &Params, checkpoints: &[Checkpoint], t: u64) -> (u64, u128) {
    let mut processed_through = p.start;
    let mut sum = 0u128;
    for c in checkpoints.iter().filter(|c| c.t <= t) {
        processed_through = c.processed_through;
        sum = c.sum_squared_returns;
    }
    (processed_through, sum)
}

/// The whole market at one moment, reconstructed from indexed history.
pub fn market_at(p: &Params, flows: &[Flow], checkpoints: &[Checkpoint], t: u64) -> MarketPoint {
    let (processed_through, sum) = checkpoint_at(p, checkpoints, t);
    let elapsed = processed_through.saturating_sub(p.start);
    let remaining = p.expiry.saturating_sub(processed_through);
    let realized = annualize(sum, elapsed);

    let forward = forward_variance(p, skew_at(p, flows, t));
    let projected = projected_variance(realized, elapsed, forward, remaining);
    let (bid, ask) = bid_ask_variance(projected, p.half_spread_bps, p.cap_variance);

    // A window is fresh when the last checkpoint covers every sample time that has passed.
    let due = if t < p.start {
        p.start
    } else {
        let limit = t.min(p.expiry);
        let interval = p.sample_interval.max(1);
        p.start + ((limit - p.start) / interval) * interval
    };

    MarketPoint {
        t,
        processed_through,
        realized_variance: realized.to_string(),
        realized_vol: vol_float(realized),
        market_variance: forward.to_string(),
        market_vol: vol_float(forward),
        projected_variance: projected.to_string(),
        projected_vol: vol_float(projected),
        bid_variance: bid.to_string(),
        ask_variance: ask.to_string(),
        bid_per_unit: per_unit_price(p.unit_notional, bid).to_string(),
        ask_per_unit: per_unit_price(p.unit_notional, ask).to_string(),
        checkpoints_fresh: processed_through >= due,
    }
}

/// The market path over `[from, to]` at `points` evenly spaced samples, plus a point at every flow and
/// every checkpoint so the chart shows the steps rather than smoothing over them.
pub fn path(
    p: &Params,
    flows: &[Flow],
    checkpoints: &[Checkpoint],
    from: u64,
    to: u64,
    points: usize,
) -> Vec<MarketPoint> {
    if to < from || points == 0 {
        return Vec::new();
    }
    let mut times: Vec<u64> = Vec::with_capacity(points + flows.len() + checkpoints.len() + 2);
    let span = to - from;
    for i in 0..points {
        times.push(from + (span * i as u64) / points as u64);
    }
    times.push(to);
    for f in flows {
        if f.t >= from && f.t <= to {
            times.push(f.t);
        }
    }
    for c in checkpoints {
        if c.t >= from && c.t <= to {
            times.push(c.t);
        }
    }
    times.sort_unstable();
    times.dedup();
    times
        .into_iter()
        .map(|t| market_at(p, flows, checkpoints, t))
        .collect()
}

/// Annualized volatility as a fraction (0.4 = 40%), for axis scaling only.
pub fn vol_float(variance: U256) -> f64 {
    let v = u128::try_from(variance).unwrap_or(u128::MAX) as f64 / WAD as f64;
    if v <= 0.0 {
        0.0
    } else {
        v.sqrt()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> Params {
        Params {
            start: 1_000_000,
            expiry: 1_000_000 + 7 * 86_400,
            sample_interval: 7_200,
            unit_notional: 100_000_000, // 100 USDC
            cap_variance: WAD,          // 100% vol
            anchor_variance: WAD / 4,   // 50% vol
            impact_per_unit: WAD / 100,
            half_life: 6 * 3_600,
            half_spread_bps: 200,
        }
    }

    #[test]
    fn a_fresh_market_sits_at_its_anchor_and_quotes_around_it() {
        let p = params();
        let m = market_at(&p, &[], &[], p.start);
        assert_eq!(m.market_variance, (WAD / 4).to_string());
        assert_eq!(
            m.projected_variance,
            (WAD / 4).to_string(),
            "with nothing elapsed the projection is exactly the forward variance"
        );
        // ask = ceil(0.25 * 1.02) = 0.255, bid = floor(0.25 * 0.98) = 0.245
        assert_eq!(m.ask_variance, "255000000000000000");
        assert_eq!(m.bid_variance, "245000000000000000");
        // per unit: 100 USDC * variance
        assert_eq!(m.ask_per_unit, "25500000");
        assert_eq!(m.bid_per_unit, "24500000");
        assert!(m.bid_per_unit.parse::<u128>().unwrap() < m.ask_per_unit.parse::<u128>().unwrap());
    }

    #[test]
    fn selling_inventory_raises_the_ask_and_buying_it_back_lowers_it() {
        let p = params();
        let base = market_at(&p, &[], &[], p.start);
        let sold = market_at(
            &p,
            &[Flow {
                t: p.start,
                units_delta: 20 * WAD as i128,
            }],
            &[],
            p.start,
        );
        assert!(
            sold.ask_variance.parse::<u128>().unwrap() > base.ask_variance.parse::<u128>().unwrap()
        );
        let bought_back = market_at(
            &p,
            &[
                Flow {
                    t: p.start,
                    units_delta: 20 * WAD as i128,
                },
                Flow {
                    t: p.start + 1,
                    units_delta: -20 * WAD as i128,
                },
            ],
            &[],
            p.start + 1,
        );
        assert!(
            bought_back.ask_variance.parse::<u128>().unwrap()
                < sold.ask_variance.parse::<u128>().unwrap()
        );
    }

    #[test]
    fn the_skew_halves_over_a_half_life() {
        let p = params();
        let flows = [Flow {
            t: p.start,
            units_delta: 100 * WAD as i128,
        }];
        let immediate = skew_at(&p, &flows, p.start);
        let one_half_life = skew_at(&p, &flows, p.start + p.half_life as u64);
        let expected = immediate / I256::try_from(2).unwrap();
        let diff = (one_half_life - expected).unsigned_abs();
        assert!(
            diff < U256::from(WAD / 1_000_000),
            "decay drifted: {one_half_life} vs {expected}"
        );
    }

    #[test]
    fn a_zero_half_life_never_decays() {
        let mut p = params();
        p.half_life = 0;
        let flows = [Flow {
            t: p.start,
            units_delta: 10 * WAD as i128,
        }];
        assert_eq!(
            skew_at(&p, &flows, p.start),
            skew_at(&p, &flows, p.start + 365 * 86_400)
        );
    }

    #[test]
    fn the_projection_converges_to_the_realized_path_at_expiry() {
        let p = params();
        let duration = p.expiry - p.start;
        // A checkpoint covering the whole window: the projection must be exactly the realized variance.
        let checkpoints = [Checkpoint {
            t: p.expiry,
            processed_through: p.expiry,
            sum_squared_returns: 100_000_000_000_000, // 1e14 WAD
        }];
        let m = market_at(&p, &[], &checkpoints, p.expiry);
        let expected = annualize(100_000_000_000_000, duration);
        assert_eq!(m.realized_variance, expected.to_string());
        assert_eq!(m.projected_variance, expected.to_string());
    }

    #[test]
    fn the_bid_and_ask_are_clamped_to_the_cap() {
        let p = params();
        // A realized path far above the cap: the projection is honest, the quotes are not above the cap.
        let checkpoints = [Checkpoint {
            t: p.expiry,
            processed_through: p.expiry,
            sum_squared_returns: 10_000_000_000_000_000_000, // enormous
        }];
        let m = market_at(&p, &[], &checkpoints, p.expiry);
        assert!(m.projected_variance.parse::<u128>().unwrap() > p.cap_variance);
        assert_eq!(m.ask_variance, p.cap_variance.to_string());
        assert_eq!(m.bid_variance, p.cap_variance.to_string());
        assert_eq!(
            m.bid_per_unit,
            per_unit_price(p.unit_notional, U256::from(p.cap_variance)).to_string()
        );
    }

    #[test]
    fn freshness_tracks_the_last_checkpoint_against_the_samples_that_have_passed() {
        let p = params();
        let checkpoints = [Checkpoint {
            t: p.start,
            processed_through: p.start,
            sum_squared_returns: 0,
        }];
        assert!(market_at(&p, &[], &checkpoints, p.start).checkpoints_fresh);
        assert!(
            !market_at(&p, &[], &checkpoints, p.start + 3 * p.sample_interval).checkpoints_fresh,
            "three sample times passed with nothing checkpointed"
        );
    }

    #[test]
    fn the_path_includes_a_point_at_every_flow_and_checkpoint() {
        let p = params();
        let flows = [Flow {
            t: p.start + 1_234,
            units_delta: WAD as i128,
        }];
        let checkpoints = [Checkpoint {
            t: p.start + 4_321,
            processed_through: p.start,
            sum_squared_returns: 0,
        }];
        let pts = path(&p, &flows, &checkpoints, p.start, p.start + 86_400, 20);
        assert!(pts.iter().any(|x| x.t == p.start + 1_234));
        assert!(pts.iter().any(|x| x.t == p.start + 4_321));
        assert!(
            pts.windows(2).all(|w| w[0].t < w[1].t),
            "path must be sorted and deduped"
        );
        assert!(path(&p, &[], &[], 10, 5, 20).is_empty());
        assert!(path(&p, &[], &[], 5, 10, 0).is_empty());
    }

    #[test]
    fn liability_matches_the_solidity_rounding() {
        // 10 units * 100 USDC * 1.0 variance = 1000 USDC exactly
        assert_eq!(
            max_liability(U256::from(10u128 * WAD), 100_000_000, WAD),
            U256::from(1_000_000_000u64)
        );
        // one wei of receipt at a notional of 1 and a cap of 1 still reserves a whole base unit
        assert_eq!(max_liability(U256::from(1), 1, 1), U256::from(1));
        assert_eq!(max_liability(U256::ZERO, 100_000_000, WAD), U256::ZERO);
    }

    #[test]
    fn the_payout_is_capped() {
        assert_eq!(
            payout_per_unit(U256::from(2 * WAD), WAD, 100_000_000),
            U256::from(100_000_000u64)
        );
        assert_eq!(
            payout_per_unit(U256::from(WAD / 2), WAD, 100_000_000),
            U256::from(50_000_000u64)
        );
        assert_eq!(payout_per_unit(U256::ZERO, WAD, 100_000_000), U256::ZERO);
    }

    #[test]
    fn vol_is_the_square_root_of_variance() {
        assert!((vol_float(U256::from(WAD / 4)) - 0.5).abs() < 1e-12);
        assert_eq!(vol_float(U256::ZERO), 0.0);
    }
}
