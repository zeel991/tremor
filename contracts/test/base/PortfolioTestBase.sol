// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {TakerTraitsLib} from "swap-vm/libs/TakerTraits.sol";
import {SwapQuery, SwapRegisters} from "swap-vm/libs/VM.sol";
import {AquaSwapVMRouter} from "swap-vm/routers/AquaSwapVMRouter.sol";

import {TremorMakerVault} from "../../src/TremorMakerVault.sol";
import {VarianceAccumulator} from "../../src/VarianceAccumulator.sol";
import {VarianceReceipt} from "../../src/tokens/VarianceReceipt.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockAggregator} from "../../src/mocks/MockAggregator.sol";
import {PortfolioMath} from "../../src/portfolio/PortfolioMath.sol";
import {PortfolioOrderBuilder as POB} from "../../src/portfolio/PortfolioOrderBuilder.sol";
import {TremorPortfolioMarket} from "../../src/portfolio/TremorPortfolioMarket.sol";

/// @notice Shared fixture for the portfolio (v3) suites: canonical Aqua, the unmodified official
///   `AquaSwapVMRouter` from the pinned submodule, a mock 6-decimal quote token and a mock 8-decimal
///   aggregator on a deterministic path. Reference-model helpers are hand-derived, not calls into
///   `PortfolioMath`, so suites comparing against them compare two implementations.
abstract contract PortfolioTestBase is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant T0 = 1_800_000_000;
    uint128 internal constant S = 1e6; // $1 cap payout per 1e18 units

    Aqua internal aqua;
    MockUSDC internal usdc;
    MockAggregator internal feed;
    AquaSwapVMRouter internal router;
    ISwapVM internal viewRouter;
    TremorPortfolioMarket internal market;
    VarianceAccumulator internal accumulator;

    address internal writer = makeAddr("writer");
    address internal buyer1 = makeAddr("buyer1");
    address internal buyer2 = makeAddr("buyer2");

    TremorMakerVault internal vault;
    uint256 internal gid;

    uint256 internal feedLastTs;
    int256 internal feedLastPrice;
    uint256 internal feedNonce;

    function setUp() public virtual {
        vm.warp(T0);
        aqua = new Aqua();
        usdc = new MockUSDC();
        feed = new MockAggregator(8);
        router = new AquaSwapVMRouter(address(aqua), address(0), address(this), "SwapVM", "1");
        viewRouter = router.asView();

        feedLastPrice = 2_400_00000000;
        feedLastTs = T0 - 10 days;
        feed.pushRound(feedLastPrice, feedLastTs);
        pushRoundsUntil(T0);

        market = new TremorPortfolioMarket(address(router), address(aqua), address(feed), address(usdc));
        accumulator = VarianceAccumulator(market.ACCUMULATOR());

        usdc.mint(writer, 10_000_000e6);
        usdc.mint(buyer1, 1_000_000e6);
        usdc.mint(buyer2, 1_000_000e6);
        vm.prank(buyer1);
        usdc.approve(address(router), type(uint256).max);
        vm.prank(buyer2);
        usdc.approve(address(router), type(uint256).max);

        vm.prank(writer);
        vault = TremorMakerVault(market.createVault());
    }

    // ------------------------------------------------------------------ feed helpers

    function pushRoundsUntil(uint256 untilTs) internal {
        while (feedLastTs + 600 <= untilTs) {
            feedLastTs += 600;
            int256 delta = int256(uint256(keccak256(abi.encode(feedNonce++))) % 6001) - 3000;
            feedLastPrice = feedLastPrice * (1_000_000 + delta) / 1_000_000;
            feed.pushRound(feedLastPrice, feedLastTs);
        }
    }

    function warpWithFeed(uint256 toTs) internal {
        pushRoundsUntil(toTs);
        vm.warp(toTs);
    }

    // ------------------------------------------------------------------ fixture helpers

    function defaultParams() internal view returns (TremorPortfolioMarket.GroupParams memory p) {
        p = TremorPortfolioMarket.GroupParams({
            feed: address(feed),
            quoteToken: address(usdc),
            start: uint40(block.timestamp),
            expiry: uint40(block.timestamp + 7 days),
            saleEnd: uint40(block.timestamp + 7 days),
            sampleInterval: 7200,
            capVariance: 1e18, // 100% vol
            capPayoutPerUnit: S,
            maxUnitsPerSide: 1000e18,
            askHigh: 0.3e6,
            bidHigh: 0.25e6,
            askCalm: 0.75e6,
            bidCalm: 0.7e6
        });
    }

    function fundVault(uint256 amount) internal {
        vm.startPrank(writer);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function openGroup(uint256 vaultFunding) internal {
        if (vaultFunding > 0) fundVault(vaultFunding);
        vm.prank(writer);
        gid = market.createGroup(address(vault), defaultParams());
    }

    function takerData(address taker, bool isExactIn, bool isAToB, bool allowPartial)
        internal
        pure
        returns (bytes memory)
    {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: taker,
                isExactIn: isExactIn,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                isAToB: isAToB,
                allowPartialFill: allowPartial,
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

    function legDirection(POB.PMode mode) internal view returns (bool isAToB) {
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        address receipt = POB.isHigh(mode) ? v.highReceipt : v.calmReceipt;
        return POB.isIssue(mode) ? address(usdc) < receipt : receipt < address(usdc);
    }

    function buy(address buyer, bool high, uint256 units, bool allowPartial) internal returns (uint256 premium) {
        POB.PMode mode = high ? POB.PMode.ISSUE_HIGH : POB.PMode.ISSUE_CALM;
        ISwapVM.Order memory o = market.orderFor(gid, mode);
        bytes memory d = takerData(buyer, false, legDirection(mode), allowPartial);
        vm.prank(buyer);
        (premium,,) = router.swap(o, units, d);
    }

    function exitSwap(address holder, bool high, uint256 units) internal returns (uint256 quoteOut) {
        POB.PMode mode = high ? POB.PMode.EXIT_HIGH : POB.PMode.EXIT_CALM;
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        ISwapVM.Order memory o = market.orderFor(gid, mode);
        bytes memory d = takerData(holder, true, legDirection(mode), false);
        vm.startPrank(holder);
        VarianceReceipt(high ? v.highReceipt : v.calmReceipt).approve(address(router), type(uint256).max);
        (, quoteOut,) = router.swap(o, units, d);
        vm.stopPrank();
    }

    function redeemSwap(address holder, bool high, uint256 units) internal returns (uint256 quoteOut) {
        POB.PMode mode = high ? POB.PMode.SETTLE_HIGH : POB.PMode.SETTLE_CALM;
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        ISwapVM.Order memory o = market.orderFor(gid, mode);
        bytes memory d = takerData(holder, true, legDirection(mode), false);
        vm.startPrank(holder);
        VarianceReceipt(high ? v.highReceipt : v.calmReceipt).approve(address(router), type(uint256).max);
        (, quoteOut,) = router.swap(o, units, d);
        vm.stopPrank();
    }

    function finalizeGroup() internal returns (uint256 finalVariance) {
        while (true) {
            (uint256 stored, uint256 available,) = accumulator.progress(gid);
            if (stored >= available) break;
            accumulator.checkpoint(gid, accumulator.MAX_SAMPLES_PER_CALL());
        }
        return accumulator.finalize(gid);
    }

    // ------------------------------------------------------------------ independent reference model

    /// @dev Hand-derived, not a call into PortfolioMath.
    function _refReserve(uint256 h, uint256 c) internal pure returns (uint256) {
        uint256 m = h > c ? h : c;
        return (m * S + WAD - 1) / WAD;
    }

    /// @dev Worst-case aggregate payout scanned over a dense grid of outcomes plus both endpoints.
    function _refWorstPayout(uint256 h, uint256 c) internal pure returns (uint256 worst) {
        for (uint256 i = 0; i <= 100; i++) {
            uint256 x = i * WAD / 100;
            uint256 hp = uint256(S) * x / WAD;
            uint256 cp = S - hp;
            uint256 total = h * hp / WAD + c * cp / WAD;
            if (total > worst) worst = total;
        }
    }
}
