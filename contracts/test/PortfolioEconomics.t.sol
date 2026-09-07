// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";

import {VarianceReceipt} from "../src/tokens/VarianceReceipt.sol";
import {PortfolioOrderBuilder as POB} from "../src/portfolio/PortfolioOrderBuilder.sol";
import {TremorPortfolioMarket} from "../src/portfolio/TremorPortfolioMarket.sol";
import {PortfolioTestBase} from "./base/PortfolioTestBase.sol";

/// @notice Economically relevant round trips and complementary-price relationships under the DISCLOSED
///   pricing model: the writer's fixed executable bid/ask per side. These quotes are the writer's prices,
///   not a live fair-value volatility model, and solvency never depends on them — which is exactly what the
///   mispriced-quotes test demonstrates: a writer who quotes badly loses their own money, never the
///   holders' backing.
contract PortfolioEconomicsTest is PortfolioTestBase {
    /// @notice Buy-then-exit round trip costs the holder exactly the quoted spread, maker-favoring.
    function test_roundTripCostsExactlyTheSpread() public {
        openGroup(100e6);
        uint256 before = usdc.balanceOf(buyer1);
        uint256 premium = buy(buyer1, true, 20e18, false); // 20 * $0.30 = $6.00
        assertEq(premium, 6e6);

        // Fund the buyback: h=20 <= c=0? no, h is the larger side, exiting releases reserve.
        uint256 got = exitSwap(buyer1, true, 20e18); // 20 * $0.25 = $5.00
        assertEq(got, 5e6);
        assertEq(before - usdc.balanceOf(buyer1), 1e6, "round trip cost = units * (ask - bid)");
        // The writer keeps the spread as free collateral; nothing remains reserved.
        assertEq(market.groupView(gid).reserveLocked, 0);
        assertEq(vault.freeQuote(), 101e6);
    }

    /// @notice With askHigh + askCalm >= S, a balanced book collects more premium than its worst-case
    ///   payout: the writer cannot lose on the balanced portion at these quotes.
    function test_balancedBookPremiumCoversWorstCase() public {
        TremorPortfolioMarket.GroupParams memory p = defaultParams();
        assertGe(uint256(p.askHigh) + p.askCalm, uint256(p.capPayoutPerUnit), "fixture quotes sum above S");

        openGroup(100e6);
        uint256 premiums = buy(buyer1, true, 100e18, false) + buy(buyer2, false, 100e18, false);
        assertEq(premiums, 105e6);
        assertEq(market.groupView(gid).reserveLocked, 100e6, "worst-case payout of the balanced book");
        assertGe(premiums, market.groupView(gid).reserveLocked);
    }

    /// @notice A holder cannot assemble a riskless profit at quotes summing above S: 1 HIGH + 1 CALM pays
    ///   exactly S at ANY outcome, and costs more than S to buy.
    function test_buyingBothSidesCostsMoreThanTheirJointPayout() public {
        openGroup(100e6);
        uint256 cost = buy(buyer1, true, 10e18, false) + buy(buyer1, false, 10e18, false);
        assertEq(cost, 10.5e6, "10 * ($0.30 + $0.75)");

        warpWithFeed(uint256(defaultParams().expiry) + 1);
        finalizeGroup();
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        uint256 payout = (v.highPpu > 0 ? redeemSwap(buyer1, true, 10e18) : 0)
            + (v.calmPpu > 0 ? redeemSwap(buyer1, false, 10e18) : 0);
        assertEq(payout, 10e6, "a complete set pays exactly S per unit at any outcome");
        assertLt(payout, cost);
    }

    /// @notice The flip side, stated honestly: a writer who quotes asks summing BELOW S sells a guaranteed
    ///   loss on complete sets — and the loss lands on the writer's capital, never on holder backing.
    ///   Quotes are the writer's responsibility; solvency is the protocol's.
    function test_mispricedQuotesLoseTheWritersMoneyNotTheHolders() public {
        TremorPortfolioMarket.GroupParams memory p = defaultParams();
        p.askHigh = 0.2e6;
        p.bidHigh = 0.15e6;
        p.askCalm = 0.7e6; // 0.20 + 0.70 = $0.90 < $1.00: every complete set sold is a $0.10 gift
        p.bidCalm = 0.65e6;
        fundVault(100e6);
        vm.prank(writer);
        gid = market.createGroup(address(vault), p);

        uint256 cost = buy(buyer1, true, 100e18, false) + buy(buyer1, false, 100e18, false);
        assertEq(cost, 90e6);

        warpWithFeed(uint256(p.expiry) + 1);
        finalizeGroup();
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        uint256 payout = (v.highPpu > 0 ? redeemSwap(buyer1, true, 100e18) : 0)
            + (v.calmPpu > 0 ? redeemSwap(buyer1, false, 100e18) : 0);
        assertEq(payout, 100e6, "holders are paid in full from the reserve");
        assertEq(usdc.balanceOf(buyer1) >= 1_000_000e6 ? 1 : 0, 1, "the arbitrageur profited");

        // The writer's vault absorbed the $10 loss and is exactly solvent for it: funded 100, collected 90,
        // paid 100, keeps 90 free.
        assertEq(vault.quoteBalance(), 90e6);
        assertEq(vault.lockedQuote(), 0);
    }

    /// @notice Exits quoted while a buffer exists can become unavailable when the writer withdraws unused
    ///   exit liquidity — while settlement backing stays locked. This is the disclosed trade-off the UI
    ///   must state.
    function test_exitAvailabilityCanBeWithdrawnSettlementBackingCannot() public {
        openGroup(100e6);
        buy(buyer1, true, 100e18, false);
        buy(buyer2, false, 100e18, false);
        uint256 freeNow = vault.freeQuote();
        vm.prank(writer);
        vault.withdrawFree(freeNow, writer);
        fundVault(5e6);
        vm.prank(writer);
        market.allocateExitBuffer(gid, 5e6);

        // The exit is quotable right now...
        // ...but the writer withdraws the buffer before the holder executes.
        vm.prank(writer);
        market.withdrawExitBuffer(gid, 5e6);
        vm.prank(writer);
        vault.withdrawFree(5e6, writer);

        // The exit is now unavailable -- and the settlement backing is exactly intact.
        assertEq(vault.quoteBalance(), 100e6);
        assertEq(vault.lockedQuote(), 100e6);
        {
            TremorPortfolioMarket.GroupView memory gv = market.groupView(gid);
            ISwapVM.Order memory o = market.orderFor(gid, POB.PMode.EXIT_HIGH);
            bytes memory d = takerData(buyer1, true, legDirection(POB.PMode.EXIT_HIGH), false);
            vm.startPrank(buyer1);
            VarianceReceipt(gv.highReceipt).approve(address(router), type(uint256).max);
            vm.expectRevert(abi.encodeWithSelector(TremorPortfolioMarket.ExitUnderfunded.selector, gid, 5e6, 0));
            router.swap(o, 20e18, d);
            vm.stopPrank();
        }

        // Holders can still always settle at finalization.
        warpWithFeed(uint256(defaultParams().expiry) + 1);
        finalizeGroup();
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        uint256 payout = (v.highPpu > 0 ? redeemSwap(buyer1, true, 100e18) : 0)
            + (v.calmPpu > 0 ? redeemSwap(buyer2, false, 100e18) : 0);
        assertEq(payout, 100e18 * v.highPpu / 1e18 + 100e18 * v.calmPpu / 1e18);
    }
}
