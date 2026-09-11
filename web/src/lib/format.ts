/**
 * Fixed-point helpers. Everything that can reach a contract stays bigint; floats are for
 * charts and prose only.
 */

export const WAD = 10n ** 18n;
export const USDC_DECIMALS = 6;
export const RECEIPT_DECIMALS = 18;
export const FEED_DECIMALS = 8;
export const YEAR_SECONDS = 31_536_000n;
export const BPS = 10_000n;

export const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(" ");

// ---------------------------------------------------------------- parsing (exact)

/** Parse a decimal string like "12.5" into an integer with `decimals` places. Exact. */
export function parseDecimal(input: string, decimals: number): bigint {
  const s = input.trim().replace(/,/g, "").replace(/_/g, "");
  if (s === "" || s === "." || s === "-") throw new Error("empty number");
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  if (!/^\d*(\.\d*)?$/.test(body)) throw new Error(`invalid number: ${input}`);
  const [intPart = "0", fracPart = ""] = body.split(".");
  const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  const v = BigInt(intPart || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return neg ? -v : v;
}

export function tryParseDecimal(input: string, decimals: number): bigint | null {
  try {
    return parseDecimal(input, decimals);
  } catch {
    return null;
  }
}

/** Accepts integer strings/hex/numbers as bigint. */
export function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite");
    return BigInt(Math.trunc(v));
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (/^-?\d+$/.test(s)) return BigInt(s);
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
    if (/^-?\d*\.\d+$/.test(s)) return BigInt(s.split(".")[0] || "0");
    if (/^-?\d+(\.\d+)?e[+-]?\d+$/i.test(s)) return BigInt(Math.trunc(Number(s)));
  }
  throw new Error(`cannot convert to bigint: ${String(v)}`);
}

// ---------------------------------------------------------------- math

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  if (x === 0n) x = 1n;
  // Newton refinement, exact
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) {
      // check neighbours for exactness
      while (x * x > n) x -= 1n;
      while ((x + 1n) * (x + 1n) <= n) x += 1n;
      return x;
    }
    x = y;
  }
}

/** vol (WAD) = sqrt(variance (WAD)). */
export const sqrtWad = (varianceWad: bigint): bigint => isqrt(varianceWad * WAD);

/** variance (WAD) from vol expressed as a percent string ("63.2"). Exact bigint path. */
export function varianceFromVolPct(pct: string): bigint {
  const volWad = parseDecimal(pct, 18) / 100n;
  return (volWad * volWad) / WAD;
}

export const mulDiv = (a: bigint, b: bigint, d: bigint): bigint => (a * b) / d;
export const mulDivUp = (a: bigint, b: bigint, d: bigint): bigint => (a * b + d - 1n) / d;
export const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
export const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

// ---------------------------------------------------------------- formatting (string-based)

