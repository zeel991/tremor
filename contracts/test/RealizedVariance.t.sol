// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {RealizedVariance} from "../src/libs/RealizedVariance.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";

contract RVHarness {
    function compute(address feed, uint40 start, uint40 end, uint32 interval) external view returns (uint256, uint256) {
        return RealizedVariance.compute(feed, start, end, interval);
    }

    function samples(address feed, uint40 start, uint40 end, uint32 interval)
        external
        view
        returns (uint256[] memory, uint80[] memory)
    {
        return RealizedVariance.samples(feed, start, end, interval);
    }

    function priceAt(address feed, uint256 t) external view returns (uint256, uint80) {
        return RealizedVariance.priceAt(feed, t);
    }

    /// @dev Same window as `samples`, resolved with the resumable cursor the accumulator uses.
    function scanSamples(address feed, uint40 start, uint40 end, uint32 interval)
        external
        view
        returns (uint256[] memory prices, uint80[] memory roundIds)
    {
        uint256 n = (uint256(end) - start) / interval;
        prices = new uint256[](n + 1);
        roundIds = new uint80[](n + 1);
        (RealizedVariance.Scan memory scan, uint256 price, uint80 roundId) = RealizedVariance.beginScan(feed, start);
        prices[0] = price;
        roundIds[0] = roundId;
        for (uint256 i = 1; i <= n; i++) {
            (price, roundId) = RealizedVariance.nextSample(scan, feed, uint256(start) + i * interval);
            prices[i] = price;
            roundIds[i] = roundId;
        }
    }

    /// @dev Resume from an already-stored round id and take `count` further samples.
    function scanFrom(address feed, uint80 fromRoundId, uint256 fromTime, uint32 interval, uint256 count)
        external
        view
        returns (uint256[] memory prices, uint80[] memory roundIds)
    {
        prices = new uint256[](count);
        roundIds = new uint80[](count);
        RealizedVariance.Scan memory scan = RealizedVariance.resumeScan(feed, fromRoundId);
        for (uint256 i = 0; i < count; i++) {
            (prices[i], roundIds[i]) = RealizedVariance.nextSample(scan, feed, fromTime + (i + 1) * interval);
        }
    }
}

