/**
 * The market and the vault, as a state machine over integer amounts.
 *
 * This is a faithful model of what the contracts do, not an abstraction of it: the same clamps, the
 * same rounding, the same order of operations, and the same refusal to let a payout exceed the
 * liability its burn releases. Every mutation asserts the vault's solvency invariant, so an
 * accounting error in a scenario surfaces as a thrown error rather than a plausible-looking number.
 */

import * as P from "./pricing.js";
import { WAD } from "./pricing.js";

export interface SeriesParams {
  start: number;
  expiry: number;
  saleEnd: number;
  sampleInterval: number;
  unitNotional: bigint;
  capVariance: bigint;
  anchorVariance: bigint;
  impactPerUnit: bigint;
  halfLife: number;
  halfSpreadBps: number;
  maxUnits: bigint;
}

export interface Quote {
  marketVariance: bigint;
  projectedVariance: bigint;
  realizedSoFar: bigint;
  bidVariance: bigint;
  askVariance: bigint;
  bidPerUnit: bigint;
  askPerUnit: bigint;
  askSlope: bigint;
  bidSlope: bigint;
}

/** One writer's vault. `locked` aggregates every series it backs, exactly as on chain. */
export class Vault {
  balance = 0n;
  locked = 0n;
  /** Premiums taken out, so writer P&L can be reported without conflating it with capital. */
  withdrawn = 0n;
  deposited = 0n;

  get free(): bigint {
    return this.balance - this.locked;
  }

  deposit(amount: bigint): void {
    this.balance += amount;
    this.deposited += amount;
    this.assertSolvent();
  }

  /** Reverts above `free`, which is the whole point of the vault. */
  withdrawFree(amount: bigint): void {
    if (amount > this.free) {
      throw new Error(`ExceedsFree: requested ${amount}, free ${this.free}`);
    }
    this.balance -= amount;
    this.withdrawn += amount;
    this.assertSolvent();
  }

  credit(amount: bigint): void {
    this.balance += amount;
    this.assertSolvent();
  }

  debit(amount: bigint): void {
    if (amount > this.balance) throw new Error(`vault debit ${amount} exceeds balance ${this.balance}`);
    this.balance -= amount;
    this.assertSolvent();
  }

  increaseLocked(amount: bigint): void {
    this.locked += amount;
    this.assertSolvent();
  }

  decreaseLocked(amount: bigint): void {
    if (amount > this.locked) throw new Error(`ExceedsLocked: ${amount} > ${this.locked}`);
    this.locked -= amount;
    this.assertSolvent();
  }

  assertSolvent(): void {
    if (this.balance < this.locked) {
      throw new Error(`Undercollateralized: balance ${this.balance} < locked ${this.locked}`);
    }
  }
}

export interface Fill {
  t: number;
  leg: "issue" | "exit" | "settle";
  actor: string;
  units: bigint;
  quote: bigint;
  /** True when the requested size could not fill completely. */
  partial: boolean;
}

export interface Snapshot {
  t: number;
  processedThrough: number;
  realizedVariance: bigint;
  marketVariance: bigint;
  projectedVariance: bigint;
  bidVariance: bigint;
  askVariance: bigint;
  bidPerUnit: bigint;
  askPerUnit: bigint;
  outstandingUnits: bigint;
  unitsAvailable: bigint;
  lockedLiability: bigint;
  vaultBalance: bigint;
  vaultLocked: bigint;
  vaultFree: bigint;
}

export class Series {
  readonly params: SeriesParams;
  readonly vault: Vault;
  readonly id: number;

  skew = 0n;
  lastSkewTs: number;
  outstandingUnits = 0n;
  unitsAvailable: bigint;
  lockedLiability = 0n;
  issuanceStopped = false;
  finalized = false;
  finalVariance = 0n;
  payoutPerUnit = 0n;

  /** Accumulator state: samples stored, the running sum of squared returns, the cursor's timestamp. */
  samplesStored = 1;
  sumSquaredReturns = 0n;
  processedThrough: number;

