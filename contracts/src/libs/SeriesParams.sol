// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Immutable terms of one capped realized-variance receipt series.
///
///   One receipt unit is 1e18 base units and pays, at finalization,
///     payoutPerUnit = floor(unitNotional * min(finalRealizedVariance, capVariance) / 1e18)
///   in `quoteToken` base units. Variance is WAD-scaled: 1e18 means annualized variance 1.0, i.e.
///   annualized volatility 100%.
///
/// @param feed Chainlink AggregatorV3 proxy (8 decimals on Base ETH/USD)
/// @param quoteToken settlement token, 6 decimals (USDC)
/// @param start observation window start
/// @param expiry observation window end; finalization allowed from here
/// @param saleEnd ISSUE leg deadline
/// @param sampleInterval seconds between samples; (expiry - start) % sampleInterval == 0, >= 300
/// @param unitNotional quote-token base units paid per 1e18 units per 1e18 variance
/// @param capVariance WAD, maximum variance paid, so maxPayoutPerUnit = unitNotional * cap / 1e18
/// @param anchorVariance WAD, the market's resting forward variance before inventory skew
/// @param impactPerUnit WAD forward-variance move per 1e18 units of net inventory sold
/// @param halfLife seconds for the inventory skew to halve; 0 = no decay
/// @param halfSpreadBps half of the bid/ask spread, in basis points of projected variance
/// @param maxUnits receipt units minted to the writer's vault at creation (18 decimals)
struct SeriesParams {
    address feed;
    address quoteToken;
    uint40 start;
    uint40 expiry;
    uint40 saleEnd;
    uint32 sampleInterval;
    uint128 unitNotional;
    uint64 capVariance;
    uint64 anchorVariance;
    uint64 impactPerUnit;
    uint32 halfLife;
    uint16 halfSpreadBps;
    uint128 maxUnits;
}

/// @notice Which of a series' three Aqua strategies an order hash belongs to.
enum Leg {
    NONE,
    ISSUE,
    EXIT,
    SETTLE
}
