// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {RealizedVariance} from "./libs/RealizedVariance.sol";

/// @notice Thin view/cache wrapper around RealizedVariance for UIs, the LVR calculator and VarianceSpread.
///   `poke(feed, window, interval)` computes trailing RV and stores it; `cachedTrailing(window)` is what
///   the VarianceSpread instruction reads (bound to DEFAULT_FEED / DEFAULT_INTERVAL so the 30-byte
///   instruction args stay compact).
contract RealizedVarianceOracle {
    error WindowNotMultiple(uint32 window, uint32 interval);
    error TooManySamples(uint256 samples, uint256 maximum);
    error BadConfiguration();

    uint256 public constant MAX_SAMPLES = 256;

    struct Cached {
        uint256 variance; // WAD
        uint40 updatedAt;
        uint40 from;
        uint40 to;
        uint32 samples;
    }

    event Poked(address indexed feed, uint32 indexed window, uint32 interval, uint256 variance, uint256 samples);

    address public immutable DEFAULT_FEED;
    uint32 public immutable DEFAULT_INTERVAL;

    mapping(address feed => mapping(uint32 window => mapping(uint32 interval => Cached))) internal _cache;

    constructor(address defaultFeed, uint32 defaultInterval) {
        require(defaultFeed.code.length > 0 && defaultInterval > 0, BadConfiguration());
        DEFAULT_FEED = defaultFeed;
        DEFAULT_INTERVAL = defaultInterval;
    }

    function variance(address feed, uint40 start, uint40 end, uint32 interval)
        external
        view
        returns (uint256 rv, uint256 samples)
    {
        return RealizedVariance.compute(feed, start, end, interval);
    }

    function trailing(address feed, uint32 window, uint32 interval)
        public
        view
        returns (uint256 rv, uint256 samples, uint40 from, uint40 to)
    {
        require(interval > 0 && window > 0 && window % interval == 0, WindowNotMultiple(window, interval));
        uint256 sampleCount = window / interval;
        require(sampleCount <= MAX_SAMPLES, TooManySamples(sampleCount, MAX_SAMPLES));
        to = uint40(block.timestamp);
        from = uint40(block.timestamp - window);
        (rv, samples) = RealizedVariance.compute(feed, from, to, interval);
    }

    function poke(address feed, uint32 window, uint32 interval) external returns (uint256 rv) {
        uint256 samples;
        uint40 from;
        uint40 to;
        (rv, samples, from, to) = trailing(feed, window, interval);
        _cache[feed][window][interval] =
            Cached({variance: rv, updatedAt: uint40(block.timestamp), from: from, to: to, samples: uint32(samples)});
        emit Poked(feed, window, interval, rv, samples);
    }

    function cached(address feed, uint32 window, uint32 interval) external view returns (Cached memory) {
        return _cache[feed][window][interval];
    }

    /// @notice What VarianceSpread reads: cached trailing RV on the default feed/interval (0 if never poked).
    function cachedTrailing(uint32 window) external view returns (uint256 variance_, uint256 updatedAt) {
        Cached storage c = _cache[DEFAULT_FEED][window][DEFAULT_INTERVAL];
        return (c.variance, c.updatedAt);
    }
}
