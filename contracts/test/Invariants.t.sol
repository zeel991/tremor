// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Aqua} from "@1inch/aqua/src/Aqua.sol";
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
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";

/// @notice A receipt holder the handler can drive, so the fuzzer can move claims between two independent
///   wallets and still exit or redeem from either.
contract InvariantHolder {
    address public immutable OWNER;

    error NotOwner();

    constructor() {
        OWNER = msg.sender;
    }

    function approve(address token, address spender) external {
        if (msg.sender != OWNER) revert NotOwner();
        IERC20(token).approve(spender, type(uint256).max);
    }

    function swap(address router, ISwapVM.Order calldata order, uint256 amount, bytes calldata takerData)
        external
        returns (uint256 amountIn, uint256 amountOut)
    {
        if (msg.sender != OWNER) revert NotOwner();
        (amountIn, amountOut,) = ISwapVM(router).swap(order, amount, takerData);
    }

    function transfer(address token, address to, uint256 amount) external {
        if (msg.sender != OWNER) revert NotOwner();
        IERC20(token).transfer(to, amount);
    }

    function burnWorthless(address factory, uint256 seriesId, uint256 units) external {
        if (msg.sender != OWNER) revert NotOwner();
        VarianceSeriesFactory(factory).burnWorthless(seriesId, units);
    }
}

