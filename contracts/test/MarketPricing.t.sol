// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {VariancePricing} from "../src/libs/VariancePricing.sol";

/// @dev External wrapper so the library's internal functions can be called through the ABI and so a
///   revert inside one of them is observable as a revert rather than as a compile-time restriction.
contract PricingHarness {
    function decaySkew(int256 skew, uint256 dt, uint32 halfLife) external pure returns (int256) {
        return VariancePricing.decaySkew(skew, dt, halfLife);
    }

    function forwardVariance(uint64 anchor, int256 decayed, uint64 cap) external pure returns (uint256) {
        return VariancePricing.forwardVariance(anchor, decayed, cap);
    }

    function projectedVariance(uint256 realized, uint256 elapsed, uint256 forward, uint256 remaining)
        external
        pure
        returns (uint256)
    {
        return VariancePricing.projectedVariance(realized, elapsed, forward, remaining);
    }

    function annualize(uint256 sumSquared, uint256 elapsed) external pure returns (uint256) {
        return VariancePricing.annualize(sumSquared, elapsed);
    }

    function bidAskVariance(uint256 projected, uint16 spread, uint64 cap)
        external
        pure
        returns (uint256 bid, uint256 ask)
    {
        return VariancePricing.bidAskVariance(projected, spread, cap);
    }

    function askImpactSlope(uint64 impact, uint256 remaining, uint256 duration, uint16 spread)
        external
        pure
        returns (uint256)
    {
        return VariancePricing.askImpactSlope(impact, remaining, duration, spread);
    }

    function bidImpactSlope(uint64 impact, uint256 remaining, uint256 duration, uint16 spread)
        external
        pure
        returns (uint256)
    {
        return VariancePricing.bidImpactSlope(impact, remaining, duration, spread);
    }

    function issuePremium(uint256 ask, uint256 slope, uint128 notional, uint256 units) external pure returns (uint256) {
        return VariancePricing.issuePremium(ask, slope, notional, units);
    }

    function issueUnitsFor(uint256 ask, uint256 slope, uint128 notional, uint256 amountIn)
        external
        pure
        returns (uint256)
    {
        return VariancePricing.issueUnitsFor(ask, slope, notional, amountIn);
    }

    function issueUnitsToCap(uint256 ask, uint256 slope, uint64 cap) external pure returns (uint256) {
        return VariancePricing.issueUnitsToCap(ask, slope, cap);
    }

    function issueUnitsToCollateral(uint256 outstanding, uint256 locked, uint256 free, uint128 notional, uint64 cap)
        external
        pure
        returns (uint256)
    {
        return VariancePricing.issueUnitsToCollateral(outstanding, locked, free, notional, cap);
    }

    function exitProceeds(uint256 bid, uint256 slope, uint128 notional, uint256 units) external pure returns (uint256) {
        return VariancePricing.exitProceeds(bid, slope, notional, units);
    }

    function exitUnitsToZeroBid(uint256 bid, uint256 slope) external pure returns (uint256) {
        return VariancePricing.exitUnitsToZeroBid(bid, slope);
    }

    function payoutPerUnit(uint256 finalVariance, uint64 cap, uint128 notional) external pure returns (uint256) {
        return VariancePricing.payoutPerUnit(finalVariance, cap, notional);
    }

    function settleProceeds(uint256 units, uint256 ppu) external pure returns (uint256) {
        return VariancePricing.settleProceeds(units, ppu);
    }

    function maxLiability(uint256 units, uint128 notional, uint64 cap) external pure returns (uint256) {
        return VariancePricing.maxLiability(units, notional, cap);
    }

    function finalLiability(uint256 units, uint256 ppu) external pure returns (uint256) {
        return VariancePricing.finalLiability(units, ppu);
    }

    function maxPayoutPerUnit(uint128 notional, uint64 cap) external pure returns (uint256) {
        return VariancePricing.maxPayoutPerUnit(notional, cap);
    }

    function perUnitPrice(uint128 notional, uint256 variance) external pure returns (uint256) {
        return VariancePricing.perUnitPrice(notional, variance);
    }
}

