// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SwapQuery, SwapRegisters} from "swap-vm/libs/VM.sol";
import {IExtruction} from "swap-vm/instructions/Extruction.sol";

import {SeriesParams, Leg} from "./libs/SeriesParams.sol";
import {TremorOrderBuilder} from "./libs/TremorOrderBuilder.sol";
import {VariancePricing} from "./libs/VariancePricing.sol";
import {ITremorController} from "./interfaces/ITremorController.sol";
import {ITremorMakerVault} from "./interfaces/ITremorMakerVault.sol";
import {IVarianceAccumulator} from "./interfaces/IVarianceAccumulator.sol";

/// @notice The pricing and reservation logic behind all three of a series' SwapVM programs, reached through
///   the stock `Extruction` instruction (opcode 0x04) rather than a custom opcode. One target, three modes,
///   selected by the immutable program arguments `[uint8 version, uint8 mode, uint64 seriesId]`:
///
///     mode 1 ISSUE   USDC    -> receipt   before saleEnd, exact-in or exact-out
///     mode 2 EXIT    receipt -> USDC      before expiry, exact-in only
///     mode 3 SETTLE  receipt -> USDC      after finalization, exact-in only
///
///   Everything it needs is read from the controller and the accumulator, both of which it holds as
///   immutables, and it authenticates every call three ways before pricing anything: the order hash must be
///   registered to this exact series and mode, the maker must be that series' vault, and the token
///   direction must match the mode. A hostile order that merely names this contract as its Extruction
///   target therefore prices nothing.
///
///   Quote and swap run byte-identical arithmetic. The only thing `isStaticContext == false` adds is the
///   two state calls into the controller — reserving collateral for sold units on ISSUE, and moving the
///   inventory skew on ISSUE and EXIT — so `router.quote` cannot disagree with `router.swap` about a price.
///
///   No owner, no upgrade path, no admin, no keeper.
contract TremorMarketEngine is IExtruction {
    /// @dev Program arguments are not the version this engine implements.
    error UnsupportedArgsVersion(uint8 version);
    /// @dev Program arguments are the wrong length for v1.
    error BadArgsLength(uint256 length);
    /// @dev The order hash is not registered to the series and leg the program claims.
    error OrderNotRegistered(bytes32 orderHash, uint256 claimedSeries, Leg claimedLeg);
    /// @dev The order's maker is not the series' vault.
    error MakerNotVault(address maker, address vault);
    /// @dev Token direction does not match the leg.
    error WrongDirection(address tokenIn, address tokenOut);
    /// @dev Registers already carry a computed amount; the program ran a pricing instruction twice.
    error RecomputeDetected();
    /// @dev Issuance is stopped, past its deadline or the series is finalized.
    error IssuanceClosed(uint256 seriesId);
    /// @dev The exit window is closed, or the series is finalized.
    error ExitWindowClosed(uint256 seriesId);
    /// @dev Settlement attempted before the final variance was stored.
    error NotFinalized(uint256 seriesId);
    /// @dev The observation window has unprocessed sample points; checkpoint first.
    error CheckpointsStale(uint256 seriesId);
    /// @dev EXIT and SETTLE accept exact-in receipt units only.
    error ExactOutUnsupported(Leg leg);
    /// @dev Nothing can be filled: no inventory, no collateral capacity, or the ask is already at the cap.
    error NothingToFill(uint256 seriesId, Leg leg);
    /// @dev The series finalized worthless; use the controller's `burnWorthless` instead.
    error ZeroPayout(uint256 seriesId);
    /// @dev Constructor wiring is incomplete.
    error BadEngineConfiguration();
    /// @dev `extruction` was called by something other than the router executing a program.
    error NotRouter(address caller);

    address public immutable CONTROLLER;
    address public immutable ACCUMULATOR;
    address public immutable ROUTER;

    /// @dev Everything one fill needs, read once so quote and swap cannot see different snapshots.
    struct Fill {
        SeriesParams params;
        ITremorController.SeriesView view_;
        uint256 projectedVariance;
        uint256 bidVariance;
        uint256 askVariance;
        uint256 askSlope;
        uint256 bidSlope;
    }

    constructor(address controller, address accumulator, address router) {
        require(
            controller != address(0) && accumulator != address(0) && router.code.length > 0, BadEngineConfiguration()
        );
        CONTROLLER = controller;
        ACCUMULATOR = accumulator;
        ROUTER = router;
    }

    // ------------------------------------------------------------------ IExtruction

    /// @inheritdoc IExtruction
    function extruction(
        bool isStaticContext,
        uint256 nextPC,
        SwapQuery calldata query,
        SwapRegisters calldata swap,
        bytes calldata args,
        bytes calldata /* takerData */
    ) external returns (uint256 updatedNextPC, uint256 choppedLength, SwapRegisters memory updatedSwap) {
        // Only the router executing a shipped program may reach the state-changing path. Without this, a
        // direct call could fabricate a query naming a real order hash and the real vault and inflate the
        // series' reservation with no tokens moving — phantom units that can never be burned.
        require(msg.sender == ROUTER, NotRouter(msg.sender));
        require(args.length == 10, BadArgsLength(args.length));
        (uint8 version, Leg leg, uint256 seriesId) = TremorOrderBuilder.parseEngineArgs(args);
        require(version == TremorOrderBuilder.ENGINE_ARGS_VERSION, UnsupportedArgsVersion(version));

        Fill memory f = _load(query, leg, seriesId);
        updatedSwap = swap;

        uint256 units;
        if (leg == Leg.ISSUE) {
            units = _priceIssue(f, query, updatedSwap, seriesId);
            if (!isStaticContext) {
                ITremorController(CONTROLLER).onIssue(seriesId, query.taker, units, updatedSwap.amountIn);
            }
        } else if (leg == Leg.EXIT) {
            units = _priceExit(f, query, updatedSwap, seriesId);
            if (!isStaticContext) ITremorController(CONTROLLER).onExit(seriesId, units);
        } else {
            _priceSettle(f, query, updatedSwap, seriesId);
        }

        // v1 consumes no taker argument bytes and does not jump: the program counter passes straight
        // through so the instruction after Extruction is the next one to run.
        return (nextPC, 0, updatedSwap);
    }

    // ------------------------------------------------------------------ read model shared with the Lens

    /// @notice The market a fill of this series would price against right now.
    /// @return projected the unclamped projected variance for the whole window (WAD)
    /// @return bidVariance the executable bid variance, clamped to the cap (WAD)
    /// @return askVariance the executable ask variance, clamped to the cap (WAD)
    /// @return forward the market's forward variance after skew decay (WAD)
    /// @return realizedSoFar annualized realized variance of the checkpointed samples (WAD)
    function market(uint256 seriesId)
        public
        view
        returns (uint256 projected, uint256 bidVariance, uint256 askVariance, uint256 forward, uint256 realizedSoFar)
    {
        SeriesParams memory p = ITremorController(CONTROLLER).seriesParams(seriesId);
        ITremorController.SeriesView memory v = ITremorController(CONTROLLER).seriesView(seriesId);
        (projected, bidVariance, askVariance, forward, realizedSoFar,,) = _market(p, v, seriesId);
    }

    /// @notice Static price of an ISSUE fill; identical arithmetic to the swap.
    function quoteIssueExactIn(uint256 seriesId, uint256 amountIn)
        external
        view
        returns (uint256 units, uint256 premium)
    {
        Fill memory f = _fill(seriesId);
        (uint256 maxUnits,) = _issueLimits(f, seriesId, type(uint256).max);
        units = VariancePricing.issueUnitsFor(f.askVariance, f.askSlope, f.params.unitNotional, amountIn);
        premium = amountIn;
        if (units > maxUnits) {
            units = maxUnits;
            premium = VariancePricing.issuePremium(f.askVariance, f.askSlope, f.params.unitNotional, units);
        }
    }

    /// @notice Static price of an exact-out ISSUE fill.
    function quoteIssueExactOut(uint256 seriesId, uint256 units)
        external
        view
        returns (uint256 filledUnits, uint256 premium)
    {
        Fill memory f = _fill(seriesId);
        (uint256 maxUnits,) = _issueLimits(f, seriesId, type(uint256).max);
        filledUnits = units > maxUnits ? maxUnits : units;
        premium = VariancePricing.issuePremium(f.askVariance, f.askSlope, f.params.unitNotional, filledUnits);
    }

    /// @notice Static price of an EXIT fill, bounded by outstanding units and released liability.
    function quoteExitExactIn(uint256 seriesId, uint256 units)
        external
        view
        returns (uint256 filledUnits, uint256 amountOut)
    {
        Fill memory f = _fill(seriesId);
        return _exitAmounts(f, units, type(uint256).max);
    }

    /// @notice Static price of a SETTLE fill.
    function quoteSettleExactIn(uint256 seriesId, uint256 units)
        external
        view
        returns (uint256 filledUnits, uint256 amountOut)
    {
        Fill memory f = _fill(seriesId);
        return _settleAmounts(f, units, type(uint256).max);
    }

    // ------------------------------------------------------------------ pricing

    function _priceIssue(Fill memory f, SwapQuery calldata query, SwapRegisters memory swap, uint256 seriesId)
        internal
        view
        returns (uint256 units)
    {
        require(
            !f.view_.issuanceStopped && !f.view_.finalized && block.timestamp <= f.params.saleEnd,
            IssuanceClosed(seriesId)
        );
        _requireCurrent(f, seriesId);

        (uint256 maxUnits,) = _issueLimits(f, seriesId, swap.balanceOut);
        if (query.isExactIn) {
            require(swap.amountOut == 0, RecomputeDetected());
            units = VariancePricing.issueUnitsFor(f.askVariance, f.askSlope, f.params.unitNotional, swap.amountIn);
            if (units > maxUnits) {
                // Partial fill: sell what is left and charge exactly for it.
                units = maxUnits;
                swap.amountIn = VariancePricing.issuePremium(f.askVariance, f.askSlope, f.params.unitNotional, units);
            }
            swap.amountOut = units;
        } else {
            require(swap.amountIn == 0, RecomputeDetected());
            units = swap.amountOut > maxUnits ? maxUnits : swap.amountOut;
            swap.amountOut = units;
            swap.amountIn = VariancePricing.issuePremium(f.askVariance, f.askSlope, f.params.unitNotional, units);
        }
        require(units > 0, NothingToFill(seriesId, Leg.ISSUE));
    }

    function _priceExit(Fill memory f, SwapQuery calldata query, SwapRegisters memory swap, uint256 seriesId)
        internal
        view
        returns (uint256 units)
    {
        require(query.isExactIn, ExactOutUnsupported(Leg.EXIT));
        require(swap.amountOut == 0, RecomputeDetected());
        require(!f.view_.finalized && block.timestamp < f.params.expiry, ExitWindowClosed(seriesId));
        _requireCurrent(f, seriesId);

        uint256 amountOut;
        (units, amountOut) = _exitAmounts(f, swap.amountIn, swap.balanceOut);
        require(units > 0 && amountOut > 0, NothingToFill(seriesId, Leg.EXIT));
        swap.amountIn = units;
        swap.amountOut = amountOut;
    }

    function _priceSettle(Fill memory f, SwapQuery calldata query, SwapRegisters memory swap, uint256 seriesId)
        internal
        pure
    {
        require(query.isExactIn, ExactOutUnsupported(Leg.SETTLE));
        require(swap.amountOut == 0, RecomputeDetected());
        require(f.view_.finalized, NotFinalized(seriesId));
        require(f.view_.payoutPerUnit > 0, ZeroPayout(seriesId));

        (uint256 units, uint256 amountOut) = _settleAmounts(f, swap.amountIn, swap.balanceOut);
        require(units > 0 && amountOut > 0, NothingToFill(seriesId, Leg.SETTLE));
        swap.amountIn = units;
        swap.amountOut = amountOut;
    }

    /// @dev Units an ISSUE fill may sell: whichever of Aqua's receipt inventory, the vault's free
    ///   collateral, and the distance from the current ask to the cap binds first.
    function _issueLimits(Fill memory f, uint256, uint256 aquaInventory)
        internal
        view
        returns (uint256 maxUnits, uint256 capacityUnits)
    {
        capacityUnits = VariancePricing.issueUnitsToCollateral(
            f.view_.outstandingUnits,
            f.view_.lockedLiability,
            ITremorMakerVault(f.view_.vault).freeQuote(),
            f.params.unitNotional,
            f.params.capVariance
        );
        uint256 capUnits = VariancePricing.issueUnitsToCap(f.askVariance, f.askSlope, f.params.capVariance);
        maxUnits = aquaInventory;
        if (capacityUnits < maxUnits) maxUnits = capacityUnits;
        if (capUnits < maxUnits) maxUnits = capUnits;
    }

    /// @dev Units and proceeds of an EXIT fill. Units are clamped to what is outstanding and to the point
    ///   where the marginal bid would reach zero; proceeds are then clamped to Aqua's quote balance and to
    ///   the liability that burning those units actually releases, which is what keeps EXIT and SETTLE
    ///   sharing one reserve safe.
    function _exitAmounts(Fill memory f, uint256 unitsRequested, uint256 aquaQuoteBalance)
        internal
        pure
        returns (uint256 units, uint256 amountOut)
    {
        units = unitsRequested;
        if (units > f.view_.outstandingUnits) units = f.view_.outstandingUnits;
        uint256 zeroBidUnits = VariancePricing.exitUnitsToZeroBid(f.bidVariance, f.bidSlope);
        if (units > zeroBidUnits) units = zeroBidUnits;
        if (units == 0) return (0, 0);

        amountOut = VariancePricing.exitProceeds(f.bidVariance, f.bidSlope, f.params.unitNotional, units);
        uint256 released = f.view_.lockedLiability
            - VariancePricing.maxLiability(
                f.view_.outstandingUnits - units, f.params.unitNotional, f.params.capVariance
            );
        if (amountOut > released) amountOut = released;
        if (amountOut > aquaQuoteBalance) amountOut = aquaQuoteBalance;
    }

    /// @dev Units and proceeds of a SETTLE fill at the fixed final payout.
    function _settleAmounts(Fill memory f, uint256 unitsRequested, uint256 aquaQuoteBalance)
        internal
        pure
        returns (uint256 units, uint256 amountOut)
    {
        units = unitsRequested;
        if (units > f.view_.outstandingUnits) units = f.view_.outstandingUnits;
        if (units == 0) return (0, 0);

        amountOut = VariancePricing.settleProceeds(units, f.view_.payoutPerUnit);
        uint256 released = f.view_.lockedLiability
            - VariancePricing.finalLiability(f.view_.outstandingUnits - units, f.view_.payoutPerUnit);
        if (amountOut > released) amountOut = released;
        if (amountOut > aquaQuoteBalance) amountOut = aquaQuoteBalance;
    }

    // ------------------------------------------------------------------ loading and authentication

    function _load(SwapQuery calldata query, Leg leg, uint256 seriesId) internal view returns (Fill memory f) {
        (uint256 refSeries, Leg refLeg) = ITremorController(CONTROLLER).orderLeg(query.orderHash);
        require(
            refSeries == seriesId && refLeg == leg && leg != Leg.NONE,
            OrderNotRegistered(query.orderHash, seriesId, leg)
        );

        f = _fill(seriesId);
        require(query.maker == f.view_.vault, MakerNotVault(query.maker, f.view_.vault));

        (address expectedIn, address expectedOut) =
            leg == Leg.ISSUE ? (f.params.quoteToken, f.view_.receipt) : (f.view_.receipt, f.params.quoteToken);
        require(
            query.tokenIn == expectedIn && query.tokenOut == expectedOut, WrongDirection(query.tokenIn, query.tokenOut)
        );
    }

    function _fill(uint256 seriesId) internal view returns (Fill memory f) {
        f.params = ITremorController(CONTROLLER).seriesParams(seriesId);
        f.view_ = ITremorController(CONTROLLER).seriesView(seriesId);
        (f.projectedVariance, f.bidVariance, f.askVariance,,, f.askSlope, f.bidSlope) =
            _market(f.params, f.view_, seriesId);
    }

    function _market(SeriesParams memory p, ITremorController.SeriesView memory v, uint256 seriesId)
        internal
        view
        returns (
            uint256 projected,
            uint256 bidVariance,
            uint256 askVariance,
            uint256 forward,
            uint256 realized,
            uint256 askSlope,
            uint256 bidSlope
        )
    {
        uint256 processedThrough;
        (realized,, processedThrough) = IVarianceAccumulator(ACCUMULATOR).realizedSoFar(seriesId);
        uint256 duration = uint256(p.expiry) - p.start;
        uint256 elapsed = processedThrough > p.start ? processedThrough - p.start : 0;
        uint256 remaining = p.expiry > processedThrough ? uint256(p.expiry) - processedThrough : 0;

        int256 decayed = VariancePricing.decaySkew(v.signedSkew, block.timestamp - v.lastSkewTimestamp, p.halfLife);
        forward = VariancePricing.forwardVariance(p.anchorVariance, decayed, p.capVariance);
        projected = VariancePricing.projectedVariance(realized, elapsed, forward, remaining);
        (bidVariance, askVariance) = VariancePricing.bidAskVariance(projected, p.halfSpreadBps, p.capVariance);
        askSlope = VariancePricing.askImpactSlope(p.impactPerUnit, remaining, duration, p.halfSpreadBps);
        bidSlope = VariancePricing.bidImpactSlope(p.impactPerUnit, remaining, duration, p.halfSpreadBps);
    }

    /// @dev A fill must not price against a stale window. Requiring the accumulator to be current makes the
    ///   projection honest and makes checkpointing something the market needs rather than something a
    ///   keeper is trusted to remember.
    function _requireCurrent(Fill memory f, uint256 seriesId) internal view {
        if (block.timestamp < f.params.start) return;
        require(IVarianceAccumulator(ACCUMULATOR).isCurrent(seriesId), CheckpointsStale(seriesId));
    }
}
