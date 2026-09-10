// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TremorTestBase} from "./base/TremorTestBase.sol";
import {SeriesParams} from "../src/libs/SeriesParams.sol";
import {VariancePricing} from "../src/libs/VariancePricing.sol";
import {VarianceAccumulator} from "../src/VarianceAccumulator.sol";
import {IVarianceAccumulator} from "../src/interfaces/IVarianceAccumulator.sol";
import {VarianceSeriesFactory} from "../src/VarianceSeriesFactory.sol";
import {RealizedVariance} from "../src/libs/RealizedVariance.sol";

/// @notice Bounded, permissionless checkpointing and finalization.
///
///   The property that matters most here is that walking the window in arbitrary bounded steps produces
///   exactly the variance a single one-shot computation over the same window would: the accumulator is an
///   optimisation, not a different definition.
contract VarianceAccumulatorTest is TremorTestBase {
    function test_creation_seedsTheOpeningSampleOnly() public {
        (uint256 id,,) = openMarket();
        IVarianceAccumulator.Accumulator memory a = accumulator.accumulator(id);
        assertEq(a.processedSamples, 1, "only the opening sample point");
        assertEq(a.sumSquaredReturnsWad, 0, "the opening sample contributes no variance");
        assertGt(a.lastPriceWad, 0);
        assertGt(a.lastRoundId, 0);

        (uint256 variance, uint256 elapsed,) = accumulator.realizedSoFar(id);
        assertEq(variance, 0);
        assertEq(elapsed, 0);
    }

    function test_upcomingSeries_hasNothingAvailable() public {
        SeriesParams memory p = forwardParams();
        p.start = uint40(block.timestamp + 1 days);
        p.expiry = uint40(p.start + 7 days);
        p.saleEnd = p.expiry;
        (uint256 id,,) = openMarket(p);

        (uint256 stored, uint256 available, uint256 total) = accumulator.progress(id);
        assertEq(stored, 0);
        assertEq(available, 0, "no sample time has passed yet");
        assertEq(total, uint256(7 days) / p.sampleInterval + 1);
        assertTrue(accumulator.isCurrent(id), "a window that has not opened is trivially current");

        // A call with nothing to do is a no-op, not a revert.
        accumulator.checkpoint(id, 32);
        assertEq(accumulator.accumulator(id).processedSamples, 0);
    }

    function test_checkpoint_isIdempotent() public {
        (uint256 id,,) = openMarket();
        warpWithFeed(block.timestamp + 5 * 7200);
        accumulator.checkpoint(id, 32);
        IVarianceAccumulator.Accumulator memory before = accumulator.accumulator(id);
        accumulator.checkpoint(id, 32);
        IVarianceAccumulator.Accumulator memory after_ = accumulator.accumulator(id);
        assertEq(after_.processedSamples, before.processedSamples);
        assertEq(after_.sumSquaredReturnsWad, before.sumSquaredReturnsWad);
        assertEq(after_.processedThrough, before.processedThrough);
    }

    function test_checkpoint_neverProcessesFutureSamples() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,,) = openMarket(p);
        warpWithFeed(block.timestamp + 3 * uint256(p.sampleInterval) + 100);
        accumulator.checkpoint(id, 32);
        IVarianceAccumulator.Accumulator memory a = accumulator.accumulator(id);
        assertEq(a.processedSamples, 4, "opening sample plus the three that have elapsed");
        assertEq(a.processedThrough, p.start + 3 * p.sampleInterval);
        assertLe(a.processedThrough, block.timestamp);
    }

    function test_checkpoint_includesTheExactExpirySample() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,,) = openMarket(p);
        warpWithFeed(p.expiry);
        checkpointAll(id, 32);
        IVarianceAccumulator.Accumulator memory a = accumulator.accumulator(id);
        (,, uint256 total) = accumulator.progress(id);
        assertEq(a.processedSamples, total);
        assertEq(a.processedThrough, p.expiry, "the closing sample is the expiry itself");
    }

    function test_checkpoint_stopsAtExpiryEvenLongAfter() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,,) = openMarket(p);
        warpWithFeed(uint256(p.expiry) + 30 days);
        checkpointAll(id, 32);
        assertEq(accumulator.accumulator(id).processedThrough, p.expiry);
    }

    function test_boundedBudget_isEnforced() public {
        (uint256 id,,) = openMarket();
        vm.expectRevert(abi.encodeWithSelector(VarianceAccumulator.BadSampleBudget.selector, uint16(0)));
        accumulator.checkpoint(id, 0);
        vm.expectRevert(abi.encodeWithSelector(VarianceAccumulator.BadSampleBudget.selector, uint16(33)));
        accumulator.checkpoint(id, 33);
        assertEq(accumulator.MAX_SAMPLES_PER_CALL(), 32);
    }

    function test_budget_limitsSamplesPerCall() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,,) = openMarket(p);
        warpWithFeed(p.expiry);
        accumulator.checkpoint(id, 5);
        assertEq(accumulator.accumulator(id).processedSamples, 6, "seed plus five");
        accumulator.checkpoint(id, 5);
        assertEq(accumulator.accumulator(id).processedSamples, 11);
    }

    /// @notice Any sequence of bounded budgets reaches the same variance as one unbounded computation.
    function testFuzz_boundedWalk_equalsOneShotComputation(uint8 rawBudget) public {
        uint16 budget = uint16(bound(rawBudget, 1, 32));
        SeriesParams memory p = forwardParams();
        (uint256 id,,) = openMarket(p);
        warpWithFeed(uint256(p.expiry) + 1);

        checkpointAll(id, budget);
        uint256 finalVariance = accumulator.finalize(id);

        (uint256 oneShot,) = lens.realizedVariance(p.feed, p.start, p.expiry, p.sampleInterval);
        assertEq(finalVariance, oneShot, "bounded checkpoints and a one-shot computation must agree exactly");
    }

    function test_realizedSoFar_annualizesTheProcessedWindow() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,,) = openMarket(p);
        warpWithFeed(block.timestamp + 10 * uint256(p.sampleInterval));
        checkpointAll(id, 32);

        (uint256 variance, uint256 elapsed, uint256 processedThrough) = accumulator.realizedSoFar(id);
        assertEq(elapsed, 10 * uint256(p.sampleInterval));
        assertEq(processedThrough, uint256(p.start) + elapsed);

        uint40 alignedEnd = uint40(uint256(p.start) + elapsed);
        (uint256 oneShot,) = lens.realizedVariance(p.feed, p.start, alignedEnd, p.sampleInterval);
        assertEq(variance, oneShot, "partial-window variance matches the same window computed directly");
    }

    function test_finalize_requiresExpiryAndACompleteWindow() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,,) = openMarket(p);

        warpWithFeed(block.timestamp + 1 days);
        checkpointAll(id, 32);
        vm.expectRevert(abi.encodeWithSelector(VarianceAccumulator.NotExpired.selector, p.expiry, block.timestamp));
        accumulator.finalize(id);

        warpWithFeed(uint256(p.expiry) + 1);
        (uint256 stored,, uint256 total) = accumulator.progress(id);
        assertLt(stored, total);
        vm.expectRevert(abi.encodeWithSelector(VarianceAccumulator.IncompleteWindow.selector, stored, total));
        accumulator.finalize(id);

        checkpointAll(id, 32);
        accumulator.finalize(id);
    }

    function test_finalize_isPermissionlessAndOnceOnly() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,,) = openMarket(p);
        warpWithFeed(uint256(p.expiry) + 1);
        checkpointAll(id, 32);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        uint256 fv = accumulator.finalize(id);
        assertEq(factory.seriesView(id).finalVariance, fv);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.AlreadyFinalized.selector, id));
        accumulator.finalize(id);
    }

    function test_finalVariance_isImmutableEvenIfTheFeedKeepsMoving() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,,) = openMarket(p);
        warpWithFeed(uint256(p.expiry) + 1);
        uint256 fv = finalizeSeries(id);

        warpWithFeed(block.timestamp + 30 days);
        assertEq(factory.seriesView(id).finalVariance, fv, "the cached final variance cannot move");
    }

    function test_onFinalize_rejectsAnyCallerButTheAccumulator() public {
        (uint256 id,,) = openMarket();
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.NotAccumulator.selector, writer));
        factory.onFinalize(id, 1e18);
    }

    function test_accumulator_readsParametersFromTheControllerNotTheCaller() public view {
        // The signature simply has nowhere to put a feed, window or interval: substitution is impossible
        // rather than merely rejected.
        assertEq(accumulator.CONTROLLER(), address(factory));
        assertEq(accumulator.FEED(), address(feed));
    }

    function test_unknownSeries_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.SeriesNotFound.selector, uint256(99)));
        accumulator.checkpoint(99, 1);
    }
}
