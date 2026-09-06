/**
 * Deterministic ETH price paths.
 *
 * Every scenario needs a path whose realized variance lands where the scenario says it lands, so the
 * generator takes a target annualized volatility per segment rather than a diffusion coefficient
 * nobody can reason about. The PRNG is seeded and pure, so a run is reproducible from its seed alone.
 */

/** mulberry32 — small, fast, adequate for scenario paths, and identical across platforms. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller, using two uniforms from the same stream. */
function normal(next: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = next();
  while (v === 0) v = next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface Segment {
  /** Fraction of the window this segment covers. The fractions must sum to 1. */
  share: number;
  /** Annualized volatility, as a fraction (0.4 = 40%). */
  vol: number;
}

export interface Path {
  /** Price at an arbitrary timestamp, piecewise-constant between grid points (like a feed). */
  at(t: number): number;
  /** The grid the path was generated on. */
  readonly times: number[];
  readonly prices: number[];
}

/**
 * A GBM path on the series' own sampling grid whose volatility follows `segments`.
 *
 * Zero drift: the payoff is a sum of squared returns and drift only adds bias nobody asked for.
 * `at()` returns the last grid price at or before `t`, which is exactly how a Chainlink round behaves
 * between updates — so the simulation inherits the same repeated-round bias the real feed has.
 */
export function buildPath(opts: {
  start: number;
  end: number;
  interval: number;
  spot: number;
  segments: Segment[];
  seed: number;
}): Path {
  const { start, end, interval, spot, segments, seed } = opts;
  const total = Math.round((end - start) / interval);
  const next = rng(seed);
  const times: number[] = [];
  const prices: number[] = [];
  let price = spot;

  // Segment boundaries in whole steps, with the remainder given to the last segment so the grid is
  // covered exactly regardless of rounding.
  const steps = segments.map((s) => Math.floor(s.share * total));
  steps[steps.length - 1] = total - steps.slice(0, -1).reduce((a, b) => a + b, 0);

  times.push(start);
  prices.push(price);
  let i = 0;
  for (let s = 0; s < segments.length; s++) {
    const sigma = segments[s].vol;
    const sigmaStep = sigma * Math.sqrt(interval / 31_536_000);
    for (let k = 0; k < steps[s]; k++) {
      i += 1;
      price *= Math.exp(sigmaStep * normal(next) - 0.5 * sigmaStep * sigmaStep);
      times.push(start + i * interval);
      prices.push(price);
    }
  }

  return {
    times,
    prices,
    at(t: number): number {
      if (t <= start) return prices[0];
      const idx = Math.min(prices.length - 1, Math.floor((t - start) / interval));
      return prices[idx];
    },
  };
}

/** Annualized realized variance of a path on its own grid, in floating point, for scenario labels. */
export function pathVariance(path: Path, start: number, end: number, interval: number): number {
  let sum = 0;
  for (let t = start + interval; t <= end; t += interval) {
    const r = Math.log(path.at(t) / path.at(t - interval));
    sum += r * r;
  }
  return (sum * 31_536_000) / (end - start);
}
