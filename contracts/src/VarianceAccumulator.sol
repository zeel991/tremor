// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SeriesParams} from "./libs/SeriesParams.sol";
import {RealizedVariance} from "./libs/RealizedVariance.sol";
import {VariancePricing} from "./libs/VariancePricing.sol";
import {ITremorController} from "./interfaces/ITremorController.sol";
import {IVarianceAccumulator} from "./interfaces/IVarianceAccumulator.sol";

/// @notice Walks a series' observation window forward in bounded, permissionless steps and fixes the final
///   realized variance once the window closes.
///
///   Tremor v1 computed the whole window inside the first settlement swap. That made the first redeemer pay
///   for every sample and made a long window unsettleable at any gas price. Here anyone — a holder, the
///   writer, a bot, a judge with a terminal — calls `checkpoint(seriesId, maxSamples)` as many times as it
///   takes, each call processing at most 32 new sample points, and then anyone calls `finalize(seriesId)`.
///   No key is privileged and no keeper is required: if every automation stops, the next holder who wants
///   their money simply checkpoints the rest of the window themselves.
///
///   Series parameters are read from the controller rather than taken from the caller, so a caller cannot
///   substitute a friendlier feed, window or interval. The sample-selection rule is unchanged from v1 —
///   the latest valid round with `updatedAt <= t_i`, resolved phase-first — so a checkpointed window and a
///   one-shot `RealizedVariance.compute` over the same window return the same number.
contract VarianceAccumulator is IVarianceAccumulator {
    /// @dev `maxSamples` outside [1, MAX_SAMPLES_PER_CALL].
    error BadSampleBudget(uint16 maxSamples);
    /// @dev The configured feed is not the one this series was created against.
    error FeedMismatch(address expected, address actual);
    /// @dev Finalization attempted before the observation window closed.
    error NotExpired(uint40 expiry, uint256 nowTs);
    /// @dev Finalization attempted with sample points still missing.
    error IncompleteWindow(uint256 stored, uint256 total);
    /// @dev Constructor wiring is incomplete.
    error BadAccumulatorConfiguration();

    /// @notice One bounded range of sample points was stored.
    event Checkpointed(
        uint256 indexed seriesId,
        uint256 fromSample,
        uint256 toSample,
        uint40 processedThrough,
        uint80 lastRoundId,
        uint256 sumSquaredReturnsWad
    );

    /// @notice Hard ceiling on sample points per call, so no checkpoint can grow unbounded.
    uint16 public constant MAX_SAMPLES_PER_CALL = 32;

    address public immutable CONTROLLER;
    address public immutable FEED;

    mapping(uint256 seriesId => Accumulator) internal _accumulators;

    constructor(address controller, address feed) {
        require(controller != address(0) && feed.code.length > 0, BadAccumulatorConfiguration());
        CONTROLLER = controller;
        FEED = feed;
    }

    // ------------------------------------------------------------------ views

    function accumulator(uint256 seriesId) external view returns (Accumulator memory) {
        return _accumulators[seriesId];
    }

    /// @notice `stored` sample points are recorded, `available` could be recorded right now, `total` is the
    ///   full window (`samples + 1` points, one per sample time including the window start).
    function progress(uint256 seriesId) public view returns (uint256 stored, uint256 available, uint256 total) {
        SeriesParams memory p = _params(seriesId);
        return (_accumulators[seriesId].processedSamples, _available(p), _total(p));
    }

    function isCurrent(uint256 seriesId) external view returns (bool) {
        (uint256 stored, uint256 available,) = progress(seriesId);
        return stored >= available;
    }

    /// @notice Annualized realized variance of what has been checkpointed so far.
    function realizedSoFar(uint256 seriesId)
        external
        view
        returns (uint256 variance, uint256 elapsed, uint256 processedThrough)
    {
        SeriesParams memory p = _params(seriesId);
        Accumulator storage a = _accumulators[seriesId];
        processedThrough = a.processedSamples == 0 ? p.start : a.processedThrough;
        elapsed = processedThrough > p.start ? processedThrough - p.start : 0;
        variance = VariancePricing.annualize(a.sumSquaredReturnsWad, elapsed);
    }

    // ------------------------------------------------------------------ checkpointing

    /// @notice Store up to `maxSamples` further sample points. Idempotent: a call with nothing new to do
    ///   returns the current progress without mutating state, so naive automation can poll harmlessly.
    function checkpoint(uint256 seriesId, uint16 maxSamples) external returns (uint256 stored, uint256 available) {
        require(maxSamples >= 1 && maxSamples <= MAX_SAMPLES_PER_CALL, BadSampleBudget(maxSamples));
        SeriesParams memory p = _params(seriesId);
        require(p.feed == FEED, FeedMismatch(FEED, p.feed));

        Accumulator memory a = _accumulators[seriesId];
        stored = a.processedSamples;
        available = _available(p);
        if (stored >= available) return (stored, available);

        uint256 budget = available - stored;
        if (budget > maxSamples) budget = maxSamples;
        uint256 firstSample = stored;

        RealizedVariance.Scan memory scan;
        uint256 previousPrice = a.lastPriceWad;
        uint256 priceWad;
        uint80 roundId;

        if (stored == 0) {
            // The window's opening sample only anchors the first return; it contributes no variance.
            (scan, priceWad, roundId) = RealizedVariance.beginScan(FEED, p.start);
            a.processedThrough = p.start;
            a.lastRoundId = roundId;
            a.lastPriceWad = priceWad;
            a.processedSamples = 1;
            previousPrice = priceWad;
            stored = 1;
            budget -= 1;
        } else {
            scan = RealizedVariance.resumeScan(FEED, a.lastRoundId);
        }

        for (uint256 i = 0; i < budget; i++) {
            uint256 t = uint256(p.start) + stored * uint256(p.sampleInterval);
            (priceWad, roundId) = RealizedVariance.nextSample(scan, FEED, t);
            a.sumSquaredReturnsWad += RealizedVariance.squaredReturn(previousPrice, priceWad);
            previousPrice = priceWad;
            a.processedThrough = uint40(t);
            a.lastRoundId = roundId;
            a.lastPriceWad = priceWad;
            stored += 1;
        }

        a.processedSamples = uint16(stored);
        _accumulators[seriesId] = a;

        emit Checkpointed(seriesId, firstSample, stored - 1, a.processedThrough, a.lastRoundId, a.sumSquaredReturnsWad);
        return (stored, available);
    }

    /// @notice Fix the series' final realized variance. Callable by anyone, once, after the window closes
    ///   and every sample point has been checkpointed.
    function finalize(uint256 seriesId) external returns (uint256 finalVariance) {
        SeriesParams memory p = _params(seriesId);
        require(block.timestamp >= p.expiry, NotExpired(p.expiry, block.timestamp));
        Accumulator storage a = _accumulators[seriesId];
        uint256 total = _total(p);
        require(a.processedSamples == total, IncompleteWindow(a.processedSamples, total));

        finalVariance = VariancePricing.annualize(a.sumSquaredReturnsWad, uint256(p.expiry) - p.start);
        ITremorController(CONTROLLER).onFinalize(seriesId, finalVariance);
    }

    // ------------------------------------------------------------------ internals

    function _params(uint256 seriesId) internal view returns (SeriesParams memory) {
        return ITremorController(CONTROLLER).seriesParams(seriesId);
    }

    /// @dev Sample points in the whole window, including the opening one.
    function _total(SeriesParams memory p) internal pure returns (uint256) {
        return (uint256(p.expiry) - p.start) / p.sampleInterval + 1;
    }

    /// @dev Sample points whose time has already passed, capped at the window.
    function _available(SeriesParams memory p) internal view returns (uint256) {
        uint256 limit = block.timestamp < p.expiry ? block.timestamp : p.expiry;
        if (limit < p.start) return 0;
        uint256 index = (limit - p.start) / p.sampleInterval;
        uint256 total = _total(p);
        return index + 1 > total ? total : index + 1;
    }
}