function groupInt(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface FmtOpts {
  maxFrac?: number;
  minFrac?: number;
  group?: boolean;
  /** Round half up instead of truncating. */
  round?: boolean;
}

/** Format an integer with `decimals` implied places. No floating point involved. */
export function formatFixed(value: bigint, decimals: number, opts: FmtOpts = {}): string {
  const { maxFrac = 2, minFrac = 0, group = true, round = true } = opts;
  const neg = value < 0n;
  let v = neg ? -value : value;
  const scale = 10n ** BigInt(decimals);
  if (round && maxFrac < decimals) {
    const cut = 10n ** BigInt(decimals - maxFrac);
    v = ((v + cut / 2n) / cut) * cut;
  }
  const intPart = v / scale;
  let frac = (v % scale).toString().padStart(decimals, "0").slice(0, maxFrac);
  frac = frac.replace(/0+$/, "");
  while (frac.length < minFrac) frac += "0";
  const intStr = group ? groupInt(intPart.toString()) : intPart.toString();
  return `${neg ? "-" : ""}${intStr}${frac ? "." + frac : ""}`;
}

export const fmtUsdc = (v: bigint, maxFrac = 2): string => formatFixed(v, USDC_DECIMALS, { maxFrac });

/**
 * Format a USDC price or payout per unit with adaptive precision:
 * - If 0: "0.00"
 * - If micro-cents (< 0.01 USDC, e.g. $0.000427 USDC): uses up to 6 decimals so values don't round to 0.
 * - If sub-cent fractional amount: uses up to 6 decimals (min 2).
 * - Otherwise: standard 2 decimals.
 */
export function fmtPriceUsdc(v: bigint, maxFrac = 6): string {
  if (v === 0n) return "0.00";
  const abs = v < 0n ? -v : v;
  if (abs < 10_000n) {
    return formatFixed(v, USDC_DECIMALS, { maxFrac: Math.max(maxFrac, 6), minFrac: 2 });
  }
  if (abs % 10_000n !== 0n) {
    return formatFixed(v, USDC_DECIMALS, { maxFrac: Math.max(maxFrac, 4), minFrac: 2 });
  }
  return formatFixed(v, USDC_DECIMALS, { maxFrac: 2, minFrac: 2 });
}

export const fmtUnits = (v: bigint, maxFrac = 2): string => formatFixed(v, RECEIPT_DECIMALS, { maxFrac });
export const fmtWad = (v: bigint, maxFrac = 4): string => formatFixed(v, 18, { maxFrac });

/** Annualized vol in percent from a WAD variance, e.g. 0.36e18 -> "60.0". */
export function fmtVolPct(varianceWad: bigint, maxFrac = 1): string {
  return formatFixed(sqrtWad(varianceWad) * 100n, 18, { maxFrac, minFrac: maxFrac });
}

/** Variance WAD as percent of the 1e18 unit (0.36e18 -> "36.0"). */
export const fmtVariancePct = (varianceWad: bigint, maxFrac = 1): string =>
  formatFixed(varianceWad * 100n, 18, { maxFrac, minFrac: maxFrac });

export const fmtBps = (bps: bigint, maxFrac = 0): string => formatFixed(bps, 2, { maxFrac }) + "%";

// ---------------------------------------------------------------- floats for charts / prose

export const toNumber = (v: bigint, decimals: number): number => Number(v) / 10 ** decimals;
/** Vol in percent as a number (charts). */
export const volPctNumber = (varianceWad: bigint): number => Math.sqrt(Number(varianceWad) / 1e18) * 100;
export const usdcNumber = (v: bigint): number => toNumber(v, USDC_DECIMALS);
export const unitsNumber = (v: bigint): number => toNumber(v, RECEIPT_DECIMALS);

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const usdFmt0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const numFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export const fmtUsd = (n: number, whole = false): string => (whole ? usdFmt0 : usdFmt).format(n);
export const fmtNum = (n: number, maxFrac = 2): string =>
  maxFrac === 2 ? numFmt.format(n) : new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFrac }).format(n);
export const fmtPctNum = (n: number, maxFrac = 1): string => `${n.toFixed(maxFrac)}%`;

export function fmtCompact(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

// ---------------------------------------------------------------- addresses / hashes / time

export const shortAddr = (a?: string, n = 4): string => (a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : "—");
export const shortHash = (h?: string, n = 6): string => (h ? `${h.slice(0, 2 + n)}…${h.slice(-4)}` : "—");

export function fmtDate(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
export function fmtDateTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
export function fmtIsoDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
/** "in 3d 4h" / "3d ago". */
export function fmtRelative(ts: number, now: number): string {
  const diff = ts - now;
  if (Math.abs(diff) < 30) return "now";
  return diff > 0 ? `in ${fmtDuration(diff)}` : `${fmtDuration(-diff)} ago`;
}
/** yymmdd used by receipt symbols. */
export function yymmdd(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

// ---------------------------------------------------------------- allowances

/** Wallets commonly approve uint256.max; treat anything ≥ 2^255 or ≥ 1e30 USDC-units as unlimited. */
export const UNLIMITED_ALLOWANCE_THRESHOLD = 1n << 255n;
export const isUnlimitedAllowance = (v: bigint): boolean => v >= UNLIMITED_ALLOWANCE_THRESHOLD || v >= 10n ** 30n;
/** "∞ unlimited" or the formatted amount with its unit. */
export const fmtAllowance = (v: bigint, decimals = USDC_DECIMALS, unit = "USDC", maxFrac = 0): string =>
  isUnlimitedAllowance(v) ? "∞ unlimited" : `${formatFixed(v, decimals, { maxFrac })} ${unit}`;