  premiumTaken = 0n;
  exitPaid = 0n;
  settlePaid = 0n;
  readonly fills: Fill[] = [];
  readonly snapshots: Snapshot[] = [];

  constructor(id: number, params: SeriesParams, vault: Vault) {
    this.id = id;
    this.params = params;
    this.vault = vault;
    this.unitsAvailable = params.maxUnits;
    this.lastSkewTs = params.start;
    this.processedThrough = params.start;
    vault.increaseLocked(0n);
  }

  get totalSamples(): number {
    return (this.params.expiry - this.params.start) / this.params.sampleInterval + 1;
  }

  availableSamples(now: number): number {
    const capped = Math.min(now, this.params.expiry);
    if (capped < this.params.start) return 0;
    return Math.floor((capped - this.params.start) / this.params.sampleInterval) + 1;
  }

  isCurrent(now: number): boolean {
    return this.samplesStored >= this.availableSamples(now);
  }

  // -------------------------------------------------------------- the oracle

  /**
   * Store up to `maxSamples` new samples from the price path. Bounded, idempotent, permissionless —
   * the same three properties the on-chain accumulator has.
   *
   * @returns the number of samples stored by this call
   */
  checkpoint(now: number, priceAt: (t: number) => number, maxSamples = 32): number {
    const available = this.availableSamples(now);
    let stored = 0;
    while (this.samplesStored < available && stored < maxSamples) {
      const i = this.samplesStored; // next sample index
      const t = this.params.start + i * this.params.sampleInterval;
      const prev = this.params.start + (i - 1) * this.params.sampleInterval;
      const r = Math.log(priceAt(t) / priceAt(prev));
      const rWad = BigInt(Math.round(r * 1e18));
      this.sumSquaredReturns += (rWad * rWad) / WAD;
      this.samplesStored += 1;
      this.processedThrough = t;
      stored += 1;
    }
    return stored;
  }

  /** Bounded calls needed to bring the window current from here. */
  checkpointCallsNeeded(now: number, maxSamples = 32): number {
    return Math.ceil(Math.max(0, this.availableSamples(now) - this.samplesStored) / maxSamples);
  }

  realizedSoFar(): bigint {
    const elapsed = BigInt(this.processedThrough - this.params.start);
    return P.annualize(this.sumSquaredReturns, elapsed);
  }

  /** Permissionless, once, after expiry, with the whole window stored. Releases the cap surplus. */
  finalize(now: number): { finalVariance: bigint; released: bigint } {
    if (now < this.params.expiry) throw new Error("NotExpired");
    if (this.samplesStored < this.totalSamples) {
      throw new Error(`IncompleteWindow: ${this.samplesStored}/${this.totalSamples}`);
    }
    if (this.finalized) throw new Error("AlreadyFinalized");
    this.finalized = true;
    this.finalVariance = P.annualize(this.sumSquaredReturns, BigInt(this.params.expiry - this.params.start));
    this.payoutPerUnit = P.payoutPerUnit(this.finalVariance, this.params.capVariance, this.params.unitNotional);
    const newLiability = P.finalLiability(this.outstandingUnits, this.payoutPerUnit);
    const released = this.lockedLiability - newLiability;
    this.lockedLiability = newLiability;
    if (released > 0n) this.vault.decreaseLocked(released);
    return { finalVariance: this.finalVariance, released };
  }

  // -------------------------------------------------------------- the quote

