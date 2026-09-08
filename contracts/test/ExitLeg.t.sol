// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {Deadline} from "swap-vm/instructions/Controls.sol";

import {TremorTestBase} from "./base/TremorTestBase.sol";
import {SeriesParams, Leg} from "../src/libs/SeriesParams.sol";
import {VariancePricing} from "../src/libs/VariancePricing.sol";
import {TremorMarketEngine} from "../src/TremorMarketEngine.sol";
import {TremorMakerVault} from "../src/TremorMakerVault.sol";
import {VarianceSeriesFactory} from "../src/VarianceSeriesFactory.sol";
import {VarianceReceipt} from "../src/tokens/VarianceReceipt.sol";

/// @notice The EXIT leg: `receipt -> USDC` before expiry at an executable bid.
///
///   This is the leg v1 did not have. A v1 holder could see an "accrued payout indication" and do nothing
///   with it until expiry; here the number on screen is a bid they can hit, bounded by the liability that
///   burning their receipts releases — which is exactly what lets EXIT and SETTLE share one reserve.
contract ExitLegTest is TremorTestBase {
    function _liveMarket()
        internal
        returns (uint256 id, VarianceReceipt receipt, TremorMakerVault vault, SeriesParams memory p)
    {
        p = forwardParams();
        (id, receipt, vault) = openMarket(p);
        buyUnits(buyer1, id, 20e18);
        warpWithFeed(block.timestamp + 1 days);
        checkpointAll(id, 32);
    }

    function test_exit_paysTheIntegralBid() public {
        (uint256 id,,, SeriesParams memory p) = _liveMarket();
        (uint256 bid,,,,) = _market(id);
        (,, uint256 processedThrough) = accumulator.realizedSoFar(id);
        uint256 duration = uint256(p.expiry) - p.start;
        uint256 remaining = uint256(p.expiry) - processedThrough;
        uint256 slope = VariancePricing.bidImpactSlope(p.impactPerUnit, remaining, duration, p.halfSpreadBps);

        uint256 expected = expectedExitProceeds(bid, slope, p.unitNotional, 5e18);
        uint256 got = exitUnits(buyer1, id, 5e18);
        assertEq(got, expected, "proceeds are the integral of the falling bid");
    }

    function test_bidIsBelowAsk() public {
        (uint256 id,,,) = _liveMarket();
        (uint256 bid, uint256 ask,,,) = _market(id);
        assertLt(bid, ask, "the bid must sit inside the ask");
        assertGt(bid, 0);
    }

    function test_bidPerUnitNeverExceedsTheMaximumPayout() public {
        SeriesParams memory p = forwardParams();
        // Sit the market as close to the cap as issuance allows, then check the bid still respects it.
        p.anchorVariance = 0.95e18;
        (uint256 id,,) = openMarket(p);
        // Near the cap the ask clamp bounds how much can be sold at all, so take what fits.
        (uint256 sellable,) = lens.quoteIssueExactOut(id, 10e18);
        buyUnits(buyer1, id, sellable);
        warpWithFeed(block.timestamp + 3 days);
        checkpointAll(id, 32);

        uint256 maxPayout = VariancePricing.maxPayoutPerUnit(p.unitNotional, p.capVariance);
        (uint256 units, uint256 out) = lens.quoteExitExactIn(id, 1e18);
        assertEq(units, 1e18);
        assertLe(out, maxPayout, "the bid promised more than a receipt can ever pay");
    }

    function test_quoteEqualsSwap() public {
        (uint256 id,,,) = _liveMarket();
        (uint256 qIn, uint256 qOut) = quoteLeg(buyer1, id, Leg.EXIT, true, 6e18);
        (uint256 lensUnits, uint256 lensOut) = lens.quoteExitExactIn(id, 6e18);
        assertEq(lensUnits, qIn, "Lens and router disagreed on units");
        assertEq(lensOut, qOut, "Lens and router disagreed on proceeds");
        assertEq(exitUnits(buyer1, id, 6e18), qOut, "quote and swap disagreed");
    }

    function test_exit_burnsReceiptsAndReducesOutstanding() public {
        (uint256 id, VarianceReceipt receipt,, SeriesParams memory p) = _liveMarket();
        uint256 supplyBefore = receipt.totalSupply();
        exitUnits(buyer1, id, 8e18);
        assertEq(receipt.totalSupply(), supplyBefore - 8e18, "exited receipts are burned, not recycled");
        assertEq(receipt.balanceOf(buyer1), 12e18);
        assertEq(factory.seriesView(id).outstandingUnits, 12e18);
        assertEq(receipt.balanceOf(address(0)), 0);
        // The vault holds only unsold inventory; nothing exited ended up back in stock.
        assertEq(receipt.balanceOf(_vaultOf(id)), p.maxUnits - 20e18);
    }

    function test_exit_releasesExactlyTheCappedLiabilityDelta() public {
        (uint256 id,, TremorMakerVault vault, SeriesParams memory p) = _liveMarket();
        uint256 lockedBefore = vault.lockedQuote();
        assertEq(lockedBefore, expectedMaxLiability(20e18, p.unitNotional, p.capVariance));

        uint256 balanceBefore = usdc.balanceOf(address(vault));
        uint256 proceeds = exitUnits(buyer1, id, 8e18);
        uint256 expectedLocked = expectedMaxLiability(12e18, p.unitNotional, p.capVariance);
        assertEq(vault.lockedQuote(), expectedLocked);

        uint256 released = lockedBefore - expectedLocked;
        assertLe(proceeds, released, "an exit paid more than the liability it released");
        assertEq(usdc.balanceOf(address(vault)), balanceBefore - proceeds);
        assertGe(usdc.balanceOf(address(vault)), vault.lockedQuote(), "solvent after the exit");
    }

    function test_partialExitsSumToTheWholeAndPreserveSolvency() public {
        (uint256 id,, TremorMakerVault vault,) = _liveMarket();
        uint256 total;
        for (uint256 i = 0; i < 4; i++) {
            total += exitUnits(buyer1, id, 5e18);
            assertGe(usdc.balanceOf(address(vault)), vault.lockedQuote(), "solvent after every slice");
        }
        assertEq(factory.seriesView(id).outstandingUnits, 0);
        assertEq(vault.lockedQuote(), 0, "the whole reservation came back");
        assertGt(total, 0);
    }

    function test_exit_pushesTheBidDownForTheNextSeller() public {
        (uint256 id,,,) = _liveMarket();
        (uint256 bidBefore,,,,) = _market(id);
        exitUnits(buyer1, id, 10e18);
        (uint256 bidAfter,,,,) = _market(id);
        assertLt(bidAfter, bidBefore, "buying inventory back must lower the bid");
        assertLt(factory.seriesView(id).signedSkew, 0);
    }

    function test_exactOut_isRejected() public {
        (uint256 id, VarianceReceipt receipt,,) = _liveMarket();
        ISwapVM.Order memory o = exitOrder(id);
        bytes memory d = takerData(buyer1, false, id, Leg.EXIT);
        vm.startPrank(buyer1);
        receipt.approve(address(router), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(TremorMarketEngine.ExactOutUnsupported.selector, Leg.EXIT));
        router.swap(o, 1e6, d);
        vm.stopPrank();
    }

    function test_exitBeyondOutstanding_clampsToOutstanding() public {
        (uint256 id, VarianceReceipt receipt,,) = _liveMarket();
        // Buyer 2 has no receipts, so a second holder's balance cannot inflate what buyer 1 can exit.
        (uint256 units,) = lens.quoteExitExactIn(id, 1_000e18);
        assertEq(units, 20e18, "clamped to outstanding units");

        ISwapVM.Order memory o = exitOrder(id);
        bytes memory d = takerDataPartial(buyer1, true, id, Leg.EXIT);
        vm.startPrank(buyer1);
        receipt.approve(address(router), type(uint256).max);
        (uint256 amountIn,,) = router.swap(o, 1_000e18, d);
        vm.stopPrank();
        assertEq(amountIn, 20e18);
        assertEq(factory.seriesView(id).outstandingUnits, 0);
    }

    function test_exitMoreThanHeld_reverts() public {
        (uint256 id, VarianceReceipt receipt,,) = _liveMarket();
        // buyer2 holds nothing; the ERC-20 transfer is what stops them.
        ISwapVM.Order memory o = exitOrder(id);
        bytes memory d = takerDataPartial(buyer2, true, id, Leg.EXIT);
        vm.startPrank(buyer2);
        receipt.approve(address(router), type(uint256).max);
        vm.expectRevert();
        router.swap(o, 1e18, d);
        vm.stopPrank();
    }

    function test_exitAfterExpiry_reverts() public {
        (uint256 id,,, SeriesParams memory p) = _liveMarket();
        warpWithFeed(uint256(p.expiry) + 1);
        ISwapVM.Order memory o = exitOrder(id);
        bytes memory d = takerData(buyer1, true, id, Leg.EXIT);
        // The program's own Deadline instruction closes the leg before the engine is even reached.
        expectSwapRevert(
            buyer1, o, 1e18, d, abi.encodeWithSelector(Deadline.DeadlineReached.selector, uint256(p.expiry))
        );
    }

    function test_exitAfterFinalization_reverts() public {
        SeriesParams memory p = forwardParams();
        // A window that closes before the sale does, so EXIT is reachable while finalized.
        p.expiry = uint40(block.timestamp + 2 days);
        p.saleEnd = p.expiry;
        (uint256 id,,) = openMarket(p);
        buyUnits(buyer1, id, 5e18);
        warpWithFeed(uint256(p.expiry) + 1);
        finalizeSeries(id);

        ISwapVM.Order memory o = exitOrder(id);
        bytes memory d = takerData(buyer1, true, id, Leg.EXIT);
        expectSwapRevert(buyer1, o, 1e18, d, "");
    }

    function test_staleCheckpoints_blockExit() public {
        (uint256 id,,, SeriesParams memory p) = _liveMarket();
        warpWithFeed(block.timestamp + 5 * uint256(p.sampleInterval));
        ISwapVM.Order memory o = exitOrder(id);
        bytes memory d = takerData(buyer1, true, id, Leg.EXIT);
        expectSwapRevert(buyer1, o, 1e18, d, abi.encodeWithSelector(TremorMarketEngine.CheckpointsStale.selector, id));
    }

    function test_exitedReceiptsCannotBeExitedAgain() public {
        (uint256 id, VarianceReceipt receipt,,) = _liveMarket();
        exitUnits(buyer1, id, 20e18);
        assertEq(receipt.balanceOf(buyer1), 0);
        assertEq(factory.seriesView(id).outstandingUnits, 0);

        ISwapVM.Order memory o = exitOrder(id);
        bytes memory d = takerDataPartial(buyer1, true, id, Leg.EXIT);
        vm.prank(buyer1);
        vm.expectRevert(abi.encodeWithSelector(TremorMarketEngine.NothingToFill.selector, id, Leg.EXIT));
        router.swap(o, 1e18, d);
    }

    function test_exitThenRedeemTheRemainder() public {
        SeriesParams memory p = forwardParams();
        p.expiry = uint40(block.timestamp + 2 days);
        p.saleEnd = p.expiry;
        (uint256 id, VarianceReceipt receipt, TremorMakerVault vault) = openMarket(p);
        buyUnits(buyer1, id, 12e18);

        warpWithFeed(block.timestamp + 1 days);
        checkpointAll(id, 32);
        uint256 exited = exitUnits(buyer1, id, 5e18);
        assertGt(exited, 0);

        warpWithFeed(uint256(p.expiry) + 1);
        finalizeSeries(id);
        uint256 redeemed = redeemUnits(buyer1, id, 7e18);

        assertEq(receipt.balanceOf(buyer1), 0);
        assertEq(receipt.totalSupply(), p.maxUnits - 12e18, "all twelve consumed units burned");
        assertEq(factory.seriesView(id).outstandingUnits, 0);
        assertEq(vault.lockedQuote(), 0);
        assertGe(usdc.balanceOf(address(vault)), 0);
        assertGt(exited + redeemed, 0);
    }

    function test_transferBetweenHoldersPreservesTotalLiability() public {
        (uint256 id, VarianceReceipt receipt, TremorMakerVault vault,) = _liveMarket();
        uint256 lockedBefore = vault.lockedQuote();
        uint256 outstandingBefore = factory.seriesView(id).outstandingUnits;

        vm.prank(buyer1);
        receipt.transfer(buyer2, 7e18);
        assertEq(vault.lockedQuote(), lockedBefore, "a plain transfer changes no liability");
        assertEq(factory.seriesView(id).outstandingUnits, outstandingBefore);

        // And the new holder can exit their own units.
        assertGt(exitUnits(buyer2, id, 7e18), 0);
        assertEq(factory.seriesView(id).outstandingUnits, outstandingBefore - 7e18);
    }

    // ------------------------------------------------------------------ helpers

    function _market(uint256 id)
        internal
        view
        returns (uint256 bid, uint256 ask, uint256 projected, uint256 forward, uint256 realized)
    {
        (projected, bid, ask, forward, realized) = engine.market(id);
    }

    function _vaultOf(uint256 id) internal view returns (address vault) {
        (, vault,,,,,) = factory.series(id);
    }
}