/// @notice Vectors from tools/reference/rv_reference.py (Decimal precision) must match on-chain within 1e-9
///   relative, including irregular round spacing, phase crossings with overlap and with gaps, extreme vol,
///   flat prices. Plus phase-precedence semantics, WindowPredatesFeed, OCR "zeros for missing rounds".
contract RealizedVarianceTest is Test {
    uint256 constant T0 = 1_800_000_000;
    RVHarness h;
    string json;

    function setUp() public {
        vm.warp(T0);
        h = new RVHarness();
        json = vm.readFile("test/vectors/rv_vectors.json");
    }

    function _loadCase(uint256 i)
        internal
        returns (MockAggregator feed, uint40 start, uint40 end, uint32 interval, string memory name)
    {
        string memory base = string.concat(".cases[", vm.toString(i), "]");
        name = vm.parseJsonString(json, string.concat(base, ".name"));
        feed = new MockAggregator(uint8(vm.parseJsonUint(json, string.concat(base, ".decimals"))));
        start = uint40(vm.parseJsonUint(json, string.concat(base, ".start")));
        end = uint40(vm.parseJsonUint(json, string.concat(base, ".end")));
        interval = uint32(vm.parseJsonUint(json, string.concat(base, ".interval")));
        uint256 nPhases = vm.parseJsonUint(json, string.concat(base, ".n_phases"));
        for (uint256 j = 0; j < nPhases; j++) {
            string memory pb = string.concat(base, ".phases[", vm.toString(j), "]");
            uint16 phase = uint16(vm.parseJsonUint(json, string.concat(pb, ".phase")));
            int256[] memory answers = vm.parseJsonIntArray(json, string.concat(pb, ".answers"));
            uint256[] memory ts = vm.parseJsonUintArray(json, string.concat(pb, ".updated_ats"));
            feed.setPhase(phase);
            feed.pushRounds(answers, ts);
        }
    }

    function _assertRelClose(uint256 actual, uint256 expected, string memory name) internal pure {
        if (expected == 0) {
            assertEq(actual, 0, name);
            return;
        }
        uint256 diff = actual > expected ? actual - expected : expected - actual;
        // 1e-9 relative
        assertLe(diff * 1e9, expected, string.concat(name, ": RV outside 1e-9 relative tolerance"));
    }

    function test_vectors_matchPythonReference() public {
        uint256 n = vm.parseJsonUint(json, ".n_cases");
        assertGe(n, 6);
        for (uint256 i = 0; i < n; i++) {
            (MockAggregator feed, uint40 start, uint40 end, uint32 interval, string memory name) = _loadCase(i);
            string memory base = string.concat(".cases[", vm.toString(i), "]");
            uint256 expected = vm.parseJsonUint(json, string.concat(base, ".expected_rv_wad"));
            uint256 nSamples = vm.parseJsonUint(json, string.concat(base, ".n_samples"));

            (uint256 rv, uint256 samples) = h.compute(address(feed), start, end, interval);
            assertEq(samples, nSamples, string.concat(name, ": n"));
            _assertRelClose(rv, expected, name);

            // sample prices and round ids must be IDENTICAL (search semantics, not just the aggregate)
            uint256[] memory expPrices = vm.parseJsonUintArray(json, string.concat(base, ".sample_prices"));
            uint256[] memory expRids = vm.parseJsonUintArray(json, string.concat(base, ".sample_round_ids"));
            (uint256[] memory prices, uint80[] memory rids) = h.samples(address(feed), start, end, interval);
            assertEq(prices.length, nSamples + 1);
            for (uint256 k = 0; k <= nSamples; k++) {
                assertEq(prices[k], expPrices[k], string.concat(name, ": price[", vm.toString(k), "]"));
                assertEq(uint256(rids[k]), expRids[k], string.concat(name, ": roundId[", vm.toString(k), "]"));
            }
            emit log_named_string("case", name);
            emit log_named_uint("  rv (wad)", rv);
            emit log_named_uint("  expected", expected);
        }
    }

    function test_vectors_zerosForMissingRounds_identical() public {
        // OCR-style aggregators return zeros for unknown rounds instead of reverting; results must not change.
        uint256 n = vm.parseJsonUint(json, ".n_cases");
        for (uint256 i = 0; i < n; i++) {
            (MockAggregator feed, uint40 start, uint40 end, uint32 interval, string memory name) = _loadCase(i);
            (uint256 rvRevert,) = h.compute(address(feed), start, end, interval);
            for (uint16 p = 1; p <= feed.phaseId(); p++) {
                feed.setZerosForMissing(p, true);
            }
            (uint256 rvZeros,) = h.compute(address(feed), start, end, interval);
            assertEq(rvZeros, rvRevert, name);
        }
    }

    function test_phasePrecedence_priceAt() public {
        MockAggregator feed = new MockAggregator(8);
        // phase 1: rounds at 100 (p=10), 200 (p=20), 280 (p=28), 300 (p=30)
        feed.pushRound(10e8, 100);
        feed.pushRound(20e8, 200);
        feed.pushRound(28e8, 280);
        feed.pushRound(30e8, 300);
        // phase 2 begins at 250 (p=25) — overlapping phase 1's tail
        feed.setPhase(2);
        feed.pushRound(25e8, 250);
        feed.pushRound(26e8, 400);

        (uint256 a, uint80 rid) = h.priceAt(address(feed), 240);
        assertEq(a, 20e18, "before phase 2 exists -> phase 1 round 2");
        assertEq(rid, (uint80(1) << 64) | 2);

        (a, rid) = h.priceAt(address(feed), 260);
        assertEq(a, 25e18, "phase 2 first round <= t wins over phase 1's later rounds");
        assertEq(rid, (uint80(2) << 64) | 1);

        (a, rid) = h.priceAt(address(feed), 290);
        assertEq(a, 25e18, "still phase 2 (phase 1 round at 280 is ignored)");

        (a, rid) = h.priceAt(address(feed), 1000);
        assertEq(a, 26e18);
        assertEq(rid, (uint80(2) << 64) | 2);

        (a, rid) = h.priceAt(address(feed), 100);
        assertEq(a, 10e18, "exact boundary updatedAt == t counts");
        assertEq(rid, (uint80(1) << 64) | 1);
    }

    function test_windowPredatesFeed_reverts() public {
        MockAggregator feed = new MockAggregator(8);
        feed.pushRound(10e8, 1000);
        feed.pushRound(11e8, 2000);
        vm.expectRevert(abi.encodeWithSelector(RealizedVariance.WindowPredatesFeed.selector, address(feed), 999));
        h.priceAt(address(feed), 999);
        vm.expectRevert(abi.encodeWithSelector(RealizedVariance.WindowPredatesFeed.selector, address(feed), 500));
        h.compute(address(feed), 500, 2500, 1000);
        // starts exactly at the first round: fine
        (, uint256 n) = h.compute(address(feed), 1000, 3000, 1000);
        assertEq(n, 2);
    }

    function test_invalidWindows_revert() public {
        MockAggregator feed = new MockAggregator(8);
        feed.pushRound(10e8, 1000);
        vm.expectRevert(
            abi.encodeWithSelector(RealizedVariance.InvalidWindow.selector, uint40(1000), uint40(2500), uint32(1000))
        );
        h.compute(address(feed), 1000, 2500, 1000);
        vm.expectRevert(
            abi.encodeWithSelector(RealizedVariance.InvalidWindow.selector, uint40(2000), uint40(1000), uint32(1000))
        );
        h.compute(address(feed), 2000, 1000, 1000);
        vm.expectRevert(
            abi.encodeWithSelector(RealizedVariance.WindowInFuture.selector, uint40(T0 + 1000), block.timestamp)
        );
        h.compute(address(feed), uint40(T0), uint40(T0 + 1000), 1000);
    }

    function test_invalidAnswer_reverts() public {
        MockAggregator feed = new MockAggregator(8);
        feed.pushRound(10e8, 1000);
        feed.pushRound(0, 2000); // zero answer inside window
        vm.expectRevert(
            abi.encodeWithSelector(
                RealizedVariance.InvalidAnswer.selector, address(feed), (uint80(1) << 64) | 2, int256(0)
            )
        );
        h.compute(address(feed), 1000, 3000, 1000);
    }

    function test_unsupportedDecimals_reverts() public {
        MockAggregator feed = new MockAggregator(20);
        feed.pushRound(10e8, 1000);
        vm.expectRevert(abi.encodeWithSelector(RealizedVariance.FeedDecimalsUnsupported.selector, uint8(20)));
        h.priceAt(address(feed), 1000);
    }

    /// @notice The resumable scan the accumulator walks the window with must select exactly the same rounds
    ///   as the one-shot `samples` search. If these ever diverge, a checkpointed series and a
    ///   `Lens.realizedVariance` read of the same window would report different variance.
    function test_resumableScan_matchesOneShotSamples() public {
        for (uint256 i = 0; i < 3; i++) {
            (MockAggregator feed, uint40 start, uint40 end, uint32 interval, string memory name) = _loadCase(i);
            (uint256[] memory prices, uint80[] memory roundIds) = h.samples(address(feed), start, end, interval);
            (uint256[] memory scanned, uint80[] memory scannedIds) = h.scanSamples(address(feed), start, end, interval);
            assertEq(scanned.length, prices.length, name);
            for (uint256 j = 0; j < prices.length; j++) {
                assertEq(scanned[j], prices[j], name);
                assertEq(scannedIds[j], roundIds[j], name);
            }
        }
    }

    /// @notice Resuming mid-window from a stored round id reaches the same place as scanning from the start.
    function test_resumableScan_resumesFromAStoredRound() public {
        (MockAggregator feed, uint40 start, uint40 end, uint32 interval,) = _loadCase(0);
        (uint256[] memory prices, uint80[] memory roundIds) = h.samples(address(feed), start, end, interval);
        uint256 half = prices.length / 2;
        (uint256[] memory tail, uint80[] memory tailIds) = h.scanFrom(
            address(feed), roundIds[half], start + uint40(half * interval), interval, prices.length - half - 1
        );
        for (uint256 j = 0; j < tail.length; j++) {
            assertEq(tail[j], prices[half + 1 + j]);
            assertEq(tailIds[j], roundIds[half + 1 + j]);
        }
    }
}
