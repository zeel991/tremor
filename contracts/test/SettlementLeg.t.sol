// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";

import {TremorTestBase} from "./base/TremorTestBase.sol";
import {SeriesParams, Leg} from "../src/libs/SeriesParams.sol";
import {VariancePricing} from "../src/libs/VariancePricing.sol";
import {TremorMarketEngine} from "../src/TremorMarketEngine.sol";
import {TremorMakerVault} from "../src/TremorMakerVault.sol";
import {VarianceSeriesFactory} from "../src/VarianceSeriesFactory.sol";
import {VarianceReceipt} from "../src/tokens/VarianceReceipt.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";

/// @notice The SETTLE leg: `receipt -> USDC` at the fixed final payout, available to a holder without any
///   cooperation from the writer, for as long as they like.
contract SettlementLegTest is TremorTestBase {
    function _finalizedMarket(uint256 unitsBought)
        internal
        returns (uint256 id, VarianceReceipt receipt, TremorMakerVault vault, SeriesParams memory p)
    {
        p = forwardParams();
        p.expiry = uint40(block.timestamp + 2 days);
        p.saleEnd = p.expiry;
        (id, receipt, vault) = openMarket(p);
        buyUnits(buyer1, id, unitsBought);
        warpWithFeed(uint256(p.expiry) + 1);
        finalizeSeries(id);
    }

    function test_finalization_repricesLiabilityFromCapToPayout() public {
        SeriesParams memory p = forwardParams();
        p.expiry = uint40(block.timestamp + 2 days);
        p.saleEnd = p.expiry;
        (uint256 id,, TremorMakerVault vault) = openMarket(p);
        buyUnits(buyer1, id, 10e18);

        uint256 cappedLocked = vault.lockedQuote();
        assertEq(cappedLocked, expectedMaxLiability(10e18, p.unitNotional, p.capVariance));

        warpWithFeed(uint256(p.expiry) + 1);
        uint256 finalVariance = finalizeSeries(id);
        uint256 ppu = VariancePricing.payoutPerUnit(finalVariance, p.capVariance, p.unitNotional);
        assertEq(factory.seriesView(id).payoutPerUnit, ppu);

        uint256 expectedLocked = (10e18 * ppu + WAD - 1) / WAD;
        assertEq(vault.lockedQuote(), expectedLocked, "final liability uses the payout, not the cap");
        assertLt(vault.lockedQuote(), cappedLocked, "the cap surplus is released the moment it cannot be owed");
        assertGt(vault.freeQuote(), 0, "the surplus became withdrawable");
    }

    function test_capIsApplied_whenRealizedVarianceExceedsIt() public {
        // A deliberately violent path: the realized variance lands well above the cap.
        SeriesParams memory p = forwardParams();
        p.expiry = uint40(block.timestamp + 2 days);
        p.saleEnd = p.expiry;
        p.capVariance = 0.04e18; // 20% vol cap, far below what this path realizes
        p.anchorVariance = 0.02e18;
        p.impactPerUnit = 0.001e18;
        (uint256 id,, TremorMakerVault vault) = openMarket(p);
        buyUnits(buyer1, id, 10e18);

        // Push a jagged path so realized variance is large.
        uint256 t = block.timestamp;
        int256 price = feedLastPrice;
        while (t < uint256(p.expiry) + 1) {
            t += 600;
            price = price * (t % 1200 == 0 ? int256(1080) : int256(920)) / 1000;
            feed.pushRound(price, t);
        }
        feedLastTs = t;
        feedLastPrice = price;
        vm.warp(t);

        uint256 finalVariance = finalizeSeries(id);
        assertGt(finalVariance, p.capVariance, "the path realized more variance than the cap");
        assertEq(
            factory.seriesView(id).payoutPerUnit, uint256(p.unitNotional) * p.capVariance / WAD, "the payout is capped"
        );
        assertEq(
            vault.lockedQuote(),
            expectedMaxLiability(10e18, p.unitNotional, p.capVariance),
            "at the cap the reservation does not shrink"
        );

        uint256 out = redeemUnits(buyer1, id, 10e18);
        assertEq(out, 10e18 * (uint256(p.unitNotional) * p.capVariance / WAD) / WAD);
        assertGe(usdc.balanceOf(address(vault)), vault.lockedQuote());
    }

    function test_redeem_exactInPaysTheFixedPayout() public {
        (uint256 id,,, SeriesParams memory p) = _finalizedMarket(10e18);
        uint256 ppu = factory.seriesView(id).payoutPerUnit;
        (uint256 units, uint256 out) = lens.quoteSettleExactIn(id, 4e18);
        assertEq(units, 4e18);
        assertEq(out, 4e18 * ppu / WAD);
        assertEq(redeemUnits(buyer1, id, 4e18), out, "Lens quote equals the swap");
        p; // silence
    }

    function test_redeem_exactOutIsRejected() public {
        (uint256 id, VarianceReceipt receipt,,) = _finalizedMarket(10e18);
        ISwapVM.Order memory o = settlementOrder(id);
        bytes memory d = takerData(buyer1, false, id, Leg.SETTLE);
        vm.startPrank(buyer1);
        receipt.approve(address(router), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(TremorMarketEngine.ExactOutUnsupported.selector, Leg.SETTLE));
        router.swap(o, 1e6, d);
        vm.stopPrank();
    }

    function test_redeem_beforeFinalizationReverts() public {
        SeriesParams memory p = forwardParams();
        (uint256 id, VarianceReceipt receipt,) = openMarket(p);
        buyUnits(buyer1, id, 5e18);
        ISwapVM.Order memory o = settlementOrder(id);
        bytes memory d = takerData(buyer1, true, id, Leg.SETTLE);
        vm.startPrank(buyer1);
        receipt.approve(address(router), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(TremorMarketEngine.NotFinalized.selector, id));
        router.swap(o, 1e18, d);
        vm.stopPrank();
    }

    function test_partialRedemptions_sumWithinTheDefinedRoundingBound() public {
        (uint256 id, VarianceReceipt receipt, TremorMakerVault vault,) = _finalizedMarket(10e18);
        (, uint256 whole) = lens.quoteSettleExactIn(id, 10e18);

        uint256 summed;
        for (uint256 i = 0; i < 5; i++) {
            summed += redeemUnits(buyer1, id, 2e18);
            assertGe(usdc.balanceOf(address(vault)), vault.lockedQuote(), "solvent after every slice");
        }
        assertLe(summed, whole, "splitting a redemption cannot extract more than the whole");
        assertGe(summed + 5, whole, "and loses at most one base unit per slice");
        assertEq(receipt.balanceOf(buyer1), 0);
        assertEq(factory.seriesView(id).outstandingUnits, 0);
        assertEq(vault.lockedQuote(), 0);
    }

    function test_redeem_burnsReceiptsAndReleasesOnlyTheMatchingLiability() public {
        (uint256 id, VarianceReceipt receipt, TremorMakerVault vault, SeriesParams memory p) = _finalizedMarket(10e18);
        uint256 supplyBefore = receipt.totalSupply();
        uint256 lockedBefore = vault.lockedQuote();
        uint256 ppu = factory.seriesView(id).payoutPerUnit;

        uint256 out = redeemUnits(buyer1, id, 6e18);
        assertEq(receipt.totalSupply(), supplyBefore - 6e18);
        uint256 expectedLocked = (4e18 * ppu + WAD - 1) / WAD;
        assertEq(vault.lockedQuote(), expectedLocked);
        assertLe(out, lockedBefore - expectedLocked, "paid more than the liability released");
        assertEq(receipt.balanceOf(address(vault)), p.maxUnits - 10e18, "no redeemed receipt returned to stock");
    }

    function test_redemptionNeedsNoWriterAction() public {
        (uint256 id,, TremorMakerVault vault,) = _finalizedMarket(10e18);
        // The writer withdraws every unreserved dollar and then does nothing further, ever.
        uint256 free = vault.freeQuote();
        if (free > 0) {
            vm.prank(writer);
            vault.withdrawFree(free, writer);
        }
        assertEq(vault.freeQuote(), 0);
        uint256 out = redeemUnits(buyer1, id, 10e18);
        assertGt(out, 0, "a holder must be able to redeem with no writer cooperation at all");
        assertEq(vault.lockedQuote(), 0);
    }

    function test_veryLateRedemptionStillWorks() public {
        (uint256 id,,,) = _finalizedMarket(10e18);
        vm.warp(block.timestamp + 3650 days); // ten years later
        assertGt(redeemUnits(buyer1, id, 10e18), 0, "SETTLE has no deadline on purpose");
    }

    function test_zeroPayout_usesTheExplicitBurnPath() public {
        // A perfectly flat price path realizes zero variance.
        SeriesParams memory p = forwardParams();
        p.expiry = uint40(block.timestamp + 2 days);
        p.saleEnd = p.expiry;
        (uint256 id, VarianceReceipt receipt, TremorMakerVault vault) = openMarket(p);
        buyUnits(buyer1, id, 10e18);

        uint256 t = block.timestamp;
        while (t < uint256(p.expiry) + 1) {
            t += 600;
            feed.pushRound(feedLastPrice, t);
        }
        feedLastTs = t;
        vm.warp(t);

        uint256 finalVariance = finalizeSeries(id);
        assertEq(finalVariance, 0, "a flat path realizes no variance");
        assertEq(factory.seriesView(id).payoutPerUnit, 0);
        assertEq(vault.lockedQuote(), 0, "nothing can be owed, so nothing stays reserved");

        // SwapVM rejects a swap with zero output, so the SETTLE leg refuses rather than pretending.
        ISwapVM.Order memory o = settlementOrder(id);
        bytes memory d = takerData(buyer1, true, id, Leg.SETTLE);
        vm.startPrank(buyer1);
        receipt.approve(address(router), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(TremorMarketEngine.ZeroPayout.selector, id));
        router.swap(o, 1e18, d);
        vm.stopPrank();

        // The explicit path lets the holder close their position and the series reach zero outstanding.
        vm.prank(buyer1);
        factory.burnWorthless(id, 10e18);
        assertEq(receipt.balanceOf(buyer1), 0);
        assertEq(factory.seriesView(id).outstandingUnits, 0);
    }

    function test_burnWorthless_rejectedWhenThePayoutIsPositive() public {
        (uint256 id,,,) = _finalizedMarket(10e18);
        uint256 ppu = factory.seriesView(id).payoutPerUnit;
        assertGt(ppu, 0);
        vm.prank(buyer1);
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.PayoutNotZero.selector, ppu));
        factory.burnWorthless(id, 1e18);
    }

    function test_burnWorthless_rejectedBeforeFinalization() public {
        (uint256 id,,) = openMarket();
        buyUnits(buyer1, id, 1e18);
        vm.prank(buyer1);
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.NotFinalized.selector, id));
        factory.burnWorthless(id, 1e18);
    }

    function test_onBurn_rejectsCallersThatAreNotTheSeriesReceipt() public {
        (uint256 id,,,) = _finalizedMarket(10e18);
        (,,,,, bytes32 settleHash,) = factory.series(id);
        vm.prank(buyer1);
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.NotSeriesReceipt.selector, buyer1));
        factory.onBurn(settleHash, buyer1, 1e18, 1);
    }

    function test_onBurn_rejectsAnUnknownOrderHash() public {
        (uint256 id, VarianceReceipt receipt,,) = _finalizedMarket(10e18);
        vm.prank(address(receipt));
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.WrongLeg.selector, Leg.NONE));
        factory.onBurn(keccak256("nope"), buyer1, 1e18, 1);
        id;
    }

    function test_onBurn_rejectsTheIssueLegHash() public {
        (uint256 id, VarianceReceipt receipt,,) = _finalizedMarket(10e18);
        (,,, bytes32 issueHash,,,) = factory.series(id);
        vm.prank(address(receipt));
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.WrongLeg.selector, Leg.ISSUE));
        factory.onBurn(issueHash, buyer1, 1e18, 1);
    }

    function test_onBurn_cannotClaimMoreThanTheLiabilityItReleases() public {
        (uint256 id, VarianceReceipt receipt,,) = _finalizedMarket(10e18);
        (,,,,, bytes32 settleHash,) = factory.series(id);
        uint256 ppu = factory.seriesView(id).payoutPerUnit;
        uint256 released = factory.seriesView(id).lockedLiability - ((9e18 * ppu + WAD - 1) / WAD);
        vm.prank(address(receipt));
        vm.expectRevert(
            abi.encodeWithSelector(
                VarianceSeriesFactory.PayoutExceedsReleasedLiability.selector, released + 1, released
            )
        );
        factory.onBurn(settleHash, buyer1, 1e18, released + 1);
    }

    function test_finalizationIsIdempotentInEffect() public {
        (uint256 id,,,) = _finalizedMarket(10e18);
        uint256 fv = factory.seriesView(id).finalVariance;
        uint256 ppu = factory.seriesView(id).payoutPerUnit;
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.AlreadyFinalized.selector, id));
        accumulator.finalize(id);
        assertEq(factory.seriesView(id).finalVariance, fv);
        assertEq(factory.seriesView(id).payoutPerUnit, ppu);
    }
}
