// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {TakerTraitsLib} from "swap-vm/libs/TakerTraits.sol";
import {AquaSwapVMRouter} from "swap-vm/routers/AquaSwapVMRouter.sol";

import {TremorMakerVault} from "../src/TremorMakerVault.sol";
import {VarianceAccumulator} from "../src/VarianceAccumulator.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {PortfolioOrderBuilder as POB} from "../src/portfolio/PortfolioOrderBuilder.sol";
import {TremorPortfolioMarket} from "../src/portfolio/TremorPortfolioMarket.sol";

/// @notice The full portfolio (v3) lifecycle on a Base-mainnet fork: canonical Aqua, the unmodified
///   official `AquaSwapVMRouter`, real Circle USDC, and the REAL Chainlink ETH/USD round history walked in
///   bounded permissionless checkpoints. The back-dated group path is chain-31337-only, exactly like v2's.
///
/// @dev BASE_RPC_URL=<url> forge test --match-contract PortfolioForkE2E -vv
contract PortfolioForkE2ETest is Test {
    address constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant FEED = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;

    uint256 constant WAD = 1e18;
    uint128 constant S = 1e6;

    AquaSwapVMRouter router;
    TremorPortfolioMarket market;
    VarianceAccumulator accumulator;

    address writer = vm.addr(0xA11CE);
    address buyerHigh = vm.addr(0xB0B1);
    address buyerCalm = vm.addr(0xB0B2);
    address stranger = vm.addr(0x5747);

    function takerData(address taker, bool isExactIn, bool isAToB) internal pure returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: taker,
                isExactIn: isExactIn,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                isAToB: isAToB,
                allowPartialFill: false,
                threshold: "",
                to: address(0),
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );
    }

    function test_fork_portfolioLifecycle_realUsdcRealChainlinkHistory() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        vm.chainId(31_337); // enables the explicitly local-only back-dated demo path

        assertGt(AQUA.code.length, 0, "canonical Aqua present on the fork");
        assertEq(IAggregatorV3(FEED).decimals(), 8);

        router = new AquaSwapVMRouter(AQUA, WETH, address(this), "SwapVM", "1");
        market = new TremorPortfolioMarket(address(router), AQUA, FEED, USDC);
        accumulator = VarianceAccumulator(market.ACCUMULATOR());

        deal(USDC, writer, 1_000e6);
        deal(USDC, buyerHigh, 1_000e6);
        deal(USDC, buyerCalm, 1_000e6);

        vm.prank(writer);
        TremorMakerVault vault = TremorMakerVault(market.createVault());

        // ---------------------------------------------------------------- forward group: trading
        TremorPortfolioMarket.GroupParams memory p = TremorPortfolioMarket.GroupParams({
            feed: FEED,
            quoteToken: USDC,
            start: uint40(block.timestamp),
            expiry: uint40(block.timestamp + 5 days),
            saleEnd: uint40(block.timestamp + 5 days),
            sampleInterval: 7200,
            capVariance: 1e18,
            capPayoutPerUnit: S,
            maxUnitsPerSide: 1000e18,
            askHigh: 0.30e6,
            bidHigh: 0.25e6,
            askCalm: 0.75e6,
            bidCalm: 0.70e6
        });

        vm.startPrank(writer);
        IERC20(USDC).approve(address(vault), type(uint256).max);
        vault.deposit(100e6);
        uint256 gid = market.createGroup(address(vault), p);
        vm.stopPrank();

        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);

        // ---- both claims issue through canonical Aqua, moving real forked USDC
        vm.startPrank(buyerHigh);
        IERC20(USDC).approve(address(router), type(uint256).max);
        (uint256 premiumH,,) = router.swap(
            market.orderFor(gid, POB.PMode.ISSUE_HIGH), 100e18, takerData(buyerHigh, false, USDC < v.highReceipt)
        );
        vm.stopPrank();
        vm.startPrank(buyerCalm);
        IERC20(USDC).approve(address(router), type(uint256).max);
        (uint256 premiumC,,) = router.swap(
            market.orderFor(gid, POB.PMode.ISSUE_CALM), 100e18, takerData(buyerCalm, false, USDC < v.calmReceipt)
        );
        vm.stopPrank();
        assertEq(premiumH, 30e6);
        assertEq(premiumC, 75e6);
        v = market.groupView(gid);
        assertEq(v.reserveLocked, 100e6, "100 HIGH + 100 CALM share one $100 reserve on the fork too");
        assertEq(v.standaloneCaps, 200e6);
        assertEq(IERC20(USDC).balanceOf(address(vault)), 205e6);

        // ---- the writer strips premiums; the underfunded buyback reverts on real state
        {
            uint256 freeNow = vault.freeQuote();
            vm.prank(writer);
            vault.withdrawFree(freeNow, writer);
        }
        vm.startPrank(buyerHigh);
        IERC20(v.highReceipt).approve(address(router), type(uint256).max);
        bytes memory exitData = takerData(buyerHigh, true, v.highReceipt < USDC);
        ISwapVM.Order memory exitOrder = market.orderFor(gid, POB.PMode.EXIT_HIGH);
        vm.expectRevert(abi.encodeWithSelector(TremorPortfolioMarket.ExitUnderfunded.selector, gid, 5e6, 0));
        router.swap(exitOrder, 20e18, exitData);
        vm.stopPrank();

        // ---- the writer locks a $5 exit buffer and the same buyback executes
        vm.startPrank(writer);
        vault.deposit(5e6);
        market.allocateExitBuffer(gid, 5e6);
        vm.stopPrank();
        vm.prank(buyerHigh);
        (, uint256 exitOut,) = router.swap(exitOrder, 20e18, exitData);
        assertEq(exitOut, 5e6);
        v = market.groupView(gid);
        assertEq(v.highOutstanding, 80e18);
        assertEq(v.reserveLocked, 100e6, "max(80,100): the buyback released nothing");
        assertEq(v.exitBuffer, 0);

        // ---------------------------------------------------------------- back-dated group: settlement
        // A second group whose 5-day window is already-published real Chainlink history, so finalization
        // and redemption run against genuine rounds. Exits are impossible here by construction (the EXIT
        // leg's Deadline is the past expiry), which is why trading was shown on the forward group above.
        uint40 expiry = uint40(block.timestamp - 1 hours);
        p.start = uint40(expiry - 5 days);
        p.expiry = expiry;
        p.saleEnd = uint40(block.timestamp + 1 hours);
        vm.startPrank(writer);
        vault.deposit(100e6);
        gid = market.createBackdatedDemoGroup(address(vault), p);
        vm.stopPrank();
        v = market.groupView(gid);

        vm.startPrank(buyerHigh);
        router.swap(market.orderFor(gid, POB.PMode.ISSUE_HIGH), 100e18, takerData(buyerHigh, false, USDC < v.highReceipt));
        vm.stopPrank();
        vm.startPrank(buyerCalm);
        router.swap(market.orderFor(gid, POB.PMode.ISSUE_CALM), 100e18, takerData(buyerCalm, false, USDC < v.calmReceipt));
        vm.stopPrank();

        // ---- a stranger walks the real 61-point window in bounded checkpoints and finalizes
        vm.startPrank(stranger);
        uint256 calls;
        while (true) {
            (uint256 stored, uint256 available,) = accumulator.progress(gid);
            if (stored >= available) break;
            accumulator.checkpoint(gid, 32);
            calls += 1;
            require(calls < 64, "checkpoint loop did not converge");
        }
        uint256 finalVariance = accumulator.finalize(gid);
        vm.stopPrank();
        emit log_named_uint("bounded checkpoint calls", calls);
        emit log_named_uint("final realized variance (WAD)", finalVariance);

        v = market.groupView(gid);
        assertTrue(v.finalized);
        assertEq(v.highPpu + v.calmPpu, S, "complementary payouts fixed by ONE real-history finalization");
        emit log_named_uint("HIGH pays per unit (USDC 6dp)", v.highPpu);
        emit log_named_uint("CALM pays per unit (USDC 6dp)", v.calmPpu);

        // ---- both holders redeem through the router without writer cooperation
        uint256 payout;
        if (v.highPpu > 0) {
            vm.startPrank(buyerHigh);
            IERC20(v.highReceipt).approve(address(router), type(uint256).max);
            (, uint256 outH,) = router.swap(
                market.orderFor(gid, POB.PMode.SETTLE_HIGH), 100e18, takerData(buyerHigh, true, v.highReceipt < USDC)
            );
            vm.stopPrank();
            payout += outH;
        } else {
            vm.prank(buyerHigh);
            market.burnWorthless(gid, true, 100e18);
        }
        if (v.calmPpu > 0) {
            vm.startPrank(buyerCalm);
            IERC20(v.calmReceipt).approve(address(router), type(uint256).max);
            (, uint256 outC,) = router.swap(
                market.orderFor(gid, POB.PMode.SETTLE_CALM), 100e18, takerData(buyerCalm, true, v.calmReceipt < USDC)
            );
            vm.stopPrank();
            payout += outC;
        } else {
            vm.prank(buyerCalm);
            market.burnWorthless(gid, false, 100e18);
        }
        assertLe(payout, 100e6, "total real-USDC payout stayed inside the shared reserve");

        v = market.groupView(gid);
        assertEq(v.highOutstanding, 0);
        assertEq(v.calmOutstanding, 0);
        assertEq(v.reserveLocked, 0, "the back-dated group is fully settled");
        // The forward group from the first half is still live: its $100 reserve is all that remains locked.
        assertEq(vault.lockedQuote(), 100e6);
        emit log_named_uint("total payout (USDC 6dp)", payout);
        emit log_named_uint("writer's remaining vault balance", IERC20(USDC).balanceOf(address(vault)));
    }
}