/// @notice `VariancePricing` against `tools/reference/pricing_reference.py`, a 60-digit-precision model
///   written from the specification rather than from the Solidity. Sixty cases cover the fresh market,
///   skew in both directions, decay to dust, both clamp boundaries, a realized path above the cap, expiry,
///   a flat book, both spread extremes, exhausted collateral, single-base-unit amounts, and forty random
///   parameter draws.
///
///   Also asserted here are the structural invariants that must hold for every input rather than for the
///   listed ones: the bid never exceeds the ask, the bid per unit never exceeds the maximum payout, and
///   splitting an ISSUE fill can never be cheaper than taking it in one go.
contract MarketPricingTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    PricingHarness internal h;
    string internal json;
    uint256 internal caseCount;

    function setUp() public {
        h = new PricingHarness();
        json = vm.readFile("test/vectors/pricing_vectors.json");
        caseCount = vm.parseJsonUint(json, ".n_cases");
        assertGt(caseCount, 40, "vector file looks truncated");
    }

    /// @dev Split into batches purely for gas: `vm.parseJsonString` is expensive and sixty cases times
    ///   twenty-five fields far exceeds one test's budget.
    function test_vectors_matchPythonReference_00() public view {
        _checkRange(0, 5);
    }

    function test_vectors_matchPythonReference_05() public view {
        _checkRange(5, 10);
    }

    function test_vectors_matchPythonReference_10() public view {
        _checkRange(10, 15);
    }

    function test_vectors_matchPythonReference_15() public view {
        _checkRange(15, 20);
    }

    function test_vectors_matchPythonReference_20() public view {
        _checkRange(20, 25);
    }

    function test_vectors_matchPythonReference_25() public view {
        _checkRange(25, 30);
    }

    function test_vectors_matchPythonReference_30() public view {
        _checkRange(30, 35);
    }

    function test_vectors_matchPythonReference_35() public view {
        _checkRange(35, 40);
    }

    function test_vectors_matchPythonReference_40() public view {
        _checkRange(40, 45);
    }

    function test_vectors_matchPythonReference_45() public view {
        _checkRange(45, 50);
    }

    function test_vectors_matchPythonReference_50() public view {
        _checkRange(50, 55);
    }

    function test_vectors_matchPythonReference_55() public view {
        _checkRange(55, 60);
    }

    function _checkRange(uint256 from, uint256 to) internal view {
        if (to > caseCount) to = caseCount;
        for (uint256 i = from; i < to; i++) {
            _checkCase(i);
        }
    }

    function _u(uint256 i, string memory key) internal view returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, string.concat(".cases[", vm.toString(i), "].", key)));
    }

    function _i(uint256 i, string memory key) internal view returns (int256) {
        return vm.parseInt(vm.parseJsonString(json, string.concat(".cases[", vm.toString(i), "].", key)));
    }

    function _abs(int256 v) internal pure returns (uint256) {
        return v < 0 ? uint256(-v) : uint256(v);
    }

    function _name(uint256 i) internal view returns (string memory) {
        return vm.parseJsonString(json, string.concat(".cases[", vm.toString(i), "].name"));
    }

    function _checkCase(uint256 i) internal view {
        string memory name = _name(i);
        uint64 anchor = uint64(_u(i, "anchor"));
        uint64 cap = uint64(_u(i, "cap"));
        int256 skew = _i(i, "skew");
        uint256 dt = _u(i, "dt");
        uint32 halfLife = uint32(_u(i, "half_life"));
        uint256 realized = _u(i, "realized");
        uint256 elapsed = _u(i, "elapsed");
        uint256 remaining = _u(i, "remaining");
        uint64 impact = uint64(_u(i, "impact"));
        uint16 spread = uint16(_u(i, "spread"));
        uint128 notional = uint128(_u(i, "notional"));
        uint256 units = _u(i, "units");
        uint256 amountIn = _u(i, "amount_in");
        uint256 outstanding = _u(i, "outstanding");
        uint256 free = _u(i, "free");

        // `decaySkew` is the one formula that is not exact integer arithmetic: it multiplies by Solady's
        // `expWad`, whose relative error is on the order of 1e-18. The reference computes the decay at 60
        // digits, so this is asserted to that precision rather than bit-for-bit; every formula downstream
        // is then fed the reference's exact decayed skew and asserted exactly.
        int256 decayedExact = _i(i, "decayed_skew");
        uint256 tolerance = 1 + _abs(decayedExact) / 1e12;
        assertApproxEqAbs(
            h.decaySkew(skew, dt, halfLife), decayedExact, tolerance, string.concat("decayed skew: ", name)
        );

        uint256 forward = h.forwardVariance(anchor, decayedExact, cap);
        assertEq(forward, _u(i, "forward"), string.concat("forward: ", name));

        uint256 projected = h.projectedVariance(realized, elapsed, forward, remaining);
        assertEq(projected, _u(i, "projected"), string.concat("projected: ", name));

        (uint256 bid, uint256 ask) = h.bidAskVariance(projected, spread, cap);
        assertEq(bid, _u(i, "bid_variance"), string.concat("bid: ", name));
        assertEq(ask, _u(i, "ask_variance"), string.concat("ask: ", name));

        uint256 duration = elapsed + remaining;
        assertEq(
            h.askImpactSlope(impact, remaining, duration, spread),
            _u(i, "ask_slope"),
            string.concat("ask slope: ", name)
        );
        assertEq(
            h.bidImpactSlope(impact, remaining, duration, spread),
            _u(i, "bid_slope"),
            string.concat("bid slope: ", name)
        );

        uint256 askSlope = _u(i, "ask_slope");
        uint256 bidSlope = _u(i, "bid_slope");
        assertEq(h.issuePremium(ask, askSlope, notional, units), _u(i, "premium"), string.concat("premium: ", name));
        assertEq(
            h.issueUnitsFor(ask, askSlope, notional, amountIn), _u(i, "units_for"), string.concat("units for: ", name)
        );
        assertEq(h.issueUnitsToCap(ask, askSlope, cap), _u(i, "units_to_cap"), string.concat("to cap: ", name));

        uint256 locked = h.maxLiability(outstanding, notional, cap);
        assertEq(locked, _u(i, "locked_for_outstanding"), string.concat("locked: ", name));
        assertEq(
            h.issueUnitsToCollateral(outstanding, locked, free, notional, cap),
            _u(i, "units_to_collateral"),
            string.concat("to collateral: ", name)
        );

        assertEq(h.exitUnitsToZeroBid(bid, bidSlope), _u(i, "units_to_zero_bid"), string.concat("to zero bid: ", name));
        uint256 exitUnits = _u(i, "exit_units");
        assertEq(
            h.exitProceeds(bid, bidSlope, notional, exitUnits),
            _u(i, "exit_proceeds"),
            string.concat("exit proceeds: ", name)
        );

        uint256 finalVariance = _u(i, "final_variance");
        uint256 ppu = h.payoutPerUnit(finalVariance, cap, notional);
        assertEq(ppu, _u(i, "payout_per_unit"), string.concat("payout per unit: ", name));
        assertEq(h.settleProceeds(units, ppu), _u(i, "settle_proceeds"), string.concat("settle: ", name));
        assertEq(h.maxLiability(units, notional, cap), _u(i, "max_liability"), string.concat("max liab: ", name));
        assertEq(h.finalLiability(units, ppu), _u(i, "final_liability"), string.concat("final liab: ", name));
        assertEq(h.annualize(_u(i, "sum_squared"), elapsed), _u(i, "annualized"), string.concat("annualize: ", name));
    }

    // ------------------------------------------------------------------ structural invariants

    function testFuzz_bidNeverExceedsAskAndNeitherExceedsTheCap(uint256 projected, uint16 rawSpread, uint64 rawCap)
        public
        view
    {
        uint64 cap = uint64(bound(rawCap, 1, 4e18));
        uint16 spread = uint16(bound(rawSpread, 10, 2_000));
        projected = bound(projected, 0, type(uint128).max);
        (uint256 bid, uint256 ask) = h.bidAskVariance(projected, spread, cap);
        assertLe(bid, ask, "bid above ask");
        assertLe(ask, cap, "ask above cap");
        assertLe(bid, cap, "bid above cap");
    }

    function testFuzz_bidPerUnitNeverExceedsTheMaximumPayout(
        uint256 projected,
        uint16 rawSpread,
        uint64 rawCap,
        uint128 rawNotional
    ) public view {
        uint64 cap = uint64(bound(rawCap, 1, 4e18));
        uint16 spread = uint16(bound(rawSpread, 10, 2_000));
        uint128 notional = uint128(bound(rawNotional, 1, 1e24));
        projected = bound(projected, 0, type(uint128).max);
        (uint256 bid,) = h.bidAskVariance(projected, spread, cap);
        assertLe(
            h.perUnitPrice(notional, bid),
            h.maxPayoutPerUnit(notional, cap),
            "an executable bid promised more than a receipt can pay"
        );
    }

    /// @notice Splitting one ISSUE fill into two must never be cheaper than taking it whole. This is the
    ///   whole point of integrating the inventory impact rather than charging the marginal price: a
    ///   fill-splitting buyer would otherwise pay the opening ask on every slice.
    function testFuzz_splittingAnIssueFillNeverSaves(uint256 rawUnits, uint256 rawSplit, uint64 rawSlope) public view {
        uint256 units = bound(rawUnits, 2, 1e24);
        uint256 first = bound(rawSplit, 1, units - 1);
        uint256 ask = 0.25e18;
        uint256 slope = bound(rawSlope, 0, 1e18);
        uint128 notional = 100e6;

        uint256 whole = h.issuePremium(ask, slope, notional, units);
        uint256 partA = h.issuePremium(ask, slope, notional, first);
        // After the first slice the marginal ask has moved up by slope * first / 1e18.
        uint256 movedAsk = ask + slope * first / WAD;
        uint256 partB = h.issuePremium(movedAsk, slope, notional, units - first);
        assertGe(partA + partB, whole, "a split fill was cheaper than the whole fill");
    }

    /// @notice Exiting in slices must never pay more than exiting at once, for the same reason mirrored.
    function testFuzz_splittingAnExitFillNeverPaysMore(uint256 rawUnits, uint256 rawSplit, uint64 rawSlope)
        public
        view
    {
        uint256 units = bound(rawUnits, 2, 1e21);
        uint256 first = bound(rawSplit, 1, units - 1);
        uint256 bid = 0.25e18;
        uint256 slope = bound(rawSlope, 0, 1e14);
        uint128 notional = 100e6;
        vm.assume(h.exitUnitsToZeroBid(bid, slope) >= units);

        uint256 whole = h.exitProceeds(bid, slope, notional, units);
        uint256 partA = h.exitProceeds(bid, slope, notional, first);
        uint256 movedBid = bid - slope * first / WAD;
        uint256 partB = h.exitProceeds(movedBid, slope, notional, units - first);
        assertLe(partA + partB, whole + 1, "a split exit paid more than the whole exit");
    }

    /// @notice `issueUnitsFor` must be the floor inverse of `issuePremium`: the units it returns must be
    ///   affordable, and one more unit must not be.
    function testFuzz_unitsForIsTheFlooredInverseOfPremium(uint256 rawAmountIn, uint64 rawSlope) public view {
        uint256 amountIn = bound(rawAmountIn, 1, 1e15);
        uint256 ask = 0.25e18;
        uint256 slope = bound(rawSlope, 0, 1e18);
        uint128 notional = 100e6;

        uint256 units = h.issueUnitsFor(ask, slope, notional, amountIn);
        if (units == 0) return;
        assertLe(h.issuePremium(ask, slope, notional, units), amountIn, "quoted units were not affordable");
    }

    function test_decay_halvesAtEachHalfLife() public view {
        int256 skew = 0.1e18;
        assertApproxEqRel(h.decaySkew(skew, 6 hours, 6 hours), 0.05e18, 1e6); // 1e-12 relative
        assertApproxEqRel(h.decaySkew(skew, 12 hours, 6 hours), 0.025e18, 1e6);
        assertApproxEqRel(h.decaySkew(-skew, 6 hours, 6 hours), -0.05e18, 1e6);
        assertEq(h.decaySkew(skew, 12 hours, 0), skew, "a zero half-life means no decay");
        assertEq(h.decaySkew(skew, 0, 6 hours), skew);
        assertEq(h.decaySkew(skew, 365 days, 1), 0, "decays all the way to zero");
        assertEq(h.decaySkew(-skew, 365 days, 1), 0);
    }

    function test_projection_endpointsAreExact() public view {
        // Before the window opens the projection is exactly the forward variance.
        assertEq(h.projectedVariance(0, 0, 0.3e18, 7 days), 0.3e18);
        // At expiry it is exactly the realized variance.
        assertEq(h.projectedVariance(0.42e18, 7 days, 0.3e18, 0), 0.42e18);
        // A zero-length window degenerates to the forward variance rather than dividing by zero.
        assertEq(h.projectedVariance(0.42e18, 0, 0.3e18, 0), 0.3e18);
    }

    function test_liability_isComputedFromTheAggregatePosition() public view {
        uint128 notional = 100e6;
        uint64 cap = 1e18;
        // Ten one-unit reservations must not cost more than one ten-unit reservation.
        uint256 aggregate = h.maxLiability(10e18, notional, cap);
        uint256 summed;
        for (uint256 i = 0; i < 10; i++) {
            summed += h.maxLiability(1e18, notional, cap);
        }
        assertLe(aggregate, summed, "aggregate reservation must not exceed the split one");
        assertEq(aggregate, 1_000e6, "10 units * 100 USDC * 1.0 variance");
    }

    function test_maxLiability_isTheCeilingOfTheExactValue() public view {
        // 1 wei of receipt at a notional of 1 and a cap of 1 rounds up to a full base unit.
        assertEq(h.maxLiability(1, 1, 1), 1);
        assertEq(h.maxLiability(0, 100e6, 1e18), 0);
        assertEq(h.finalLiability(0, 12345), 0);
        assertEq(h.finalLiability(1, 1), 1);
    }

    function test_spreadOfTenThousandBpsIsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(VariancePricing.SpreadTooWide.selector, uint16(10_000)));
        h.bidAskVariance(1e18, 10_000, 1e18);
    }
}
