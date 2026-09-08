// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Permissionless, bounded Chainlink checkpointing for one series' observation window.
interface IVarianceAccumulator {
    /// @param processedSamples sample points stored, including the initial one
    /// @param processedThrough timestamp of the last stored sample point
    /// @param lastRoundId proxy round id backing the last stored sample
    /// @param lastPriceWad last stored sample price, scaled to 18 decimals
    /// @param sumSquaredReturnsWad running sum of squared log returns (WAD)
    struct Accumulator {
        uint16 processedSamples;
        uint40 processedThrough;
        uint80 lastRoundId;
        uint256 lastPriceWad;
        uint256 sumSquaredReturnsWad;
    }

    function CONTROLLER() external view returns (address);
    function FEED() external view returns (address);
    function MAX_SAMPLES_PER_CALL() external view returns (uint16);

    function accumulator(uint256 seriesId) external view returns (Accumulator memory);
    /// @notice Sample points that could be stored right now, and how many already are.
    function progress(uint256 seriesId) external view returns (uint256 stored, uint256 available, uint256 total);
    /// @notice True when every sample point whose time has passed is already stored.
    function isCurrent(uint256 seriesId) external view returns (bool);
    /// @notice Annualized realized variance of the stored samples, and the window they cover.
    function realizedSoFar(uint256 seriesId)
        external
        view
        returns (uint256 variance, uint256 elapsed, uint256 processedThrough);

    function checkpoint(uint256 seriesId, uint16 maxSamples) external returns (uint256 stored, uint256 available);
    function finalize(uint256 seriesId) external returns (uint256 finalVariance);
}