/// @notice Drives every state transition Tremor has, in whatever order the fuzzer picks, and keeps its own
///   independent tally of units issued, exited, settled and burned so the invariant suite can check the
///   contracts against a second set of books rather than against themselves.
contract TremorHandler is Test {
    struct Tally {
        uint256 issued;
        uint256 exited;
        uint256 settled;
        uint256 worthless;
        uint256 unsoldBurned;
    }

    VarianceSeriesFactory public immutable FACTORY;
    VarianceAccumulator public immutable ACCUMULATOR;
    TremorMarketEngine public immutable ENGINE;
    TremorLens public immutable LENS;
    TremorPrograms public immutable PROGRAMS;
    AquaSwapVMRouter public immutable ROUTER;
    Aqua public immutable AQUA;
    MockUSDC public immutable USDC;
    MockAggregator public immutable FEED;

    address public immutable WRITER;
    TremorMakerVault public vault;
    InvariantHolder public holderA;
    InvariantHolder public holderB;

    uint256[] public seriesIds;
    mapping(uint256 => Tally) public tally;
    mapping(uint256 => bool) public knownSeries;

    /// @dev Counts of actions that actually succeeded, so the suite can prove it is not vacuously green:
    ///   every `try` below is allowed to fail, and a handler whose every action failed would satisfy every
    ///   invariant trivially.
    uint256 public okIssue;
    uint256 public okExit;
    uint256 public okRedeem;
    uint256 public okFinalize;
    uint256 public okClose;
    uint256 public okWithdraw;
    uint256 public okStop;
    uint256 public okBurnWorthless;

    uint256 public feedLastTs;
    int256 public feedLastPrice;
    uint256 public feedNonce;

    uint256 public constant MAX_SERIES = 3;

    constructor(
        VarianceSeriesFactory factory,
        TremorLens lens,
        TremorPrograms programs,
        AquaSwapVMRouter router,
        Aqua aqua_,
        MockUSDC usdc,
        MockAggregator feed,
        address writer,
        uint256 startTs,
        int256 startPrice
    ) {
        FACTORY = factory;
        PROGRAMS = programs;
        ACCUMULATOR = VarianceAccumulator(factory.ACCUMULATOR());
        ENGINE = TremorMarketEngine(factory.ENGINE());
        LENS = lens;
        ROUTER = router;
        AQUA = aqua_;
        USDC = usdc;
        FEED = feed;
        WRITER = writer;
        feedLastTs = startTs;
        feedLastPrice = startPrice;

        holderA = new InvariantHolder();
        holderB = new InvariantHolder();
    }

    function seriesCount() external view returns (uint256) {
        return seriesIds.length;
    }

    function tallyOf(uint256 id) external view returns (Tally memory) {
        return tally[id];
    }

    // ------------------------------------------------------------------ actions

    /// @notice Seeds the vault and one live market so every fuzz run starts from a tradeable state rather
    ///   than spending its first calls getting there. Called once from the suite's `setUp`.
    function init() external {
        deposit(uint96(2_000_000e6));
        createSeries(1);
        require(seriesIds.length == 1, "handler failed to seed a market");
    }

    function deposit(uint96 rawAmount) public {
        uint256 amount = bound(uint256(rawAmount), 100_000e6, 2_000_000e6);
        if (address(vault) == address(0)) {
            vm.prank(WRITER);
            vault = TremorMakerVault(FACTORY.createVault());
        }
        USDC.mint(address(this), amount);
        USDC.approve(address(vault), amount);
        vault.deposit(amount);
    }

    function createSeries(uint256 seed) public {
        if (seriesIds.length >= MAX_SERIES) return;
        if (address(vault) == address(0)) deposit(uint96(2_000_000e6));

        SeriesParams memory p = SeriesParams({
            feed: address(FEED),
            quoteToken: address(USDC),
            start: uint40(block.timestamp),
            expiry: uint40(block.timestamp + bound(seed, 4, 40) * 1 hours),
            saleEnd: uint40(0),
            sampleInterval: 3600,
            unitNotional: uint128(bound(uint256(keccak256(abi.encode(seed, 1))), 1e6, 500e6)),
            capVariance: uint64(bound(uint256(keccak256(abi.encode(seed, 2))), 1e16, 2e18)),
            anchorVariance: 0,
            impactPerUnit: 0,
            halfLife: uint32(bound(uint256(keccak256(abi.encode(seed, 3))), 0, 2) == 0 ? 0 : 6 hours),
            halfSpreadBps: uint16(bound(uint256(keccak256(abi.encode(seed, 4))), 10, 2_000)),
            maxUnits: uint128(bound(uint256(keccak256(abi.encode(seed, 5))), 1e18, 1_000e18))
        });
        p.expiry = uint40(uint256(p.start) + ((uint256(p.expiry) - p.start) / 3600) * 3600);
        if (uint256(p.expiry) - p.start < 2 * 3600) p.expiry = uint40(uint256(p.start) + 2 * 3600);
        p.saleEnd = p.expiry;
        p.anchorVariance = uint64(bound(uint256(keccak256(abi.encode(seed, 6))), 1, p.capVariance));
        p.impactPerUnit = uint64(bound(uint256(keccak256(abi.encode(seed, 7))), 0, p.capVariance));

        vm.prank(WRITER);
        try FACTORY.createSeries(address(vault), p) returns (uint256 id, address receipt) {
            seriesIds.push(id);
            knownSeries[id] = true;
            holderA.approve(receipt, address(ROUTER));
            holderB.approve(receipt, address(ROUTER));
        } catch {}
    }

    function issue(uint256 seed, uint96 rawUnits, bool exactOut) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        _bringCurrent(id);
        InvariantHolder holder = _holder(seed);
        (,, address receipt,,,,) = FACTORY.series(id);
        SeriesParams memory p = FACTORY.seriesParams(id);
        uint256 units = bound(uint256(rawUnits), 1e15, uint256(p.maxUnits));

        USDC.mint(address(holder), 5_000_000e6);
        holder.approve(address(USDC), address(ROUTER));

        ISwapVM.Order memory o = _order(id, Leg.ISSUE);
        bytes memory d = LENS.buildTakerData(address(holder), !exactOut, address(USDC) < receipt, 0, 0, true);
        uint256 amount = exactOut ? units : VariancePricing.issuePremium(1e17, 0, p.unitNotional, units);
        if (amount == 0) return;
        try holder.swap(address(ROUTER), o, amount, d) returns (uint256, uint256 amountOut) {
            tally[id].issued += amountOut;
            okIssue += 1;
        } catch {}
    }

    function exit(uint256 seed, uint96 rawUnits) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        _bringCurrent(id);
        InvariantHolder holder = _holder(seed);
        (,, address receipt,,,,) = FACTORY.series(id);
        uint256 balance = IERC20(receipt).balanceOf(address(holder));
        if (balance == 0) return;
        uint256 units = bound(uint256(rawUnits), 1, balance);

        ISwapVM.Order memory o = _order(id, Leg.EXIT);
        bytes memory d = LENS.buildTakerData(address(holder), true, receipt < address(USDC), 0, 0, true);
        try holder.swap(address(ROUTER), o, units, d) returns (uint256 amountIn, uint256) {
            tally[id].exited += amountIn;
            okExit += 1;
        } catch {}
    }

    function redeem(uint256 seed, uint96 rawUnits) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        InvariantHolder holder = _holder(seed);
        (,, address receipt,,,,) = FACTORY.series(id);
        uint256 balance = IERC20(receipt).balanceOf(address(holder));
        if (balance == 0) return;
        uint256 units = bound(uint256(rawUnits), 1, balance);

        ISwapVM.Order memory o = _order(id, Leg.SETTLE);
        bytes memory d = LENS.buildTakerData(address(holder), true, receipt < address(USDC), 0, 0, true);
        try holder.swap(address(ROUTER), o, units, d) returns (uint256 amountIn, uint256) {
            tally[id].settled += amountIn;
            okRedeem += 1;
        } catch {}
    }

    /// @notice Close a holder's whole position in one call. The bounded `redeem`/`burnWorthless` actions
    ///   above take a fuzzed fraction, which almost never lands on the exact balance; without this the
    ///   fuzzer would essentially never drive a series to zero outstanding, and the close path would go
    ///   unexercised.
    function redeemAll(uint256 seed) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        InvariantHolder holder = _holder(seed);
        (,, address receipt,,,,) = FACTORY.series(id);
        uint256 balance = IERC20(receipt).balanceOf(address(holder));
        if (balance == 0) return;

        ISwapVM.Order memory o = _order(id, Leg.SETTLE);
        bytes memory d = LENS.buildTakerData(address(holder), true, receipt < address(USDC), 0, 0, true);
        try holder.swap(address(ROUTER), o, balance, d) returns (uint256 amountIn, uint256) {
            tally[id].settled += amountIn;
            okRedeem += 1;
        } catch {}

        balance = IERC20(receipt).balanceOf(address(holder));
        if (balance == 0) return;
        try holder.burnWorthless(address(FACTORY), id, balance) {
            tally[id].worthless += balance;
            okBurnWorthless += 1;
        } catch {}
    }

    function transferBetweenHolders(uint256 seed, uint96 rawUnits) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        (,, address receipt,,,,) = FACTORY.series(id);
        InvariantHolder from = _holder(seed);
        InvariantHolder to = from == holderA ? holderB : holderA;
        uint256 balance = IERC20(receipt).balanceOf(address(from));
        if (balance == 0) return;
        from.transfer(receipt, address(to), bound(uint256(rawUnits), 1, balance));
    }

    function checkpoint(uint256 seed, uint16 rawBudget) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        try ACCUMULATOR.checkpoint(id, uint16(bound(uint256(rawBudget), 1, 32))) {} catch {}
    }

    function finalize(uint256 seed) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        _bringCurrent(id);
        try ACCUMULATOR.finalize(id) {
            okFinalize += 1;
        } catch {}
    }

    function burnWorthless(uint256 seed, uint96 rawUnits) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        InvariantHolder holder = _holder(seed);
        (,, address receipt,,,,) = FACTORY.series(id);
        uint256 balance = IERC20(receipt).balanceOf(address(holder));
        if (balance == 0) return;
        uint256 units = bound(uint256(rawUnits), 1, balance);
        try holder.burnWorthless(address(FACTORY), id, units) {
            tally[id].worthless += units;
            okBurnWorthless += 1;
        } catch {}
    }

    function withdrawFree(uint96 rawAmount) public {
        if (address(vault) == address(0)) return;
        uint256 free = vault.freeQuote();
        if (free == 0) return;
        uint256 amount = bound(uint256(rawAmount), 1, free);
        vm.prank(WRITER);
        try vault.withdrawFree(amount, WRITER) {
            okWithdraw += 1;
        } catch {}
    }

    function stopIssuance(uint256 seed) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        vm.prank(WRITER);
        try FACTORY.stopIssuance(id) {
            okStop += 1;
        } catch {}
    }

    function closeSeries(uint256 seed) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        (,, address receipt,,,,) = FACTORY.series(id);
        uint256 unsold = IERC20(receipt).balanceOf(address(vault));
        try FACTORY.closeSeries(id) {
            tally[id].unsoldBurned += unsold;
            okClose += 1;
        } catch {}
    }

    function advanceTime(uint32 rawSeconds) public {
        uint256 delta = bound(uint256(rawSeconds), 1 hours, 1 days);
        _pushRoundsUntil(block.timestamp + delta);
        vm.warp(block.timestamp + delta);
    }

    // ------------------------------------------------------------------ internals

    /// @dev Walk the accumulator to the head of the window in bounded calls, the way a UI or a bot would
    ///   before quoting. Staleness itself is unit-tested in `IssueLeg`/`ExitLeg`; here it would only stop
    ///   the fuzzer from reaching the states these invariants are about.
    function _bringCurrent(uint256 id) internal {
        for (uint256 i = 0; i < 40; i++) {
            (uint256 stored, uint256 available,) = ACCUMULATOR.progress(id);
            if (stored >= available) return;
            try ACCUMULATOR.checkpoint(id, 32) {}
            catch {
                return;
            }
        }
    }

    function _pick(uint256 seed) internal view returns (bool ok, uint256 id) {
        if (seriesIds.length == 0) return (false, 0);
        return (true, seriesIds[seed % seriesIds.length]);
    }

    function _holder(uint256 seed) internal view returns (InvariantHolder) {
        return (seed >> 8) % 2 == 0 ? holderA : holderB;
    }

    function _order(uint256 id, Leg leg) internal view returns (ISwapVM.Order memory o) {
        (ISwapVM.Order memory i, ISwapVM.Order memory e, ISwapVM.Order memory s) = PROGRAMS.orders(id);
        if (leg == Leg.ISSUE) return i;
        if (leg == Leg.EXIT) return e;
        return s;
    }

    function _pushRoundsUntil(uint256 untilTs) internal {
        uint256 pushed;
        while (feedLastTs + 600 <= untilTs && pushed < 500) {
            feedLastTs += 600;
            int256 delta = int256(uint256(keccak256(abi.encode(feedNonce++))) % 6001) - 3000; // ppm
            feedLastPrice = feedLastPrice * (1_000_000 + delta) / 1_000_000;
            FEED.pushRound(feedLastPrice, feedLastTs);
            pushed += 1;
        }
    }
}

