/**
 * Integer replica of `contracts/src/libs/VariancePricing.sol`.
 *
 * Every executable number in a Tremor market is integer-only on chain, and this file reproduces that
 * arithmetic exactly so the simulation's accounting is the contract's accounting rather than a
 * floating-point approximation of it. `npm run check` pins it against the same 60-digit reference
 * vectors the Solidity library is tested with.
 *
 * The one function that cannot be exact is `decaySkew`, because the contract uses Solady's `expWad`.
 * The replica uses `Math.exp` and rounds toward zero the way integer division does; `npm run check`
 * measures the divergence rather than assuming it away.
 */

export const WAD = 10n ** 18n;
/** `type(uint256).max`, the contract's "unbounded" sentinel for a zero-slope book. */
export const UINT256_MAX = 2n ** 256n - 1n;
export const WAD2 = 10n ** 36n;
export const BPS = 10_000n;
export const YEAR = 31_536_000n;

const abs = (x: bigint): bigint => (x < 0n ? -x : x);
export const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** `floor(a·b/d)` for non-negative inputs. */
export const mulDiv = (a: bigint, b: bigint, d: bigint): bigint => (a * b) / d;
/** `ceil(a·b/d)` for non-negative inputs. */
export const mulDivUp = (a: bigint, b: bigint, d: bigint): bigint => (a * b + d - 1n) / d;

/** Integer square root, floored. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of a negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** `sqrt(varianceWad)` in WAD — annualized volatility as a fraction. */
export const volOf = (varianceWad: bigint): bigint => isqrt(varianceWad * WAD);

// ---------------------------------------------------------------- inventory skew

/**
 * `skew · 2^(−dt/halfLife)`, sign preserved, magnitude truncated toward zero.
 *
 * `halfLife == 0` means the skew never decays, which is the contract's convention and not an
 * accident: a market may deliberately hold its skew for the life of the series.
 */
export function decaySkew(skew: bigint, dt: bigint, halfLife: number): bigint {
  if (skew === 0n || dt === 0n || halfLife === 0) return skew;
  const exponent = -(Number(dt) / halfLife) * Math.LN2;
  // expWad saturates to zero for very negative exponents; so does this.
  const factor = exponent < -41.4 ? 0n : BigInt(Math.floor(Math.exp(exponent) * 1e18));
  const decayed = (abs(skew) * factor) / WAD;
  return skew < 0n ? -decayed : decayed;
}

/** `clamp(anchor + decayedSkew, 0, cap)`. */
export function forwardVariance(anchor: bigint, decayedSkew: bigint, cap: bigint): bigint {
  const v = anchor + decayedSkew;
  if (v <= 0n) return 0n;
  return v > cap ? cap : v;
}

/**
 * `(realizedSoFar·elapsed + forward·remaining) / duration`.
 *
 * Deliberately NOT clamped to the cap: this is a measurement, and clamping belongs to the price.
 */
export function projectedVariance(
  realizedSoFar: bigint,
  elapsed: bigint,
  forward: bigint,
  remaining: bigint,
): bigint {
  const duration = elapsed + remaining;
  if (duration === 0n) return forward;
  return (realizedSoFar * elapsed + forward * remaining) / duration;
}

export const annualize = (sumSquaredReturns: bigint, elapsed: bigint): bigint =>
  elapsed === 0n ? 0n : mulDiv(sumSquaredReturns, YEAR, elapsed);

// ---------------------------------------------------------------- bid and ask

export function bidAskVariance(
  projected: bigint,
  halfSpreadBps: number,
  cap: bigint,
): { bidVariance: bigint; askVariance: bigint } {
  const s = BigInt(halfSpreadBps);
  if (s >= BPS) throw new Error("half-spread must be under 100%");
  let askVariance = mulDivUp(projected, BPS + s, BPS);
  let bidVariance = mulDiv(projected, BPS - s, BPS);
  if (askVariance > cap) askVariance = cap;
  if (bidVariance > cap) bidVariance = cap;
  return { bidVariance, askVariance };
}

export const perUnitPrice = (unitNotional: bigint, variance: bigint): bigint =>
  mulDiv(unitNotional, variance, WAD);

export const maxPayoutPerUnit = (unitNotional: bigint, cap: bigint): bigint =>
  mulDiv(unitNotional, cap, WAD);

// ---------------------------------------------------------------- impact slopes

