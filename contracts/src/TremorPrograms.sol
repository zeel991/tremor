// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";

import {SeriesParams, Leg} from "./libs/SeriesParams.sol";
import {TremorOrderBuilder} from "./libs/TremorOrderBuilder.sol";
import {VariancePricing} from "./libs/VariancePricing.sol";
import {VarianceSeriesFactory} from "./VarianceSeriesFactory.sol";

/// @notice Rebuilds a series' three SwapVM programs for anyone who needs to read them: takers assembling a
///   swap, the indexer decoding a fill, the UI's program viewer, and the tests that assert hash identity.
///
///   This is a read model, not a second encoder. It calls the same `TremorOrderBuilder` the controller used
///   at creation, so the orders it returns hash to the exact bytes32 the controller pinned and Aqua
///   shipped — `ShipRoundTrip` asserts precisely that. It exists as its own contract for one reason: the
///   controller's constructor already has to embed the creation code of the accumulator, the engine and the
///   series deployer, and keeping six more `MakerTraits` build sites out of it is what keeps the
///   controller's initcode comfortably inside the EIP-3860 limit.
///
///   No state, no owner, nothing to configure.
contract TremorPrograms {
    error BadProgramsConfiguration();

    VarianceSeriesFactory public immutable FACTORY;
    address public immutable ENGINE;

    constructor(VarianceSeriesFactory factory) {
        require(address(factory).code.length > 0 && factory.ENGINE().code.length > 0, BadProgramsConfiguration());
        FACTORY = factory;
        ENGINE = factory.ENGINE();
    }

    /// @notice The three orders a taker hands the router.
    function orders(uint256 seriesId)
        public
        view
        returns (ISwapVM.Order memory issue, ISwapVM.Order memory exit, ISwapVM.Order memory settlement)
    {
        (, address vault, address receipt,,,, SeriesParams memory p) = FACTORY.series(seriesId);
        issue = TremorOrderBuilder.issueOrder(p, seriesId, receipt, vault, ENGINE);
        exit = TremorOrderBuilder.exitOrder(p, seriesId, receipt, vault, ENGINE);
        settlement = TremorOrderBuilder.settlementOrder(p, seriesId, receipt, vault, ENGINE);
    }

    /// @notice One leg's order, for callers that already know which leg they want.
    function order(uint256 seriesId, Leg leg) external view returns (ISwapVM.Order memory) {
        (, address vault, address receipt,,,, SeriesParams memory p) = FACTORY.series(seriesId);
        return TremorOrderBuilder.order(p, seriesId, receipt, vault, ENGINE, leg);
    }

    /// @notice Exactly what the vault shipped to Aqua for each leg, in ISSUE, EXIT, SETTLE order.
    /// @dev Read-only: shipping already happened, inside `createSeries`. This is here so a judge can decode
    ///   the three programs and check them against the Aqua `Shipped` events.
    function shipPlan(uint256 seriesId)
        external
        view
        returns (bytes[] memory strategies, address[] memory tokens, uint256[][] memory amounts)
    {
        (, address vault, address receipt,,,, SeriesParams memory p) = FACTORY.series(seriesId);
        uint256 liability = VariancePricing.maxLiability(p.maxUnits, p.unitNotional, p.capVariance);
        tokens = TremorOrderBuilder.sortedTokens(p.quoteToken, receipt);
        strategies = new bytes[](3);
        amounts = new uint256[][](3);
        strategies[0] = TremorOrderBuilder.shipBytes(TremorOrderBuilder.issueOrder(p, seriesId, receipt, vault, ENGINE));
        strategies[1] = TremorOrderBuilder.shipBytes(TremorOrderBuilder.exitOrder(p, seriesId, receipt, vault, ENGINE));
        strategies[2] =
            TremorOrderBuilder.shipBytes(TremorOrderBuilder.settlementOrder(p, seriesId, receipt, vault, ENGINE));
        amounts[0] = TremorOrderBuilder.shipAmounts(p, receipt, Leg.ISSUE, liability);
        amounts[1] = TremorOrderBuilder.shipAmounts(p, receipt, Leg.EXIT, liability);
        amounts[2] = TremorOrderBuilder.shipAmounts(p, receipt, Leg.SETTLE, liability);
    }

    /// @notice The raw program bytes of one leg, for the UI's instruction viewer.
    function program(uint256 seriesId, Leg leg) external view returns (bytes memory) {
        (, address vault, address receipt,,,, SeriesParams memory p) = FACTORY.series(seriesId);
        ISwapVM.Order memory o = TremorOrderBuilder.order(p, seriesId, receipt, vault, ENGINE, leg);
        // The program is the tail of `order.data`, after the token pair and any hook target.
        uint256 offset = 40 + (leg == Leg.ISSUE ? 0 : 20);
        bytes memory out = new bytes(o.data.length - offset);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = o.data[offset + i];
        }
        return out;
    }
}
