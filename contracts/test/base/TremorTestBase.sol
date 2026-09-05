// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {TakerTraitsLib} from "swap-vm/libs/TakerTraits.sol";
import {AquaSwapVMRouter} from "swap-vm/routers/AquaSwapVMRouter.sol";

import {SeriesParams, Leg} from "../../src/libs/SeriesParams.sol";
import {VariancePricing} from "../../src/libs/VariancePricing.sol";
import {VarianceSeriesFactory} from "../../src/VarianceSeriesFactory.sol";
import {TremorMarketEngine} from "../../src/TremorMarketEngine.sol";
import {VarianceAccumulator} from "../../src/VarianceAccumulator.sol";
import {TremorLens} from "../../src/TremorLens.sol";
import {TremorPrograms} from "../../src/TremorPrograms.sol";
import {TremorMakerVault} from "../../src/TremorMakerVault.sol";
import {RealizedVarianceOracle} from "../../src/RealizedVarianceOracle.sol";
import {VarianceReceipt} from "../../src/tokens/VarianceReceipt.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockAggregator} from "../../src/mocks/MockAggregator.sol";

/// @notice Shared fixture for the local Tremor suites: canonical Aqua, the unmodified official
///   `AquaSwapVMRouter` from the pinned `lib/swap-vm` submodule, a mock 6-decimal quote token and a mock
///   8-decimal aggregator fed a deterministic price path.
///
///   The router is the official one on purpose. Tremor v2 ships only stock SwapVM programs, and
///   `test/RouterCompat.t.sol` is the gate that established the deployed canonical address cannot be
///   driven through the pinned ABI; every other suite therefore runs against the pinned official source
///   rather than a Tremor-specific router.
contract TremorTestBase is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant T0 = 1_800_000_000; // all vector windows end before this

    Aqua internal aqua;
    MockUSDC internal usdc;
    MockAggregator internal feed;
    AquaSwapVMRouter internal router;
    ISwapVM internal viewRouter;
    VarianceSeriesFactory internal factory;
    TremorMarketEngine internal engine;
    VarianceAccumulator internal accumulator;
    TremorLens internal lens;
    TremorPrograms internal programs;
    RealizedVarianceOracle internal oracle;

    address internal writer = makeAddr("writer");
    address internal buyer1 = makeAddr("buyer1");
    address internal buyer2 = makeAddr("buyer2");

    // deterministic feed path state
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

        feedLastPrice = 2_400_00000000; // $2400
        feedLastTs = T0 - 10 days;
        feed.pushRound(feedLastPrice, feedLastTs);
        pushRoundsUntil(T0);

        factory = new VarianceSeriesFactory(address(router), address(aqua), address(feed), address(usdc));
        engine = TremorMarketEngine(factory.ENGINE());
        accumulator = VarianceAccumulator(factory.ACCUMULATOR());
        lens = new TremorLens(factory);
        programs = new TremorPrograms(factory);
        oracle = new RealizedVarianceOracle(address(feed), 3600);

        usdc.mint(writer, 10_000_000e6);
        usdc.mint(buyer1, 1_000_000e6);
        usdc.mint(buyer2, 1_000_000e6);
        vm.prank(buyer1);
        usdc.approve(address(router), type(uint256).max);
        vm.prank(buyer2);
        usdc.approve(address(router), type(uint256).max);

        vm.label(address(aqua), "aqua");
        vm.label(address(router), "router");
        vm.label(address(usdc), "usdc");
        vm.label(address(feed), "feed");
        vm.label(address(factory), "factory");
        vm.label(address(engine), "engine");
        vm.label(address(accumulator), "accumulator");
    }

    // ------------------------------------------------------------------ feed helpers

    /// @dev Push ~10-minute rounds with a deterministic +-0.3% pseudo-random walk up to `untilTs`.
    function pushRoundsUntil(uint256 untilTs) internal {
        while (feedLastTs + 600 <= untilTs) {
            feedLastTs += 600;
            int256 delta = int256(uint256(keccak256(abi.encode(feedNonce++))) % 6001) - 3000; // ppm
            feedLastPrice = feedLastPrice * (1_000_000 + delta) / 1_000_000;
            feed.pushRound(feedLastPrice, feedLastTs);
        }
    }

    /// @dev Move time forward and keep the mock feed publishing across the gap.
    function warpWithFeed(uint256 toTs) internal {
        pushRoundsUntil(toTs);
        vm.warp(toTs);
    }

    // ------------------------------------------------------------------ series helpers

    function forwardParams() internal view returns (SeriesParams memory p) {
        p = SeriesParams({
            feed: address(feed),
            quoteToken: address(usdc),
            start: uint40(block.timestamp),
            expiry: uint40(block.timestamp + 7 days),
            saleEnd: uint40(block.timestamp + 7 days),
            sampleInterval: 7200,
            unitNotional: 100e6, // 100 USDC per unit per 1.0 variance
            capVariance: 1e18, // 100% vol
            anchorVariance: 0.25e18, // 50% vol
            impactPerUnit: 0.01e18,
            halfLife: 6 hours,
            halfSpreadBps: 200,
            maxUnits: 100e18
        });
    }

    /// @dev start = expiry - 5d, expiry = now - 1h, saleEnd = now + 1h (finalizable immediately).
    function backdatedParams() internal view returns (SeriesParams memory p) {
        p = forwardParams();
        p.expiry = uint40(block.timestamp - 1 hours);
        p.start = uint40(p.expiry - 5 days);
        p.saleEnd = uint40(block.timestamp + 1 hours);
    }

    /// @notice Collateral a series' maximum position would require.
    function maxLiabilityOf(SeriesParams memory p) internal pure returns (uint256) {
        return VariancePricing.maxLiability(p.maxUnits, p.unitNotional, p.capVariance);
    }

    function createVault(address owner) internal returns (TremorMakerVault vault) {
        vm.prank(owner);
        vault = TremorMakerVault(factory.createVault());
    }

    function fundVault(TremorMakerVault vault, address payer, uint256 amount) internal {
        vm.startPrank(payer);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    /// @notice The default fixture: writer's vault funded with the series' full maximum liability.
    function writerVaultFor(SeriesParams memory p) internal returns (TremorMakerVault vault) {
        vault = createVault(writer);
        fundVault(vault, writer, maxLiabilityOf(p));
    }

    function createSeries(TremorMakerVault vault, SeriesParams memory p)
        internal
        returns (uint256 id, VarianceReceipt receipt)
    {
        vm.prank(writer);
        (uint256 id_, address r) = p.expiry < block.timestamp
            ? factory.createBackdatedDemoSeries(address(vault), p)
            : factory.createSeries(address(vault), p);
        return (id_, VarianceReceipt(r));
    }

    /// @notice Vault + funding + series + all three shipped strategies, the state every leg test starts in.
    function openMarket(SeriesParams memory p)
        internal
        returns (uint256 id, VarianceReceipt receipt, TremorMakerVault vault)
    {
        vault = writerVaultFor(p);
        (id, receipt) = createSeries(vault, p);
    }

    function openMarket() internal returns (uint256 id, VarianceReceipt receipt, TremorMakerVault vault) {
        return openMarket(forwardParams());
    }

    // ------------------------------------------------------------------ orders and taker data

    function issueOrder(uint256 id) internal view returns (ISwapVM.Order memory o) {
        (o,,) = programs.orders(id);
    }

    function exitOrder(uint256 id) internal view returns (ISwapVM.Order memory o) {
        (, o,) = programs.orders(id);
    }

    function settlementOrder(uint256 id) internal view returns (ISwapVM.Order memory o) {
        (,, o) = programs.orders(id);
    }

    function orderFor(uint256 id, Leg leg) internal view returns (ISwapVM.Order memory o) {
        (ISwapVM.Order memory i, ISwapVM.Order memory e, ISwapVM.Order memory s) = programs.orders(id);
        if (leg == Leg.ISSUE) return i;
        if (leg == Leg.EXIT) return e;
        return s;
    }

    /// @dev Whole-or-nothing taker data, which is what a UI sends when it does not expect a clamp.
    function takerData(address taker, bool isExactIn, uint256 id, Leg leg) internal view returns (bytes memory) {
        return lens.buildTakerData(taker, isExactIn, lens.legDirection(id, leg), 0, 0, false);
    }

    /// @dev Partial-fill taker data, which is what makes the engine's clamps reachable.
    function takerDataPartial(address taker, bool isExactIn, uint256 id, Leg leg) internal view returns (bytes memory) {
        return lens.buildTakerData(taker, isExactIn, lens.legDirection(id, leg), 0, 0, true);
    }

    // ------------------------------------------------------------------ quotes

    function quoteLeg(address taker, uint256 id, Leg leg, bool isExactIn, uint256 amount)
        internal
        returns (uint256 amountIn, uint256 amountOut)
    {
        ISwapVM.Order memory o = orderFor(id, leg);
        bytes memory d = takerDataPartial(taker, isExactIn, id, leg);
        vm.prank(taker);
        (amountIn, amountOut,) = viewRouter.quote(o, amount, d);
    }

    // ------------------------------------------------------------------ actions

    function buyUnits(address buyer, uint256 id, uint256 units) internal returns (uint256 quotePaid) {
        ISwapVM.Order memory o = issueOrder(id);
        bytes memory d = takerData(buyer, false, id, Leg.ISSUE);
        vm.prank(buyer);
        (quotePaid,,) = router.swap(o, units, d);
    }

    function buyExactIn(address buyer, uint256 id, uint256 quoteIn) internal returns (uint256 units) {
        ISwapVM.Order memory o = issueOrder(id);
        bytes memory d = takerData(buyer, true, id, Leg.ISSUE);
        vm.prank(buyer);
        (, units,) = router.swap(o, quoteIn, d);
    }

    function exitUnits(address holder, uint256 id, uint256 units) internal returns (uint256 quoteOut) {
        (,, address receipt,,,,) = factory.series(id);
        ISwapVM.Order memory o = exitOrder(id);
        bytes memory d = takerData(holder, true, id, Leg.EXIT);
        vm.startPrank(holder);
        VarianceReceipt(receipt).approve(address(router), type(uint256).max);
        (, quoteOut,) = router.swap(o, units, d);
        vm.stopPrank();
    }

    function redeemUnits(address holder, uint256 id, uint256 units) internal returns (uint256 quoteOut) {
        (,, address receipt,,,,) = factory.series(id);
        ISwapVM.Order memory o = settlementOrder(id);
        bytes memory d = takerData(holder, true, id, Leg.SETTLE);
        vm.startPrank(holder);
        VarianceReceipt(receipt).approve(address(router), type(uint256).max);
        (, quoteOut,) = router.swap(o, units, d);
        vm.stopPrank();
    }

    /// @notice Drive the permissionless accumulator to the head of the window in bounded calls.
    /// @return calls how many bounded checkpoints it took
    function checkpointAll(uint256 id, uint16 perCall) internal returns (uint256 calls) {
        while (true) {
            (uint256 stored, uint256 available,) = accumulator.progress(id);
            if (stored >= available) return calls;
            accumulator.checkpoint(id, perCall);
            calls += 1;
            require(calls < 512, "checkpoint loop did not converge");
        }
    }

    /// @notice Checkpoint the whole window and finalize, as any unprivileged account could.
    function finalizeSeries(uint256 id) internal returns (uint256 finalVariance) {
        checkpointAll(id, accumulator.MAX_SAMPLES_PER_CALL());
        return accumulator.finalize(id);
    }

    // ------------------------------------------------------------------ revert helpers

    /// @dev prank + expectRevert(selector data, or empty for any) + swap.
    function expectSwapRevert(address who, ISwapVM.Order memory o, uint256 amount, bytes memory d, bytes memory err)
        internal
    {
        vm.prank(who);
        if (err.length == 0) vm.expectRevert();
        else vm.expectRevert(err);
        router.swap(o, amount, d);
    }

    function expectQuoteRevert(address who, ISwapVM.Order memory o, uint256 amount, bytes memory d, bytes memory err)
        internal
    {
        vm.prank(who);
        if (err.length == 0) vm.expectRevert();
        else vm.expectRevert(err);
        viewRouter.quote(o, amount, d);
    }

    // ------------------------------------------------------------------ independent math mirrors

    /// @dev Re-derived by hand rather than by calling `VariancePricing`, so a suite comparing against it is
    ///   comparing two implementations instead of one implementation with itself.
    function expectedIssuePremium(uint256 askVariance, uint256 slope, uint256 unitNotional, uint256 units)
        internal
        pure
        returns (uint256)
    {
        uint256 integral = askVariance * units + (slope * units * units + 2 * WAD - 1) / (2 * WAD);
        return (unitNotional * integral + 1e36 - 1) / 1e36;
    }

    function expectedExitProceeds(uint256 bidVariance, uint256 slope, uint256 unitNotional, uint256 units)
        internal
        pure
        returns (uint256)
    {
        uint256 integral = bidVariance * units - (slope * units * units) / (2 * WAD);
        return (unitNotional * integral) / 1e36;
    }

    function expectedMaxLiability(uint256 units, uint256 unitNotional, uint256 capVariance)
        internal
        pure
        returns (uint256)
    {
        uint256 numerator = units * unitNotional * capVariance;
        return (numerator + 1e36 - 1) / 1e36;
    }
}