export function askImpactSlope(
  impactPerUnit: bigint,
  remaining: bigint,
  duration: bigint,
  halfSpreadBps: number,
): bigint {
  if (impactPerUnit === 0n || remaining === 0n || duration === 0n) return 0n;
  return mulDivUp(impactPerUnit * remaining, BPS + BigInt(halfSpreadBps), duration * BPS);
}

export function bidImpactSlope(
  impactPerUnit: bigint,
  remaining: bigint,
  duration: bigint,
  halfSpreadBps: number,
): bigint {
  if (impactPerUnit === 0n || remaining === 0n || duration === 0n) return 0n;
  return mulDiv(impactPerUnit * remaining, BPS - BigInt(halfSpreadBps), duration * BPS);
}

// ---------------------------------------------------------------- ISSUE

/** `ceil(unitNotional·(ask·u + ceil(slope·u²/2e18)) / 1e36)` — the integral, not the marginal price. */
export function issuePremium(
  askVariance: bigint,
  slope: bigint,
  unitNotional: bigint,
  units: bigint,
): bigint {
  if (units === 0n) return 0n;
  const integral = askVariance * units + mulDivUp(slope * units, units, 2n * WAD);
  return mulDivUp(unitNotional, integral, WAD2);
}

/** Units affordable with `amountIn`, floored, via the cancellation-free inverse of the integral. */
export function issueUnitsFor(
  askVariance: bigint,
  slope: bigint,
  unitNotional: bigint,
  amountIn: bigint,
): bigint {
  if (askVariance === 0n || amountIn === 0n) return 0n;
  const x = mulDiv(amountIn, WAD2, unitNotional);
  if (slope === 0n) return x / askVariance;
  const discriminant = askVariance * askVariance + mulDivUp(2n * slope, x, WAD);
  let root = isqrt(discriminant);
  if (root * root < discriminant) root += 1n;
  return (2n * x) / (askVariance + root);
}

export function issueUnitsToCap(askVariance: bigint, slope: bigint, cap: bigint): bigint {
  if (askVariance >= cap) return 0n;
  if (slope === 0n) return UINT256_MAX;
  return ((cap - askVariance) * WAD) / slope;
}

export function issueUnitsToCollateral(
  outstandingUnits: bigint,
  lockedLiability: bigint,
  freeCollateral: bigint,
  unitNotional: bigint,
  cap: bigint,
): bigint {
  const allowed = lockedLiability + freeCollateral;
  const denominator = unitNotional * cap;
  if (denominator === 0n) return UINT256_MAX;
  const totalUnits = mulDiv(allowed, WAD2, denominator);
  return totalUnits > outstandingUnits ? totalUnits - outstandingUnits : 0n;
}

// ---------------------------------------------------------------- EXIT

/** `floor(unitNotional·(bid·u − floor(slope·u²/2e18)) / 1e36)`. Clamp units first. */
export function exitProceeds(
  bidVariance: bigint,
  slope: bigint,
  unitNotional: bigint,
  units: bigint,
): bigint {
  if (units === 0n) return 0n;
  const gross = bidVariance * units;
  const impact = mulDiv(slope * units, units, 2n * WAD);
  if (impact > gross) throw new Error("exit units exceed the zero-bid point");
  return mulDiv(unitNotional, gross - impact, WAD2);
}

export const exitUnitsToZeroBid = (bidVariance: bigint, slope: bigint): bigint =>
  slope === 0n ? UINT256_MAX : (bidVariance * WAD) / slope;

// ---------------------------------------------------------------- settlement

export const payoutPerUnit = (finalVariance: bigint, cap: bigint, unitNotional: bigint): bigint =>
  mulDiv(unitNotional, finalVariance < cap ? finalVariance : cap, WAD);

export const settleProceeds = (units: bigint, ppu: bigint): bigint => mulDiv(units, ppu, WAD);

// ---------------------------------------------------------------- liability

/** `ceil(units·unitNotional·cap / 1e36)` — what a sold position reserves before finalization. */
export const maxLiability = (units: bigint, unitNotional: bigint, cap: bigint): bigint =>
  units === 0n ? 0n : mulDivUp(units * unitNotional, cap, WAD2);

/** `ceil(units·payoutPerUnit / 1e18)` — what it reserves after. */
export const finalLiability = (units: bigint, ppu: bigint): bigint =>
  units === 0n || ppu === 0n ? 0n : mulDivUp(units, ppu, WAD);