/// @notice Stateful invariants. Every assertion below must hold after every successful action in every
///   fuzzed sequence — deposits, series creation, issuance, transfers, exits, checkpoints, finalization,
///   redemption, worthless burns, free withdrawals, issuance stops and closes, interleaved arbitrarily.
///
///   The one that matters most is the first: `vaultBalance >= vaultLocked`. If the fuzzer can ever break
///   it, a holder somewhere has an unpayable claim, which is the exact failure Tremor v2 exists to remove.
contract InvariantsTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant T0 = 1_800_000_000;

    Aqua internal aqua;
    MockUSDC internal usdc;
    MockAggregator internal feed;
    AquaSwapVMRouter internal router;
    VarianceSeriesFactory internal factory;
    VarianceAccumulator internal accumulator;
    TremorMarketEngine internal engine;
    TremorLens internal lens;
    TremorPrograms internal programs;
    TremorHandler internal handler;

    address internal writer = makeAddr("writer");

    function setUp() public {
        vm.warp(T0);
        aqua = new Aqua();
        usdc = new MockUSDC();
        feed = new MockAggregator(8);
        router = new AquaSwapVMRouter(address(aqua), address(0), address(this), "SwapVM", "1");

        int256 price = 2_400_00000000;
        uint256 ts = T0 - 10 days;
        feed.pushRound(price, ts);
        uint256 nonce;
        while (ts + 600 <= T0) {
            ts += 600;
            int256 delta = int256(uint256(keccak256(abi.encode(nonce++))) % 6001) - 3000;
            price = price * (1_000_000 + delta) / 1_000_000;
            feed.pushRound(price, ts);
        }

        factory = new VarianceSeriesFactory(address(router), address(aqua), address(feed), address(usdc));
        accumulator = VarianceAccumulator(factory.ACCUMULATOR());
        engine = TremorMarketEngine(factory.ENGINE());
        lens = new TremorLens(factory);
        programs = new TremorPrograms(factory);

        handler = new TremorHandler(factory, lens, programs, router, aqua, usdc, feed, writer, ts, price);
        handler.init();
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](14);
        selectors[0] = TremorHandler.deposit.selector;
        selectors[1] = TremorHandler.createSeries.selector;
        selectors[2] = TremorHandler.issue.selector;
        selectors[3] = TremorHandler.exit.selector;
        selectors[4] = TremorHandler.redeem.selector;
        selectors[5] = TremorHandler.transferBetweenHolders.selector;
        selectors[6] = TremorHandler.checkpoint.selector;
        selectors[7] = TremorHandler.finalize.selector;
        selectors[8] = TremorHandler.burnWorthless.selector;
        selectors[9] = TremorHandler.withdrawFree.selector;
        selectors[10] = TremorHandler.stopIssuance.selector;
        selectors[11] = TremorHandler.advanceTime.selector;
        selectors[12] = TremorHandler.closeSeries.selector;
        selectors[13] = TremorHandler.redeemAll.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice A vault can never hold less than it has reserved.
    function invariant_vaultIsAlwaysSolvent() public view {
        TremorMakerVault vault = handler.vault();
        if (address(vault) == address(0)) return;
        assertGe(vault.quoteBalance(), vault.lockedQuote(), "vault balance fell below reserved collateral");
    }

    /// @notice The vault's total lock is exactly the sum of its series' locks.
    function invariant_vaultLockIsTheSumOfSeriesLocks() public view {
        TremorMakerVault vault = handler.vault();
        if (address(vault) == address(0)) return;
        uint256 summed;
        uint256 n = handler.seriesCount();
        for (uint256 i = 0; i < n; i++) {
            summed += factory.seriesView(handler.seriesIds(i)).lockedLiability;
        }
        assertEq(vault.lockedQuote(), summed, "vault lock drifted from the sum of series locks");
    }

    /// @notice Outstanding units equal issued minus everything that consumed a unit.
    function invariant_outstandingMatchesTheIndependentTally() public view {
        uint256 n = handler.seriesCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.seriesIds(i);
            TremorHandler.Tally memory t = handler.tallyOf(id);
            assertEq(
                factory.seriesView(id).outstandingUnits,
                t.issued - t.exited - t.settled - t.worthless,
                "outstanding units disagree with the independent tally"
            );
        }
    }

    /// @notice Receipt supply only ever falls, by exactly what was consumed.
    function invariant_receiptSupplyMatchesTheTally() public view {
        uint256 n = handler.seriesCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.seriesIds(i);
            (,, address receipt,,,,) = factory.series(id);
            SeriesParams memory p = factory.seriesParams(id);
            TremorHandler.Tally memory t = handler.tallyOf(id);
            assertEq(
                IERC20(receipt).totalSupply(),
                uint256(p.maxUnits) - t.exited - t.settled - t.worthless - t.unsoldBurned,
                "receipt supply disagrees with the independent tally"
            );
        }
    }

    /// @notice Everything not in the vault is somebody's outstanding claim.
    function invariant_supplyOutsideTheVaultIsOutstanding() public view {
        TremorMakerVault vault = handler.vault();
        if (address(vault) == address(0)) return;
        uint256 n = handler.seriesCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.seriesIds(i);
            (,, address receipt,,,,) = factory.series(id);
            assertEq(
                IERC20(receipt).totalSupply() - IERC20(receipt).balanceOf(address(vault)),
                factory.seriesView(id).outstandingUnits,
                "receipts outside the vault are not accounted as outstanding"
            );
        }
    }

    /// @notice The market always quotes a bid no higher than its ask, and never bids above the cap payout.
    function invariant_bidNeverExceedsAskOrTheMaximumPayout() public view {
        uint256 n = handler.seriesCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.seriesIds(i);
            SeriesParams memory p = factory.seriesParams(id);
            (, uint256 bid, uint256 ask,,) = engine.market(id);
            assertLe(bid, ask, "bid above ask");
            assertLe(
                VariancePricing.perUnitPrice(p.unitNotional, bid),
                VariancePricing.maxPayoutPerUnit(p.unitNotional, p.capVariance),
                "bid per unit above the maximum payout"
            );
        }
    }

    /// @notice Once finalized, the reservation is the final payout's liability, not the cap's.
    function invariant_finalizedLiabilityUsesTheFinalPayout() public view {
        uint256 n = handler.seriesCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.seriesIds(i);
            if (!factory.seriesView(id).finalized) continue;
            if (factory.isClosed(id)) continue;
            assertEq(
                factory.seriesView(id).lockedLiability,
                VariancePricing.finalLiability(
                    factory.seriesView(id).outstandingUnits, factory.seriesView(id).payoutPerUnit
                ),
                "finalized liability is not the final-payout liability"
            );
        }
    }

    /// @notice Before finalization, the reservation is exactly the capped liability of what is outstanding.
    function invariant_liveLiabilityIsTheCappedLiability() public view {
        uint256 n = handler.seriesCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.seriesIds(i);
            if (factory.seriesView(id).finalized || factory.isClosed(id)) continue;
            SeriesParams memory p = factory.seriesParams(id);
            assertEq(
                factory.seriesView(id).lockedLiability,
                VariancePricing.maxLiability(factory.seriesView(id).outstandingUnits, p.unitNotional, p.capVariance),
                "live liability is not the capped liability of the outstanding position"
            );
        }
    }

    /// @notice The vault's Aqua allowance can never have been reduced.
    function invariant_aquaAllowanceStaysMaximal() public view {
        TremorMakerVault vault = handler.vault();
        if (address(vault) == address(0)) return;
        assertEq(vault.aquaAllowance(), type(uint256).max, "the vault's Aqua allowance changed");
    }

    /// @notice Proves the handler can actually reach every state the invariants are about.
    ///
    ///   Every handler action is wrapped in `try`, so a fuzz campaign in which nothing ever succeeded would
    ///   satisfy all of the invariants above while proving nothing. This drives the same handler through a
    ///   scripted sequence and asserts each action really happened, which is the guard against a vacuously
    ///   green suite. It is a plain test rather than an `afterInvariant` hook because requiring a specific
    ///   state in *every* random 500-call sequence would be a constraint on the fuzzer, not on the code.
    function test_handlerCanReachEveryState() public {
        handler.deposit(uint96(2_000_000e6));
        handler.createSeries(9);
        assertGt(handler.seriesCount(), 0, "handler cannot create a series");

        handler.issue(0, uint96(1e18), true);
        handler.issue(1, uint96(1e18), false);
        assertGt(handler.okIssue(), 0, "handler cannot issue");

        handler.transferBetweenHolders(0, uint96(1e17));
        handler.advanceTime(uint32(2 hours));
        handler.checkpoint(0, 32);

        handler.exit(0, uint96(1e17));
        assertGt(handler.okExit(), 0, "handler cannot exit");

        handler.withdrawFree(uint96(1e6));
        assertGt(handler.okWithdraw(), 0, "handler cannot withdraw free collateral");

        // Run the window out, finalize, and close the remaining positions.
        for (uint256 i = 0; i < 60; i++) {
            handler.advanceTime(uint32(1 days));
        }
        handler.finalize(0);
        assertGt(handler.okFinalize(), 0, "handler cannot finalize");

        // Both holders may be sitting on claims, and only the finalized series can be redeemed.
        uint256[4] memory seeds = [uint256(0), 1, 256, 257];
        for (uint256 i = 0; i < seeds.length; i++) {
            handler.finalize(seeds[i]);
            handler.redeem(seeds[i], uint96(1e17));
            handler.burnWorthless(seeds[i], uint96(1e17));
            handler.redeemAll(seeds[i]);
        }
        assertGt(handler.okRedeem() + handler.okBurnWorthless(), 0, "handler cannot close out a finalized position");

        handler.stopIssuance(0);
        assertGt(handler.okStop(), 0, "handler cannot stop issuance");

        assertEq(factory.seriesView(handler.seriesIds(0)).outstandingUnits, 0, "claims remain outstanding");
        handler.closeSeries(0);
        assertGt(handler.okClose(), 0, "handler cannot close a series");
    }
}
