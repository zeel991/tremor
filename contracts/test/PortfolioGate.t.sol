// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {SwapQuery, SwapRegisters} from "swap-vm/libs/VM.sol";

import {TremorMakerVault} from "../src/TremorMakerVault.sol";
import {VarianceReceipt} from "../src/tokens/VarianceReceipt.sol";
import {PortfolioOrderBuilder as POB} from "../src/portfolio/PortfolioOrderBuilder.sol";
import {PortfolioMath} from "../src/portfolio/PortfolioMath.sol";
import {TremorPortfolioMarket} from "../src/portfolio/TremorPortfolioMarket.sol";
import {PortfolioTestBase} from "./base/PortfolioTestBase.sol";

/// @notice The six-hour feasibility gate for portfolio-backed complementary claims (Tremor v3 experiment).
///
///   Every trade in this suite executes through the UNMODIFIED official `AquaSwapVMRouter` against real
///   Aqua strategies; nothing is mocked between the taker and the vault.
contract PortfolioGateTest is PortfolioTestBase {
    // ------------------------------------------------------------------ gate 1+2+3: issuance and reservation
    // ------------------------------------------------------------------ gate 1+2+3: issuance and reservation

    function test_gate1_issueHighThroughRouter() public {
        openGroup(100e6);
        uint256 premium = buy(buyer1, true, 100e18, false);

        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        assertEq(premium, 30e6, "100 units at $0.30 ask");
        assertEq(VarianceReceipt(v.highReceipt).balanceOf(buyer1), 100e18);
        assertEq(v.highOutstanding, 100e18);
        assertEq(v.reserveLocked, 100e6, "reserve = S * max(100, 0)");
        assertEq(vault.lockedQuote(), 100e6);
        assertEq(vault.quoteBalance(), 130e6, "funding + premium");
    }

    function test_gate2_issueCalmSharesBacking() public {
        openGroup(100e6);
        buy(buyer1, true, 100e18, false);
        uint256 premium = buy(buyer2, false, 100e18, false);

        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        assertEq(premium, 75e6, "100 units at $0.75 ask");
        assertEq(v.calmOutstanding, 100e18);
        assertEq(v.reserveLocked, 100e6, "100 HIGH + 100 CALM still reserve $100, not $200");
        assertEq(v.standaloneCaps, 200e6, "separate full-cap backing would be $200");
        assertEq(vault.lockedQuote(), 100e6);
        // The CALM sale consumed NO additional collateral: the writer's free balance grew by both premiums.
        assertEq(vault.freeQuote(), 105e6);
    }

    function test_gate3_reservationTracksAggregateMax() public {
        openGroup(100e6);
        buy(buyer1, true, 60e18, false); // 60 HIGH
        assertEq(market.groupView(gid).reserveLocked, _refReserve(60e18, 0));
        buy(buyer2, false, 100e18, false); // + 100 CALM -> max = 100
        assertEq(market.groupView(gid).reserveLocked, _refReserve(60e18, 100e18));
        assertEq(market.groupView(gid).reserveLocked, 100e6);
        buy(buyer1, true, 40e18, false); // 100 HIGH total, still max = 100
        assertEq(market.groupView(gid).reserveLocked, 100e6);
        assertGe(market.groupView(gid).reserveLocked, _refWorstPayout(100e18, 100e18));
    }

    function test_gate3b_issuanceClampsToCollateralCapacity() public {
        openGroup(100e6); // exactly $100 free
        // 150 HIGH would need $150 of reserve; only 100 is affordable. Partial fill delivers 100.
        buy(buyer1, true, 150e18, true);
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        assertEq(v.highOutstanding, 100e18, "clamped to collateral capacity");
        // CALM inherits headroom up to max(h,c) plus premium-grown free balance.
        buy(buyer2, false, 100e18, false);
        assertEq(market.groupView(gid).reserveLocked, 100e6);
    }

    // ------------------------------------------------------------------ gate 4: quote == swap

    function test_gate4_quoteMatchesSwapAtIdenticalState() public {
        openGroup(100e6);
        ISwapVM.Order memory o = market.orderFor(gid, POB.PMode.ISSUE_HIGH);
        bytes memory d = takerData(buyer1, false, legDirection(POB.PMode.ISSUE_HIGH), false);

        vm.prank(buyer1);
        (uint256 qIn, uint256 qOut,) = viewRouter.quote(o, 100e18, d);
        vm.prank(buyer1);
        (uint256 sIn, uint256 sOut,) = router.swap(o, 100e18, d);
        assertEq(qIn, sIn, "quoted premium == executed premium");
        assertEq(qOut, sOut, "quoted units == executed units");

        // Same identity on the exit leg once it is fundable.
        fundVault(10e6);
        vm.prank(writer);
        market.allocateExitBuffer(gid, 10e6);
        POB.PMode mode = POB.PMode.EXIT_HIGH;
        ISwapVM.Order memory oe = market.orderFor(gid, mode);
        bytes memory de = takerData(buyer1, true, legDirection(mode), false);
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        vm.startPrank(buyer1);
        VarianceReceipt(v.highReceipt).approve(address(router), type(uint256).max);
        (uint256 qeIn, uint256 qeOut,) = viewRouter.quote(oe, 20e18, de);
        (uint256 seIn, uint256 seOut,) = router.swap(oe, 20e18, de);
        vm.stopPrank();
        assertEq(qeIn, seIn);
        assertEq(qeOut, seOut);
        assertEq(seOut, 5e6, "20 units at $0.25 bid");
    }

    // ------------------------------------------------------------------ gate 5: the critical exit rule

    /// @notice Cash $100, outstanding 100 HIGH + 100 CALM, reserve $100. Buying back 20 HIGH for $5 must
    ///   fail: removing HIGH from the smaller-or-equal side releases zero reserve and no buffer exists.
    function test_gate5_underfundedExitRejected() public {
        openGroup(100e6);
        buy(buyer1, true, 100e18, false);
        buy(buyer2, false, 100e18, false);

        // Strip the premiums so the vault holds exactly the $100 reserve and nothing free.
        uint256 freeNow = vault.freeQuote();
        vm.prank(writer);
        vault.withdrawFree(freeNow, writer);
        assertEq(vault.quoteBalance(), 100e6);
        assertEq(vault.lockedQuote(), 100e6);

        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        ISwapVM.Order memory o = market.orderFor(gid, POB.PMode.EXIT_HIGH);
        bytes memory d = takerData(buyer1, true, legDirection(POB.PMode.EXIT_HIGH), false);
        vm.startPrank(buyer1);
        VarianceReceipt(v.highReceipt).approve(address(router), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(TremorPortfolioMarket.ExitUnderfunded.selector, gid, 5e6, 0));
        router.swap(o, 20e18, d);
        vm.stopPrank();

        // Nothing moved.
        v = market.groupView(gid);
        assertEq(v.highOutstanding, 100e18);
        assertEq(v.reserveLocked, 100e6);
        assertEq(vault.quoteBalance(), 100e6);
    }

    /// @notice Same state, but exiting the LARGER side releases real reserve and succeeds with no buffer.
    function test_gate5b_exitOfLargerSideReleasesReserve() public {
        openGroup(100e6);
        buy(buyer1, true, 100e18, false);
        buy(buyer2, false, 40e18, false); // h=100 > c=40
        uint256 freeNow = vault.freeQuote();
        vm.prank(writer);
        vault.withdrawFree(freeNow, writer);

        // Burning 20 HIGH: reserve falls from $100 to $80, releasing $20 >= the $5 bid.
        uint256 got = exitSwap(buyer1, true, 20e18);
        assertEq(got, 5e6);
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        assertEq(v.highOutstanding, 80e18);
        assertEq(v.reserveLocked, 80e6);
        assertEq(vault.lockedQuote(), 80e6);
        assertEq(vault.quoteBalance(), 95e6);
        assertGe(vault.quoteBalance(), vault.lockedQuote());
    }

    // ------------------------------------------------------------------ gate 6: a funded exit succeeds

    function test_gate6_bufferFundedExitSucceeds() public {
        openGroup(100e6);
        buy(buyer1, true, 100e18, false);
        buy(buyer2, false, 100e18, false);
        uint256 freeNow = vault.freeQuote();
        vm.prank(writer);
        vault.withdrawFree(freeNow, writer);

        // Writer funds $5 and locks it as the exit buffer.
        fundVault(5e6);
        vm.prank(writer);
        market.allocateExitBuffer(gid, 5e6);
        assertEq(vault.lockedQuote(), 105e6);

        uint256 got = exitSwap(buyer1, true, 20e18);
        assertEq(got, 5e6, "20 HIGH at $0.25 bid");

        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        assertEq(v.highOutstanding, 80e18);
        assertEq(v.calmOutstanding, 100e18);
        assertEq(v.reserveLocked, 100e6, "max(80,100) still reserves $100");
        assertEq(v.exitBuffer, 0, "the buffer paid for the buyback");
        assertEq(vault.quoteBalance(), 100e6);
        assertEq(vault.lockedQuote(), 100e6);
        assertGe(vault.quoteBalance(), _refWorstPayout(80e18, 100e18));
    }

    // ------------------------------------------------------------------ gate 7: finalization and redemption

    function test_gate7_finalizeOnceRedeemBothSides() public {
        openGroup(100e6);
        buy(buyer1, true, 100e18, false);
        buy(buyer2, false, 100e18, false);

        warpWithFeed(uint256(defaultParams().expiry) + 1);
        uint256 finalVariance = finalizeGroup();

        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        assertTrue(v.finalized);
        assertEq(v.finalVariance, finalVariance);
        assertEq(v.highPpu + v.calmPpu, S, "per-unit payouts sum to exactly S");
        // Exact final liabilities replace the worst-case reserve.
        uint256 expectLocked = 100e18 * v.highPpu / WAD + 100e18 * v.calmPpu / WAD;
        assertEq(v.reserveLocked, expectLocked);
        assertLe(v.reserveLocked, 100e6);

        // Both sides redeem through the router, in either order, without writer cooperation.
        uint256 highPay = v.highPpu > 0 ? redeemSwap(buyer1, true, 100e18) : 0;
        uint256 calmPay = v.calmPpu > 0 ? redeemSwap(buyer2, false, 100e18) : 0;
        if (v.highPpu == 0) market.burnWorthless(gid, true, 0); // unreachable with this feed path; guard anyway
        assertEq(highPay, 100e18 * v.highPpu / WAD);
        assertEq(calmPay, 100e18 * v.calmPpu / WAD);
        assertLe(highPay + calmPay, 100e6, "total payout inside the shared reserve");

        v = market.groupView(gid);
        assertEq(v.highOutstanding, 0);
        assertEq(v.calmOutstanding, 0);
        assertEq(v.reserveLocked, 0);
        assertEq(vault.lockedQuote(), 0);
        assertGe(vault.quoteBalance(), 0);

        // The writer walks away with funding + premiums - payouts, all of it now free.
        uint256 expectedVaultBalance = 100e6 + 30e6 + 75e6 - highPay - calmPay;
        assertEq(vault.quoteBalance(), expectedVaultBalance);
        vm.prank(writer);
        vault.withdrawFree(expectedVaultBalance, writer);
    }

    /// @notice Fragmented redemption: many holders, partial redemptions, both orders — never exceeds reserve.
    function test_gate7b_fragmentedRedemptionStaysBounded() public {
        openGroup(100e6);
        buy(buyer1, true, 100e18, false);
        buy(buyer2, false, 100e18, false);
        TremorPortfolioMarket.GroupView memory v0 = market.groupView(gid);
        vm.prank(buyer1);
        VarianceReceipt(v0.highReceipt).transfer(buyer2, 37e18);

        warpWithFeed(uint256(defaultParams().expiry) + 1);
        finalizeGroup();
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        vm.assume(v.highPpu > 0 && v.calmPpu > 0);

        uint256 total;
        total += redeemSwap(buyer2, false, 40e18);
        total += redeemSwap(buyer1, true, 63e18);
        total += redeemSwap(buyer2, false, 60e18);
        total += redeemSwap(buyer2, true, 37e18);
        assertLe(total, 100e6);
        assertEq(market.groupView(gid).reserveLocked, 0);
        assertGe(vault.quoteBalance(), vault.lockedQuote());
    }

    // ------------------------------------------------------------------ reference-model fuzz

    /// @notice The contract's reserve always bounds the grid-scanned worst-case payout, and matches the
    ///   hand-derived reserve exactly, for arbitrary issued amounts.
    function testFuzz_reserveBoundsWorstCase(uint96 hRaw, uint96 cRaw) public {
        uint256 h = uint256(hRaw) % 1000e18;
        uint256 c = uint256(cRaw) % 1000e18;
        openGroup(1100e6); // enough for any single side
        if (h > 0) buy(buyer1, true, h, false);
        if (c > 0) buy(buyer2, false, c, false);
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        assertEq(v.reserveLocked, _refReserve(h, c));
        assertGe(v.reserveLocked, _refWorstPayout(h, c));
        assertLe(v.reserveLocked, v.standaloneCaps);
        assertGe(vault.quoteBalance(), vault.lockedQuote());
    }

    // ------------------------------------------------------------------ adversarial spot checks

    function test_adv_directExtructionCallRejected() public {
        openGroup(100e6);
        bytes32 h = market.orderHashFor(gid, POB.PMode.ISSUE_HIGH);
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        // Even a query naming the REAL vault and real hash dies on the router check.
        SwapQuery memory q = SwapQuery(h, address(vault), buyer1, address(usdc), v.highReceipt, true);
        bytes memory args = POB.args(gid, POB.PMode.ISSUE_HIGH);
        vm.prank(buyer1);
        vm.expectRevert(abi.encodeWithSelector(TremorPortfolioMarket.NotRouter.selector, buyer1));
        market.extruction(false, 0, q, SwapRegisters(0, 0, 30e6, 0), args, "");
    }

    function test_adv_writerCannotWithdrawReserve() public {
        openGroup(100e6);
        buy(buyer1, true, 100e18, false);
        uint256 free = vault.freeQuote();
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(TremorMakerVault.ExceedsFree.selector, free + 1, free));
        vault.withdrawFree(free + 1, writer);
    }

    function test_adv_onBurnOnlyFromGroupReceipt() public {
        openGroup(100e6);
        buy(buyer1, true, 100e18, false);
        bytes32 h = market.orderHashFor(gid, POB.PMode.EXIT_HIGH);
        vm.expectRevert(abi.encodeWithSelector(TremorPortfolioMarket.NotGroupReceipt.selector, address(this)));
        market.onBurn(h, buyer1, 10e18, 100e6);
    }

    function test_adv_issueOrderCannotRunBackwards() public {
        openGroup(100e6);
        buy(buyer1, true, 100e18, false);
        // Swap the ISSUE order in the receipt->USDC direction: direction check must kill it.
        ISwapVM.Order memory o = market.orderFor(gid, POB.PMode.ISSUE_HIGH);
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        bytes memory d = takerData(buyer1, true, v.highReceipt < address(usdc), false);
        vm.startPrank(buyer1);
        VarianceReceipt(v.highReceipt).approve(address(router), type(uint256).max);
        vm.expectRevert();
        router.swap(o, 10e18, d);
        vm.stopPrank();
    }

    function test_adv_finalizeOnlyOnceAndOnlyAccumulator() public {
        openGroup(100e6);
        vm.expectRevert(abi.encodeWithSelector(TremorPortfolioMarket.NotAccumulator.selector, address(this)));
        market.onFinalize(gid, 1e18);

        warpWithFeed(uint256(defaultParams().expiry) + 1);
        finalizeGroup();
        address acc = market.ACCUMULATOR();
        vm.prank(acc);
        vm.expectRevert(abi.encodeWithSelector(TremorPortfolioMarket.AlreadyFinalized.selector, gid));
        market.onFinalize(gid, 1e18);
    }

    function test_adv_exitBufferWithdrawIsWriterOnly() public {
        openGroup(100e6);
        fundVault(5e6);
        vm.prank(writer);
        market.allocateExitBuffer(gid, 5e6);
        vm.prank(buyer1);
        vm.expectRevert(abi.encodeWithSelector(TremorPortfolioMarket.NotWriter.selector, writer, buyer1));
        market.withdrawExitBuffer(gid, 5e6);
        vm.prank(writer);
        market.withdrawExitBuffer(gid, 5e6);
        assertEq(vault.freeQuote(), 5e6 + 100e6);
    }

    /// @notice Fractional-unit rounding: verify nonzero remainder during division in reserve,
    ///   issue, exit, final liabilities, and settlement proceeds.
    function test_fractionalUnitRounding_withNonzeroRemainder() public {
        openGroup(100e6);

        // Prime numbers designed to guarantee non-zero remainders modulo 1e18
        uint256 hUnits = 33_333_333_333_333_333_337; // ~33.333 units
        uint256 cUnits = 17_777_777_777_777_777_779; // ~17.777 units

        // 1. Check PortfolioMath.reserve division remainder: (m * S) % 1e18 != 0
        uint256 m = hUnits > cUnits ? hUnits : cUnits;
        uint256 remReserve = (m * S) % WAD;
        assertTrue(remReserve > 0, "reserve calculation must have nonzero remainder");
        uint256 expectedReserve = (m * S + WAD - 1) / WAD; // ceil
        assertEq(PortfolioMath.reserve(hUnits, cUnits, S), expectedReserve);

        // 2. Buy fractional units through router
        buy(buyer1, true, hUnits, false);
        buy(buyer2, false, cUnits, false);

        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        assertEq(v.highOutstanding, hUnits);
        assertEq(v.calmOutstanding, cUnits);
        assertEq(v.reserveLocked, expectedReserve);

        // 3. Finalize with fractional outcome where (units * ppu) % 1e18 != 0
        warpWithFeed(uint256(defaultParams().expiry) + 1);
        finalizeGroup();

        v = market.groupView(gid);
        assertTrue(v.finalized);

        // Check nonzero remainder on side liabilities
        uint256 hRem = (hUnits * v.highPpu) % WAD;
        uint256 cRem = (cUnits * v.calmPpu) % WAD;
        // Either h or c has nonzero remainder unless ppu is exactly 0 or an integer multiple
        assertTrue(hRem > 0 || cRem > 0, "final side liability must have nonzero remainder");

        uint256 expectedFinalLocked =
            PortfolioMath.finalSideLiability(hUnits, v.highPpu) + PortfolioMath.finalSideLiability(cUnits, v.calmPpu);
        assertEq(v.reserveLocked, expectedFinalLocked);
        assertEq(v.exitBuffer, 0);

        // 4. Settle fills match exact floored integer liability
        if (v.highPpu > 0) {
            uint256 gotHigh = redeemSwap(buyer1, true, hUnits);
            assertEq(gotHigh, hUnits * v.highPpu / WAD);
        }
        if (v.calmPpu > 0) {
            uint256 gotCalm = redeemSwap(buyer2, false, cUnits);
            assertEq(gotCalm, cUnits * v.calmPpu / WAD);
        }

        v = market.groupView(gid);
        if (v.highPpu > 0) assertEq(v.highOutstanding, 0);
        if (v.calmPpu > 0) assertEq(v.calmOutstanding, 0);
    }

    /// @notice Worthless burn integration coverage & finalized reserve/buffer parity.
    function test_worthlessBurn_integrationAndParity() public {
        openGroup(100e6);
        fundVault(10e6);
        vm.prank(writer);
        market.allocateExitBuffer(gid, 10e6);

        // Issue 50 HIGH and 50 CALM
        buy(buyer1, true, 50e18, false);
        buy(buyer2, false, 50e18, false);

        TremorPortfolioMarket.GroupView memory vBefore = market.groupView(gid);
        assertEq(vBefore.exitBuffer, 10e6);
        assertEq(vBefore.reserveLocked, 50e6);

        // Artificially finalize group via onFinalize prank with finalVariance = 0 (xWad = 0 => highPpu = 0, calmPpu = 1e6)
        warpWithFeed(uint256(defaultParams().expiry) + 1);
        address acc = market.ACCUMULATOR();
        vm.prank(acc);
        market.onFinalize(gid, 0);

        TremorPortfolioMarket.GroupView memory vFinal = market.groupView(gid);
        assertTrue(vFinal.finalized);
        assertEq(vFinal.highPpu, 0, "HIGH must be worthless");
        assertEq(vFinal.calmPpu, 1e6, "CALM must pay full cap S");
        // Parity: exitBuffer must be zeroed out
        assertEq(vFinal.exitBuffer, 0, "finalized exitBuffer must be 0");
        // CALM liability = 50e18 * 1e6 / 1e18 = 50e6; HIGH liability = 0; newLocked = 50e6
        assertEq(vFinal.reserveLocked, 50e6, "reserveLocked must retain exact remaining liability");

        // Attempting to redeem worthless HIGH through swap router must revert with ZeroPayout
        ISwapVM.Order memory oHigh = market.orderFor(gid, POB.PMode.SETTLE_HIGH);
        bytes memory dHigh = takerData(buyer1, true, legDirection(POB.PMode.SETTLE_HIGH), false);
        vm.startPrank(buyer1);
        VarianceReceipt(vFinal.highReceipt).approve(address(router), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(TremorPortfolioMarket.ZeroPayout.selector, gid, POB.PMode.SETTLE_HIGH));
        router.swap(oHigh, 50e18, dHigh);
        vm.stopPrank();

        // Successful worthless burn reduces highOutstanding to 0 without paying out collateral
        uint256 buyer1UsdcBefore = usdc.balanceOf(buyer1);
        vm.prank(buyer1);
        market.burnWorthless(gid, true, 50e18);
        assertEq(usdc.balanceOf(buyer1), buyer1UsdcBefore, "worthless burn pays 0 USDC");

        TremorPortfolioMarket.GroupView memory vBurned = market.groupView(gid);
        assertEq(vBurned.highOutstanding, 0, "highOutstanding must be 0 after burn");
        assertEq(vBurned.calmOutstanding, 50e18, "calmOutstanding remains intact");
        assertEq(vBurned.reserveLocked, 50e6, "reserveLocked still protects calm holders");

        // Now redeem the valuable CALM side
        uint256 calmProceeds = redeemSwap(buyer2, false, 50e18);
        assertEq(calmProceeds, 50e6);

        TremorPortfolioMarket.GroupView memory vDone = market.groupView(gid);
        assertEq(vDone.calmOutstanding, 0);
        assertEq(vDone.reserveLocked, 0);
    }
}
