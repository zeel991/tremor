// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Pure portfolio-reserve mathematics for one risk group of two complementary capped claims that
///   settle on the same finalized observation.
///
///   Let `x = min(finalRealizedVariance / capVariance, 1)` (WAD). With payout scale `S` quote base units
///   per 1e18 claim units:
///
///     HIGH pays  floor(S * x / 1e18)          per 1e18 units
///     CALM pays  S - floor(S * x / 1e18)      per 1e18 units
///
///   The per-unit payouts sum to exactly `S` by construction (CALM is defined as the integer complement,
///   not rounded independently), so for `h` HIGH units and `c` CALM units outstanding the aggregate payout
///   at any x is
///
///     h*highPpu + c*calmPpu = c*S + (h - c)*highPpu     (all per-1e18-unit terms)
///
///   which is affine in `highPpu` and therefore maximized at an endpoint: `S*max(h,c)` units-scaled. The
///   required reserve is the conservative integer ceiling of that maximum:
///
///     reserve(h, c) = ceil(max(h, c) * S / 1e18)
///
///   Solvency of that reserve against integer payouts: every SETTLE fill pays `floor(units * ppu / 1e18)`,
///   and a sum of floors over any partition of holders is at most the floor of the sum, so total payments
///   per side never exceed `floor(sideUnits * sidePpu / 1e18)`, and
///
///     floor(h*hp/1e18) + floor(c*cp/1e18) <= (h*hp + c*cp)/1e18 <= max(h,c)*S/1e18 <= reserve(h,c).
///
///   For the same reason `finalSideLiability` floors: it is the exact upper bound of what fragmented
///   holders can still extract, and per-burn releases telescope without ever under-releasing
///   (floor(a+b) >= floor(a) + floor(b)).
library PortfolioMath {
    uint256 internal constant WAD = 1e18;

    /// @notice Required reserve for `h` HIGH and `c` CALM outstanding units before finalization.
    function reserve(uint256 h, uint256 c, uint256 capPayoutPerUnit) internal pure returns (uint256) {
        uint256 m = h > c ? h : c;
        return _ceilMul(m, capPayoutPerUnit);
    }

    /// @notice Largest total a side may reach so that the reserve stays within `currentReserve + free`.
    /// @dev `floor((currentReserve + free) * 1e18 / S)` is always >= max(h, c) because
    ///   `currentReserve = ceil(max(h,c) * S / 1e18)`, so the subtraction cannot underflow for the side
    ///   currently at or below the other; it is guarded anyway.
    function maxSideUnits(uint256 currentReserve, uint256 free, uint256 capPayoutPerUnit)
        internal
        pure
        returns (uint256)
    {
        return (currentReserve + free) * WAD / capPayoutPerUnit;
    }

    /// @notice `x` in WAD from an uncapped final variance and the cap.
    function normalizedOutcome(uint256 finalVariance, uint64 capVariance) internal pure returns (uint256 xWad) {
        if (finalVariance >= capVariance) return WAD;
        return finalVariance * WAD / capVariance;
    }

    /// @notice Final per-1e18-unit payouts. `calm` is the exact integer complement of `high`.
    function finalPayouts(uint256 xWad, uint256 capPayoutPerUnit) internal pure returns (uint256 high, uint256 calm) {
        high = capPayoutPerUnit * xWad / WAD;
        calm = capPayoutPerUnit - high;
    }

    /// @notice Remaining maximum extractable payout of one side after finalization, given per-fill flooring.
    function finalSideLiability(uint256 units, uint256 ppu) internal pure returns (uint256) {
        return units * ppu / WAD;
    }

    /// @notice What a SETTLE fill of `units` pays, floored (taker receives floor).
    function settleProceeds(uint256 units, uint256 ppu) internal pure returns (uint256) {
        return units * ppu / WAD;
    }

    /// @notice Premium charged for `units` at a fixed per-unit ask, ceiled (taker pays ceil).
    function issuePremium(uint256 units, uint256 askPerUnit) internal pure returns (uint256) {
        return _ceilMul(units, askPerUnit);
    }

    /// @notice Units bought for `amountIn` at a fixed per-unit ask, floored (taker receives floor).
    function issueUnitsFor(uint256 amountIn, uint256 askPerUnit) internal pure returns (uint256) {
        return amountIn * WAD / askPerUnit;
    }

    /// @notice What an EXIT fill of `units` pays at a fixed per-unit bid, floored.
    function exitProceeds(uint256 units, uint256 bidPerUnit) internal pure returns (uint256) {
        return units * bidPerUnit / WAD;
    }

    function _ceilMul(uint256 units, uint256 perUnit) private pure returns (uint256) {
        return (units * perUnit + WAD - 1) / WAD;
    }
}
