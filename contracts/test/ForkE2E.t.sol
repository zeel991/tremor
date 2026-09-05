// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {AquaSwapVMRouter} from "swap-vm/routers/AquaSwapVMRouter.sol";

import {SeriesParams, Leg} from "../src/libs/SeriesParams.sol";
import {VariancePricing} from "../src/libs/VariancePricing.sol";
import {VarianceSeriesFactory} from "../src/VarianceSeriesFactory.sol";
import {VarianceAccumulator} from "../src/VarianceAccumulator.sol";
import {TremorMarketEngine} from "../src/TremorMarketEngine.sol";
import {TremorLens} from "../src/TremorLens.sol";
import {TremorPrograms} from "../src/TremorPrograms.sol";
import {TremorMakerVault} from "../src/TremorMakerVault.sol";
import {VarianceReceipt} from "../src/tokens/VarianceReceipt.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";

/// @notice The full Tremor v2 lifecycle on a Base-mainnet fork against canonical Aqua, the unmodified
///   official `AquaSwapVMRouter` from the pinned submodule, real Circle USDC and the real Chainlink
///   ETH/USD proxy.
///
///   Two series, because they demonstrate different things:
///     - a forward series proves issuance, an executable pre-expiry exit, and that the three writer attack
///       paths fail on chain rather than in the UI;
///     - a back-dated, chain-31337-only series proves the oracle path end to end, finalizing from real
///       Chainlink round history walked in bounded permissionless checkpoints, then redeeming.
///
/// @dev BASE_RPC_URL=https://mainnet.base.org forge test --match-contract ForkE2E -vv
contract ForkE2ETest is Test {
    address constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant FEED = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;

    uint256 constant WAD = 1e18;

    AquaSwapVMRouter router;
    VarianceSeriesFactory factory;
    VarianceAccumulator accumulator;
    TremorMarketEngine engine;
    TremorLens lens;
    TremorPrograms programs;

    address writer = vm.addr(0xA11CE);
    address buyer = vm.addr(0xB0B);
    address stranger = vm.addr(0x5747);

    function _deployStack() internal {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        vm.chainId(31_337); // enables the explicitly local-only back-dated demo path

        assertGt(AQUA.code.length, 0, "canonical Aqua present on the fork");
        assertEq(IAggregatorV3(FEED).decimals(), 8);
        emit log_named_uint("chainlink feed phase", IAggregatorV3(FEED).phaseId());

        router = new AquaSwapVMRouter(AQUA, WETH, address(this), "SwapVM", "1");
        factory = new VarianceSeriesFactory(address(router), AQUA, FEED, USDC);
        accumulator = VarianceAccumulator(factory.ACCUMULATOR());
        engine = TremorMarketEngine(factory.ENGINE());
        lens = new TremorLens(factory);
        programs = new TremorPrograms(factory);

        emit log_named_address("router", address(router));
        emit log_named_address("factory", address(factory));
        emit log_named_address("engine", address(engine));
        emit log_named_address("accumulator", address(accumulator));
        emit log_named_address("lens", address(lens));
    }

    // ------------------------------------------------------------------ forward series

    function test_fork_forwardSeries_issueExitAndFailedWriterAttacks() public {
        _deployStack();

        deal(USDC, writer, 200_000e6);
        deal(USDC, buyer, 100_000e6);

        vm.prank(writer);
        TremorMakerVault vault = TremorMakerVault(factory.createVault());
        assertEq(address(vault), factory.predictVault(writer), "vault address is deterministic on chain too");

        SeriesParams memory p = SeriesParams({
            feed: FEED,
            quoteToken: USDC,
            start: uint40(block.timestamp),
            expiry: uint40(block.timestamp + 7 days),
            saleEnd: uint40(block.timestamp + 7 days),
            sampleInterval: 7200,
            unitNotional: 100e6,
            capVariance: 1e18,
            anchorVariance: 0.2e18,
            impactPerUnit: 0.01e18,
            halfLife: 6 hours,
            halfSpreadBps: 200,
            maxUnits: 100e18
        });
        uint256 liability = VariancePricing.maxLiability(p.maxUnits, p.unitNotional, p.capVariance);

        vm.startPrank(writer);
        IERC20(USDC).approve(address(vault), liability);
        vault.deposit(liability);
        (uint256 id, address receipt) = factory.createSeries(address(vault), p);
        vm.stopPrank();
        assertEq(IERC20(USDC).balanceOf(address(vault)), liability, "real forked USDC is in the vault");
        assertEq(vault.lockedQuote(), 0, "nothing reserved before a sale");

        // ---- issuance moves real USDC and real receipts through Aqua
        uint256 vaultBefore = IERC20(USDC).balanceOf(address(vault));
        uint256 buyerBefore = IERC20(USDC).balanceOf(buyer);
        vm.startPrank(buyer);
        IERC20(USDC).approve(address(router), type(uint256).max);
        (uint256 premium, uint256 unitsOut,) =
            router.swap(_order(id, Leg.ISSUE), 20e18, lens.buildTakerData(buyer, false, USDC < receipt, 0, 0, false));
        vm.stopPrank();
        assertEq(unitsOut, 20e18);
        assertEq(IERC20(receipt).balanceOf(buyer), 20e18);
        assertEq(IERC20(USDC).balanceOf(buyer), buyerBefore - premium);
        assertEq(IERC20(USDC).balanceOf(address(vault)), vaultBefore + premium);
        assertEq(vault.lockedQuote(), VariancePricing.maxLiability(20e18, p.unitNotional, p.capVariance));
        emit log_named_uint("premium for 20 units (USDC 6dp)", premium);

        // ---- the three writer attacks, on chain
        uint256 free = vault.freeQuote();
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(TremorMakerVault.ExceedsFree.selector, free + 1, free));
        vault.withdrawFree(free + 1, writer);

        assertEq(vault.aquaAllowance(), type(uint256).max);
        vm.prank(writer);
        IERC20(USDC).approve(AQUA, 0); // the writer's own allowance is not the vault's
        assertEq(vault.aquaAllowance(), type(uint256).max, "the vault's Aqua allowance is unrevokable");

        (,,,, bytes32 exitHash, bytes32 settleHash,) = factory.series(id);
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = USDC < receipt ? (USDC, receipt) : (receipt, USDC);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(TremorMakerVault.NotController.selector, writer));
        vault.dockStrategy(exitHash, tokens);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(TremorMakerVault.NotController.selector, writer));
        vault.dockStrategy(settleHash, tokens);
        vm.prank(writer);
        vm.expectRevert(); // Aqua keys strategies by msg.sender, so the writer's own space is empty
        IAqua(AQUA).dock(address(router), settleHash, tokens);

        // ---- executable pre-expiry exit
        vm.warp(block.timestamp + 2 days);
        uint256 gasBefore = gasleft();
        uint256 checkpointCalls = _checkpointAll(id, 32);
        emit log_named_uint("checkpoint gas, forward window", gasBefore - gasleft());
        emit log_named_uint("checkpoint calls, forward window", checkpointCalls);

        (uint256 quotedUnits, uint256 quotedOut) = lens.quoteExitExactIn(id, 8e18);
        assertEq(quotedUnits, 8e18);
        uint256 buyerUsdcBeforeExit = IERC20(USDC).balanceOf(buyer);
        vm.startPrank(buyer);
        IERC20(receipt).approve(address(router), type(uint256).max);
        gasBefore = gasleft();
        (uint256 unitsIn, uint256 quoteOut,) =
            router.swap(_order(id, Leg.EXIT), 8e18, lens.buildTakerData(buyer, true, receipt < USDC, 0, 0, false));
        emit log_named_uint("exit gas", gasBefore - gasleft());
        vm.stopPrank();

        assertEq(unitsIn, 8e18);
        assertEq(quoteOut, quotedOut, "the Lens bid was executable at exactly that price");
        assertEq(IERC20(USDC).balanceOf(buyer), buyerUsdcBeforeExit + quoteOut);
        assertEq(IERC20(receipt).balanceOf(buyer), 12e18);
        assertEq(IERC20(receipt).totalSupply(), uint256(p.maxUnits) - 8e18, "exited receipts burned");
        assertEq(vault.lockedQuote(), VariancePricing.maxLiability(12e18, p.unitNotional, p.capVariance));
        assertGe(IERC20(USDC).balanceOf(address(vault)), vault.lockedQuote(), "vault still solvent");
        emit log_named_uint("exit proceeds for 8 units (USDC 6dp)", quoteOut);
    }

    // ------------------------------------------------------------------ back-dated series: the oracle path

    function test_fork_backdatedSeries_finalizesFromRealChainlinkHistory() public {
        _deployStack();

        deal(USDC, writer, 200_000e6);
        deal(USDC, buyer, 100_000e6);

        vm.prank(writer);
        TremorMakerVault vault = TremorMakerVault(factory.createVault());

        uint40 expiry = uint40(block.timestamp - 1 hours);
        SeriesParams memory p = SeriesParams({
            feed: FEED,
            quoteToken: USDC,
            start: uint40(expiry - 5 days),
            expiry: expiry,
            saleEnd: uint40(block.timestamp + 1 hours),
            sampleInterval: 7200,
            unitNotional: 100e6,
            capVariance: 1e18,
            anchorVariance: 0.2e18,
            impactPerUnit: 0.01e18,
            halfLife: 6 hours,
            halfSpreadBps: 200,
            maxUnits: 50e18
        });
        uint256 liability = VariancePricing.maxLiability(p.maxUnits, p.unitNotional, p.capVariance);

        vm.startPrank(writer);
        IERC20(USDC).approve(address(vault), liability);
        vault.deposit(liability);
        (uint256 id, address receipt) = factory.createBackdatedDemoSeries(address(vault), p);
        vm.stopPrank();

        // ---- walk five days of real Chainlink history in bounded, permissionless calls
        (, uint256 available, uint256 total) = accumulator.progress(id);
        assertEq(total, uint256(5 days) / p.sampleInterval + 1);
        assertEq(available, total, "the whole window is already in the past");

        uint256 calls;
        uint256 gasUsed;
        while (true) {
            (uint256 stored, uint256 avail,) = accumulator.progress(id);
            if (stored >= avail) break;
            uint256 gasBefore = gasleft();
            vm.prank(stranger); // no privileges whatsoever
            accumulator.checkpoint(id, 8);
            gasUsed += gasBefore - gasleft();
            calls += 1;
            require(calls < 200, "checkpointing did not converge");
        }
        emit log_named_uint("bounded checkpoint calls, 5 days of real history", calls);
        emit log_named_uint("total checkpoint gas", gasUsed);
        emit log_named_uint("gas per bounded call (8 samples)", gasUsed / calls);

        // Real round ids, and a phase boundary if the window crossed one.
        VarianceAccumulator.Accumulator memory acc = accumulator.accumulator(id);
        emit log_named_uint("last chainlink round id", acc.lastRoundId);
        emit log_named_uint("last chainlink phase", acc.lastRoundId >> 64);
        assertGt(acc.lastRoundId, 0);
        assertEq(acc.processedThrough, p.expiry);

        // ---- buy while the sale is still open, then finalize
        vm.startPrank(buyer);
        IERC20(USDC).approve(address(router), type(uint256).max);
        (uint256 premium,,) =
            router.swap(_order(id, Leg.ISSUE), 10e18, lens.buildTakerData(buyer, false, USDC < receipt, 0, 0, false));
        vm.stopPrank();
        assertEq(IERC20(receipt).balanceOf(buyer), 10e18);
        uint256 cappedLock = vault.lockedQuote();

        uint256 gasBefore2 = gasleft();
        vm.prank(stranger);
        uint256 finalVariance = accumulator.finalize(id);
        emit log_named_uint("finalize gas", gasBefore2 - gasleft());

        // The accumulator's bounded walk must agree exactly with a one-shot computation over the window.
        (uint256 oneShot,) = lens.realizedVariance(FEED, p.start, p.expiry, p.sampleInterval);
        assertEq(finalVariance, oneShot, "bounded checkpoints diverged from a direct computation");
        emit log_named_uint("final realized variance (WAD)", finalVariance);
        emit log_named_uint("annualized vol, percent x 1e18", lens.volatilityPct(finalVariance));

        uint256 ppu = factory.seriesView(id).payoutPerUnit;
        assertEq(ppu, VariancePricing.payoutPerUnit(finalVariance, p.capVariance, p.unitNotional));
        emit log_named_uint("payout per unit (USDC 6dp)", ppu);
        assertLe(vault.lockedQuote(), cappedLock, "cap surplus released at finalization");
        emit log_named_uint("collateral released at finalization", cappedLock - vault.lockedQuote());

        // ---- redeem, with the Lens quote and the swap agreeing to the base unit
        (uint256 qUnits, uint256 qOut) = lens.quoteSettleExactIn(id, 10e18);
        assertEq(qUnits, 10e18);
        uint256 buyerBefore = IERC20(USDC).balanceOf(buyer);
        uint256 vaultBefore = IERC20(USDC).balanceOf(address(vault));
        uint256 supplyBefore = IERC20(receipt).totalSupply();

        vm.startPrank(buyer);
        IERC20(receipt).approve(address(router), type(uint256).max);
        uint256 gasBefore3 = gasleft();
        (uint256 unitsIn, uint256 quoteOut,) =
            router.swap(_order(id, Leg.SETTLE), 10e18, lens.buildTakerData(buyer, true, receipt < USDC, 0, 0, false));
        emit log_named_uint("settlement gas after finalization", gasBefore3 - gasleft());
        vm.stopPrank();

        assertEq(unitsIn, 10e18);
        assertEq(quoteOut, qOut, "Lens redemption quote equals the swap");
        assertEq(quoteOut, 10e18 * ppu / WAD);
        assertEq(IERC20(USDC).balanceOf(buyer), buyerBefore + quoteOut);
        assertEq(IERC20(USDC).balanceOf(address(vault)), vaultBefore - quoteOut);
        assertEq(IERC20(receipt).totalSupply(), supplyBefore - 10e18, "redeemed receipts burned");
        assertEq(IERC20(receipt).balanceOf(buyer), 0);
        assertEq(factory.seriesView(id).outstandingUnits, 0);
        assertEq(vault.lockedQuote(), 0, "only the matching liability was released, and all of it");
        assertGe(IERC20(USDC).balanceOf(address(vault)), vault.lockedQuote());

        // ---- close, and the writer finally gets everything that is left
        vm.prank(writer);
        factory.stopIssuance(id);
        factory.closeSeries(id);
        assertEq(IERC20(receipt).totalSupply(), 0, "unsold inventory burned at close");

        uint256 leftover = IERC20(USDC).balanceOf(address(vault));
        vm.prank(writer);
        vault.withdrawFree(leftover, writer);
        assertEq(IERC20(USDC).balanceOf(address(vault)), 0);
        emit log_named_uint("writer P&L on the series (USDC 6dp, premium minus payout)", premium);
    }

    // ------------------------------------------------------------------ helpers

    function _order(uint256 id, Leg leg) internal view returns (ISwapVM.Order memory) {
        (ISwapVM.Order memory i, ISwapVM.Order memory e, ISwapVM.Order memory s) = programs.orders(id);
        if (leg == Leg.ISSUE) return i;
        if (leg == Leg.EXIT) return e;
        return s;
    }

    function _checkpointAll(uint256 id, uint16 perCall) internal returns (uint256 calls) {
        while (true) {
            (uint256 stored, uint256 available,) = accumulator.progress(id);
            if (stored >= available) return calls;
            vm.prank(stranger);
            accumulator.checkpoint(id, perCall);
            calls += 1;
            require(calls < 200, "checkpointing did not converge");
        }
    }
}
