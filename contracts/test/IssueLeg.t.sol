// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {Deadline} from "swap-vm/instructions/Controls.sol";
import {SwapQuery, SwapRegisters} from "swap-vm/libs/VM.sol";

import {TremorTestBase} from "./base/TremorTestBase.sol";
import {SeriesParams, Leg} from "../src/libs/SeriesParams.sol";
import {VariancePricing} from "../src/libs/VariancePricing.sol";
import {TremorMarketEngine} from "../src/TremorMarketEngine.sol";
import {TremorMakerVault} from "../src/TremorMakerVault.sol";
import {VarianceSeriesFactory} from "../src/VarianceSeriesFactory.sol";
import {VarianceReceipt} from "../src/tokens/VarianceReceipt.sol";

/// @notice The ISSUE leg: `USDC -> receipt` before the sale closes, priced by integrating the inventory
///   impact over the fill, bounded by receipt inventory, the vault's free collateral and the cap, and
///   reserving collateral for exactly the units it sold.
contract IssueLegTest is TremorTestBase {
    function test_exactOut_chargesTheIntegralPremium() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,,) = openMarket(p);

        (,, uint256 ask,,) = engine.market(id);
        uint256 slope = VariancePricing.askImpactSlope(
            p.impactPerUnit, uint256(p.expiry) - p.start, uint256(p.expiry) - p.start, p.halfSpreadBps
        );
        uint256 expected = expectedIssuePremium(ask, slope, p.unitNotional, 10e18);

        uint256 paid = buyUnits(buyer1, id, 10e18);
        assertEq(paid, expected, "premium is the integral of the rising ask, not the marginal price");
    }

    function test_exactIn_returnsFlooredUnits() public {
        (uint256 id,,) = openMarket();
        uint256 quoteIn = 1_000e6;
        (uint256 quotedUnits, uint256 quotedPremium) = lens.quoteIssueExactIn(id, quoteIn);
        assertEq(quotedPremium, quoteIn, "an unclamped exact-in fill spends the whole amount");

        uint256 units = buyExactIn(buyer1, id, quoteIn);
        assertEq(units, quotedUnits);
        assertGt(units, 0);
    }

    function test_quoteEqualsSwap_inTheSameState() public {
        (uint256 id,,) = openMarket();
        (uint256 qIn, uint256 qOut) = quoteLeg(buyer1, id, Leg.ISSUE, true, 500e6);
        uint256 units = buyExactIn(buyer1, id, 500e6);
        assertEq(units, qOut, "quote and swap disagreed on units");
        assertEq(qIn, 500e6);

        (uint256 qIn2, uint256 qOut2) = quoteLeg(buyer2, id, Leg.ISSUE, false, 3e18);
        uint256 paid = buyUnits(buyer2, id, 3e18);
        assertEq(paid, qIn2, "quote and swap disagreed on premium");
        assertEq(qOut2, 3e18);
    }

    function test_quoteIsStatic_andLeavesNoTrace() public {
        (uint256 id,,) = openMarket();
        uint256 lockedBefore = factory.seriesView(id).lockedLiability;
        int192 skewBefore = factory.seriesView(id).signedSkew;
        quoteLeg(buyer1, id, Leg.ISSUE, true, 500e6);
        assertEq(factory.seriesView(id).lockedLiability, lockedBefore, "a quote reserved collateral");
        assertEq(factory.seriesView(id).signedSkew, skewBefore, "a quote moved the market");
    }

    function test_inventoryImpact_raisesTheAskForTheNextBuyer() public {
        (uint256 id,,) = openMarket();
        (,, uint256 askBefore,,) = engine.market(id);
        buyUnits(buyer1, id, 20e18);
        (,, uint256 askAfter,,) = engine.market(id);
        assertGt(askAfter, askBefore, "selling inventory must raise the ask");
        assertGt(factory.seriesView(id).signedSkew, 0);
    }

    function test_splitFill_isNeverCheaperOnChain() public {
        SeriesParams memory p = forwardParams();
        (uint256 idWhole,,) = openMarket(p);
        uint256 whole = buyUnits(buyer1, idWhole, 20e18);

        // Same parameters, same block, same starting state: buy in four slices instead.
        TremorMakerVault vault2 = createVault(buyer2);
        fundVault(vault2, buyer2, maxLiabilityOf(p));
        vm.prank(buyer2);
        (uint256 idSplit,) = factory.createSeries(address(vault2), p);
        uint256 split;
        for (uint256 i = 0; i < 4; i++) {
            split += buyUnits(buyer1, idSplit, 5e18);
        }
        assertGe(split, whole, "splitting a fill must not beat the integral price");
    }

    function test_reservesOnlyTheUnitsItSold() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,, TremorMakerVault vault) = openMarket(p);
        assertEq(vault.lockedQuote(), 0);

        buyUnits(buyer1, id, 7e18);
        assertEq(vault.lockedQuote(), expectedMaxLiability(7e18, p.unitNotional, p.capVariance));
        buyUnits(buyer2, id, 3e18);
        assertEq(
            vault.lockedQuote(),
            expectedMaxLiability(10e18, p.unitNotional, p.capVariance),
            "the reservation tracks the aggregate position, not a sum of per-fill roundings"
        );
        assertEq(factory.seriesView(id).outstandingUnits, 10e18);
    }

    function test_inventoryClamp_partialFillSellsWhatIsLeft() public {
        SeriesParams memory p = forwardParams();
        p.maxUnits = 5e18;
        (uint256 id, VarianceReceipt receipt,) = openMarket(p);

        // Ask for more units than exist; a partial-fill taker gets the inventory and pays for it exactly.
        ISwapVM.Order memory o = issueOrder(id);
        bytes memory d = takerDataPartial(buyer1, false, id, Leg.ISSUE);
        vm.prank(buyer1);
        (uint256 amountIn, uint256 amountOut,) = router.swap(o, 50e18, d);
        assertEq(amountOut, 5e18, "clamped to Aqua inventory");
        assertGt(amountIn, 0);
        assertEq(receipt.balanceOf(buyer1), 5e18);

        // Nothing is left, so the next fill has nothing to sell.
        vm.prank(buyer2);
        vm.expectRevert(abi.encodeWithSelector(TremorMarketEngine.NothingToFill.selector, id, Leg.ISSUE));
        router.swap(o, 1e18, d);
    }

    function test_freeCollateralClamp_boundsIssuance() public {
        SeriesParams memory p = forwardParams();
        // Fund the vault for only 12 of the 100 units the series could sell.
        TremorMakerVault vault = createVault(writer);
        uint256 capacityFor12 = expectedMaxLiability(12e18, p.unitNotional, p.capVariance);
        fundVault(vault, writer, capacityFor12);
        (uint256 id,) = createSeries(vault, p);

        (uint256 filled,) = lens.quoteIssueExactOut(id, 100e18);
        assertEq(filled, 12e18, "quote clamps to what the vault can actually back");

        ISwapVM.Order memory o = issueOrder(id);
        bytes memory d = takerDataPartial(buyer1, false, id, Leg.ISSUE);
        vm.prank(buyer1);
        (uint256 amountIn, uint256 amountOut,) = router.swap(o, 100e18, d);
        assertEq(amountOut, 12e18);
        assertEq(vault.lockedQuote(), capacityFor12, "every pre-existing dollar is now committed");
        assertEq(
            vault.freeQuote(),
            amountIn,
            "the only free collateral left is the premium that arrived after the clamp was computed"
        );

        // That premium is new free collateral, so a little more can now be sold.
        assertEq(vault.quoteBalance(), capacityFor12 + amountIn);
        (uint256 more,) = lens.quoteIssueExactOut(id, 100e18);
        assertGt(more, 0, "the premium expanded capacity");
    }

    function test_premiumIsNotCountedTowardTheIssuanceItPaysFor() public {
        SeriesParams memory p = forwardParams();
        TremorMakerVault vault = createVault(writer);
        fundVault(vault, writer, expectedMaxLiability(1e18, p.unitNotional, p.capVariance));
        (uint256 id,) = createSeries(vault, p);

        // Exactly one unit fits. Two would only fit if the incoming premium were counted as backing.
        (uint256 filled,) = lens.quoteIssueExactOut(id, 2e18);
        assertEq(filled, 1e18, "an issuance must be backed by capital already in the vault");
    }

    function test_capClamp_stopsSellingWhenTheAskReachesTheCap() public {
        SeriesParams memory p = forwardParams();
        p.anchorVariance = 0.9e18; // close to the 1.0 cap
        p.impactPerUnit = 0.05e18;
        p.maxUnits = 1_000e18;
        (uint256 id,,) = openMarket(p);

        (,, uint256 ask,,) = engine.market(id);
        assertLt(ask, p.capVariance);
        uint256 slope = VariancePricing.askImpactSlope(
            p.impactPerUnit, uint256(p.expiry) - p.start, uint256(p.expiry) - p.start, p.halfSpreadBps
        );
        uint256 unitsToCap = VariancePricing.issueUnitsToCap(ask, slope, p.capVariance);
        assertGt(unitsToCap, 0);

        (uint256 filled,) = lens.quoteIssueExactOut(id, 1_000e18);
        assertLe(filled, unitsToCap, "the fill stops at the cap");

        // Fill right up to the cap, then the ask is at the cap and nothing more can be sold.
        ISwapVM.Order memory o = issueOrder(id);
        bytes memory d = takerDataPartial(buyer1, false, id, Leg.ISSUE);
        vm.prank(buyer1);
        router.swap(o, filled, d);
        (,, uint256 askNow,,) = engine.market(id);
        assertEq(askNow, p.capVariance, "the ask clamped at the cap");
        vm.prank(buyer2);
        vm.expectRevert(abi.encodeWithSelector(TremorMarketEngine.NothingToFill.selector, id, Leg.ISSUE));
        router.swap(o, 1e18, d);
    }

    function test_askNeverPricesAboveTheMaximumPayout() public {
        SeriesParams memory p = forwardParams();
        p.anchorVariance = p.capVariance;
        (uint256 id,,) = openMarket(p);
        (uint256 filled, uint256 premium) = lens.quoteIssueExactOut(id, 1e18);
        if (filled > 0) {
            uint256 maxPayout = VariancePricing.maxPayoutPerUnit(p.unitNotional, p.capVariance);
            assertLe(premium, maxPayout * filled / WAD, "a buyer was asked to pay more than the cap can pay");
        }
    }

    function test_failedTransfer_rollsBackTheReservationAndTheSkew() public {
        (uint256 id,, TremorMakerVault vault) = openMarket();
        address poorBuyer = makeAddr("poorBuyer");
        vm.prank(poorBuyer);
        usdc.approve(address(router), type(uint256).max);

        uint256 lockedBefore = vault.lockedQuote();
        int192 skewBefore = factory.seriesView(id).signedSkew;
        uint256 outstandingBefore = factory.seriesView(id).outstandingUnits;

        ISwapVM.Order memory o = issueOrder(id);
        bytes memory d = takerData(poorBuyer, false, id, Leg.ISSUE);
        vm.prank(poorBuyer);
        vm.expectRevert();
        router.swap(o, 5e18, d);

        assertEq(vault.lockedQuote(), lockedBefore, "reservation survived a failed fill");
        assertEq(factory.seriesView(id).signedSkew, skewBefore, "skew survived a failed fill");
        assertEq(factory.seriesView(id).outstandingUnits, outstandingBefore);
    }

    function test_saleDeadline_isEnforcedByTheProgram() public {
        SeriesParams memory p = forwardParams();
        p.saleEnd = uint40(block.timestamp + 1 days);
        (uint256 id,,) = openMarket(p);

        warpWithFeed(uint256(p.saleEnd) + 1);
        checkpointAll(id, 32);
        ISwapVM.Order memory o = issueOrder(id);
        bytes memory d = takerData(buyer1, false, id, Leg.ISSUE);
        expectSwapRevert(
            buyer1, o, 1e18, d, abi.encodeWithSelector(Deadline.DeadlineReached.selector, uint256(p.saleEnd))
        );
    }

    function test_stopIssuance_closesOnlyTheIssueLeg() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,,) = openMarket(p);
        buyUnits(buyer1, id, 10e18);

        vm.prank(writer);
        factory.stopIssuance(id);

        // The strategy is docked, so the router cannot even read Aqua balances for it any more.
        ISwapVM.Order memory o = issueOrder(id);
        bytes memory d = takerData(buyer1, false, id, Leg.ISSUE);
        expectSwapRevert(buyer1, o, 1e18, d, "");
        assertFalse(lens.state(id).legs.issuanceOpen);

        // Exit still works, which is the point.
        warpWithFeed(block.timestamp + 1 days);
        checkpointAll(id, 32);
        assertTrue(lens.state(id).legs.exitOpen);
        assertGt(exitUnits(buyer1, id, 2e18), 0);
    }

    function test_stopIssuance_isWriterOnlyAndOnce() public {
        (uint256 id,,) = openMarket();
        vm.prank(buyer1);
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.NotWriter.selector, writer, buyer1));
        factory.stopIssuance(id);

        vm.prank(writer);
        factory.stopIssuance(id);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.IssuanceClosed.selector, id));
        factory.stopIssuance(id);
    }

    function test_staleCheckpoints_blockIssuance() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,,) = openMarket(p);
        warpWithFeed(block.timestamp + 5 * uint256(p.sampleInterval));

        ISwapVM.Order memory o = issueOrder(id);
        bytes memory d = takerData(buyer1, false, id, Leg.ISSUE);
        expectSwapRevert(buyer1, o, 1e18, d, abi.encodeWithSelector(TremorMarketEngine.CheckpointsStale.selector, id));
        expectQuoteRevert(buyer1, o, 1e18, d, abi.encodeWithSelector(TremorMarketEngine.CheckpointsStale.selector, id));

        // Anyone can unblock the market by checkpointing; no key is involved.
        vm.prank(makeAddr("stranger"));
        accumulator.checkpoint(id, 32);
        assertGt(buyUnits(buyer1, id, 1e18), 0);
    }

    function test_wrongDirection_reverts() public {
        (uint256 id,,) = openMarket();
        buyUnits(buyer1, id, 5e18);
        ISwapVM.Order memory o = issueOrder(id);
        // Flip the sorted direction: this asks the ISSUE program to take receipts in.
        bytes memory flipped = lens.buildTakerData(buyer1, true, !lens.legDirection(id, Leg.ISSUE), 0, 0, false);
        vm.prank(buyer1);
        vm.expectRevert();
        router.swap(o, 1e18, flipped);
    }

    function test_unregisteredOrderNamingTheEngine_cannotPrice() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,,) = openMarket(p);

        // Take the real ISSUE order and re-maker it. The program still names the engine and still claims
        // series `id`, but the hash is no longer one the controller registered.
        ISwapVM.Order memory o = issueOrder(id);
        address rogue = makeAddr("rogue");
        o.maker = rogue;
        bytes32 rogueHash = keccak256(abi.encode(o));
        (, Leg leg) = factory.orderLeg(rogueHash);
        assertEq(uint8(leg), uint8(Leg.NONE));

        (,, address receipt,,,,) = factory.series(id);
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = address(usdc) < receipt ? (address(usdc), receipt) : (receipt, address(usdc));
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1e18;
        amounts[1] = 1e18;
        vm.prank(rogue);
        aqua.ship(address(router), abi.encode(o), tokens, amounts);

        bytes memory d = lens.buildTakerData(buyer1, true, address(usdc) < receipt, 0, 0, false);
        vm.prank(buyer1);
        vm.expectRevert(
            abi.encodeWithSelector(TremorMarketEngine.OrderNotRegistered.selector, rogueHash, id, Leg.ISSUE)
        );
        router.swap(o, 1e6, d);
    }

    function test_engineCallbacks_rejectEveryCallerButTheEngine() public {
        (uint256 id,,) = openMarket();
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.NotEngine.selector, writer));
        factory.onIssue(id, writer, 1e18, 1e6);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.NotEngine.selector, writer));
        factory.onExit(id, 1e18);
    }

    function test_engineRejectsAnUnsupportedArgsVersion() public {
        // v1 is the only encoding the engine accepts, so a future program cannot be replayed against it.
        (uint256 id,,) = openMarket();
        bytes memory args = abi.encodePacked(uint8(2), uint8(Leg.ISSUE), uint64(id));
        vm.prank(address(router));
        vm.expectRevert(abi.encodeWithSelector(TremorMarketEngine.UnsupportedArgsVersion.selector, uint8(2)));
        engine.extruction(true, 0, _emptyQuery(), _emptyRegisters(), args, "");
    }

    function test_engineRejectsMalformedArgs() public {
        bytes memory args = abi.encodePacked(uint8(1), uint8(1));
        vm.prank(address(router));
        vm.expectRevert(abi.encodeWithSelector(TremorMarketEngine.BadArgsLength.selector, uint256(2)));
        engine.extruction(true, 0, _emptyQuery(), _emptyRegisters(), args, "");
    }

    // ------------------------------------------------------------------ helpers

    /// @dev A bare query/register pair, used only to reach the engine's argument validation directly.
    function _emptyQuery() internal view returns (SwapQuery memory) {
        return SwapQuery(bytes32(0), address(0), buyer1, address(0), address(0), true);
    }

    function _emptyRegisters() internal pure returns (SwapRegisters memory) {
        return SwapRegisters(0, 0, 0, 0);
    }
}
