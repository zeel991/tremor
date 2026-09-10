// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SeriesParams, Leg} from "../libs/SeriesParams.sol";

/// @notice What the engine, the accumulator and the receipts are allowed to ask of, and tell,
///   `VarianceSeriesFactory`. Every callback validates its caller and the order hash it is handed.
interface ITremorController {
    /// @notice Everything an engine needs to price a fill, in one read.
    /// @param writer series writer (vault owner)
    /// @param vault the Aqua maker holding the collateral
    /// @param receipt the series' ERC-20 receipt
    /// @param outstandingUnits receipt units held outside the vault
    /// @param lockedLiability quote-token collateral currently reserved for this series
    /// @param issuanceStopped writer permanently closed new issuance
    /// @param finalized final variance is stored
    /// @param finalVariance annualized realized variance at expiry (WAD), 0 until finalized
    /// @param payoutPerUnit quote-token payout per 1e18 units, 0 until finalized
    /// @param signedSkew stored inventory skew (WAD), before decay
    /// @param lastSkewTimestamp when `signedSkew` was last written
    struct SeriesView {
        address writer;
        address vault;
        address receipt;
        uint256 outstandingUnits;
        uint256 lockedLiability;
        bool issuanceStopped;
        bool finalized;
        uint256 finalVariance;
        uint256 payoutPerUnit;
        int192 signedSkew;
        uint64 lastSkewTimestamp;
    }

    function ROUTER() external view returns (address);
    function AQUA() external view returns (address);
    function FEED() external view returns (address);
    function QUOTE_TOKEN() external view returns (address);
    function ENGINE() external view returns (address);
    function ACCUMULATOR() external view returns (address);

    function seriesCount() external view returns (uint256);
    function seriesParams(uint256 seriesId) external view returns (SeriesParams memory);
    function seriesView(uint256 seriesId) external view returns (SeriesView memory);
    function orderLeg(bytes32 orderHash) external view returns (uint256 seriesId, Leg leg);

    /// @notice Engine-only, swap mode only: reserve collateral for freshly sold units and skew the market up.
    /// @dev The plan sketches this as `onIssue(seriesId, units)`. `buyer` and `premium` are threaded through
    ///   as well so the `Issued` event can name the taker and the amount paid without the controller having
    ///   to read `tx.origin`, which is neither the taker under a router-level aggregator nor safe to trust.
    function onIssue(uint256 seriesId, address buyer, uint256 units, uint256 premium) external;
    /// @notice Engine-only, swap mode only: skew the market down for units about to be bought back.
    function onExit(uint256 seriesId, uint256 units) external;
    /// @notice Receipt-only: units just burned against `orderHash`; releases exactly the matching liability.
    /// @dev `holder` is the swap's taker, supplied by the receipt hook for the same reason as `onIssue`.
    function onBurn(bytes32 orderHash, address holder, uint256 units, uint256 amountOut) external;
    /// @notice Accumulator-only: store the final variance and reprice the outstanding liability.
    function onFinalize(uint256 seriesId, uint256 finalVariance) external;
}