  quote(now: number): Quote {
    const decayed = P.decaySkew(this.skew, BigInt(Math.max(0, now - this.lastSkewTs)), this.params.halfLife);
    const marketVariance = P.forwardVariance(this.params.anchorVariance, decayed, this.params.capVariance);
    const through = Math.min(this.processedThrough, this.params.expiry);
    const elapsed = BigInt(through - this.params.start);
    const remaining = BigInt(this.params.expiry - through);
    const realizedSoFar = this.realizedSoFar();
    const projectedVariance = P.projectedVariance(realizedSoFar, elapsed, marketVariance, remaining);
    const { bidVariance, askVariance } = P.bidAskVariance(
      projectedVariance,
      this.params.halfSpreadBps,
      this.params.capVariance,
    );
    const duration = elapsed + remaining;
    return {
      marketVariance,
      projectedVariance,
      realizedSoFar,
      bidVariance,
      askVariance,
      bidPerUnit: P.perUnitPrice(this.params.unitNotional, bidVariance),
      askPerUnit: P.perUnitPrice(this.params.unitNotional, askVariance),
      askSlope: P.askImpactSlope(this.params.impactPerUnit, remaining, duration, this.params.halfSpreadBps),
      bidSlope: P.bidImpactSlope(this.params.impactPerUnit, remaining, duration, this.params.halfSpreadBps),
    };
  }

  // -------------------------------------------------------------- the three legs

  issuanceOpen(now: number): boolean {
    return !this.issuanceStopped && !this.finalized && now <= this.params.saleEnd && this.unitsAvailable > 0n;
  }

  exitOpen(now: number): boolean {
    return !this.finalized && now < this.params.expiry && this.outstandingUnits > 0n;
  }

  /**
   * Buy for `amountIn` quote units, exact-in. Applies every clamp the engine applies, in the same
   * order, and prices the size that actually fills.
   */
  issue(now: number, actor: string, amountIn: bigint): Fill | undefined {
    if (!this.issuanceOpen(now)) return undefined;
    if (!this.isCurrent(now)) throw new Error("CheckpointsStale");
    const q = this.quote(now);
    let units = P.issueUnitsFor(q.askVariance, q.askSlope, this.params.unitNotional, amountIn);
    const requested = units;
    units = P.min(units, this.unitsAvailable);
    units = P.min(units, P.issueUnitsToCap(q.askVariance, q.askSlope, this.params.capVariance));
    units = P.min(
      units,
      P.issueUnitsToCollateral(
        this.outstandingUnits,
        this.lockedLiability,
        this.vault.free,
        this.params.unitNotional,
        this.params.capVariance,
      ),
    );
    if (units <= 0n) return undefined;
    const premium = P.issuePremium(q.askVariance, q.askSlope, this.params.unitNotional, units);
    if (premium <= 0n) return undefined;

    // Reservation first, at the cap, from the aggregate position — never per-unit times a count.
    const newLiability = P.maxLiability(this.outstandingUnits + units, this.params.unitNotional, this.params.capVariance);
    const delta = newLiability - this.lockedLiability;
    this.vault.increaseLocked(delta);
    this.lockedLiability = newLiability;

    this.outstandingUnits += units;
    this.unitsAvailable -= units;
    this.vault.credit(premium);
    this.premiumTaken += premium;

    this.skew = P.decaySkew(this.skew, BigInt(Math.max(0, now - this.lastSkewTs)), this.params.halfLife)
      + (this.params.impactPerUnit * units) / WAD;
    this.lastSkewTs = now;

    const fill: Fill = { t: now, leg: "issue", actor, units, quote: premium, partial: units < requested };
    this.fills.push(fill);
    return fill;
  }

  /** Sell `units` back at the bid, exact-in, with the released-liability clamp that keeps it safe. */
  exit(now: number, actor: string, unitsRequested: bigint): Fill | undefined {
    if (!this.exitOpen(now)) return undefined;
    if (!this.isCurrent(now)) throw new Error("CheckpointsStale");
    const q = this.quote(now);
    let units = P.min(unitsRequested, this.outstandingUnits);
    units = P.min(units, P.exitUnitsToZeroBid(q.bidVariance, q.bidSlope));
    if (units <= 0n) return undefined;

    let amountOut = P.exitProceeds(q.bidVariance, q.bidSlope, this.params.unitNotional, units);
    const released =
      this.lockedLiability
      - P.maxLiability(this.outstandingUnits - units, this.params.unitNotional, this.params.capVariance);
    if (amountOut > released) amountOut = released;
    if (amountOut > this.vault.balance) amountOut = this.vault.balance;
    if (amountOut <= 0n) return undefined;

    this.outstandingUnits -= units;
    this.lockedLiability -= released;
    this.vault.decreaseLocked(released);
    this.vault.debit(amountOut);
    this.exitPaid += amountOut;

    this.skew = P.decaySkew(this.skew, BigInt(Math.max(0, now - this.lastSkewTs)), this.params.halfLife)
      - (this.params.impactPerUnit * units) / WAD;
    this.lastSkewTs = now;

    const fill: Fill = {
      t: now,
      leg: "exit",
      actor,
      units,
      quote: amountOut,
      partial: units < unitsRequested,
    };
    this.fills.push(fill);
    return fill;
  }

  /** Redeem at the fixed payout, after finalization. */
  settle(now: number, actor: string, unitsRequested: bigint): Fill | undefined {
    if (!this.finalized) throw new Error("NotFinalized");
    if (this.payoutPerUnit === 0n) return undefined; // burnWorthless territory
    let units = P.min(unitsRequested, this.outstandingUnits);
    if (units <= 0n) return undefined;
    let amountOut = P.settleProceeds(units, this.payoutPerUnit);
    const released = this.lockedLiability - P.finalLiability(this.outstandingUnits - units, this.payoutPerUnit);
    if (amountOut > released) amountOut = released;
    if (amountOut > this.vault.balance) amountOut = this.vault.balance;
    if (amountOut <= 0n) return undefined;

    this.outstandingUnits -= units;
    this.lockedLiability -= released;
    this.vault.decreaseLocked(released);
    this.vault.debit(amountOut);
    this.settlePaid += amountOut;

    const fill: Fill = {
      t: now,
      leg: "settle",
      actor,
      units,
      quote: amountOut,
      partial: units < unitsRequested,
    };
    this.fills.push(fill);
    return fill;
  }

  /** A finalized series that pays nothing: burn instead, which still releases the reservation. */
  burnWorthless(units: bigint): void {
    if (!this.finalized || this.payoutPerUnit !== 0n) throw new Error("PayoutNotZero");
    const u = P.min(units, this.outstandingUnits);
    if (u === 0n) return;
    this.outstandingUnits -= u;
    const released = this.lockedLiability;
    this.lockedLiability = 0n;
    if (released > 0n) this.vault.decreaseLocked(released);
  }

  stopIssuance(): void {
    this.issuanceStopped = true;
    this.unitsAvailable = 0n;
  }

  /** Reverts while claims exist, exactly as `closeSeries` does. */
  close(): void {
    if (this.outstandingUnits > 0n) throw new Error(`ClaimsOutstanding: ${this.outstandingUnits}`);
    this.unitsAvailable = 0n;
    if (this.lockedLiability > 0n) {
      this.vault.decreaseLocked(this.lockedLiability);
      this.lockedLiability = 0n;
    }
  }

  snapshot(now: number): Snapshot {
    const q = this.quote(now);
    const s: Snapshot = {
      t: now,
      processedThrough: this.processedThrough,
      realizedVariance: this.finalized ? this.finalVariance : q.realizedSoFar,
      marketVariance: q.marketVariance,
      projectedVariance: q.projectedVariance,
      bidVariance: q.bidVariance,
      askVariance: q.askVariance,
      bidPerUnit: q.bidPerUnit,
      askPerUnit: q.askPerUnit,
      outstandingUnits: this.outstandingUnits,
      unitsAvailable: this.unitsAvailable,
      lockedLiability: this.lockedLiability,
      vaultBalance: this.vault.balance,
      vaultLocked: this.vault.locked,
      vaultFree: this.vault.free,
    };
    this.snapshots.push(s);
    return s;
  }
}
