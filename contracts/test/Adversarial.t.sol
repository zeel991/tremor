// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {IMakerHooks} from "swap-vm/interfaces/IMakerHooks.sol";
import {MakerTraitsLib} from "swap-vm/libs/MakerTraits.sol";
import {Salt} from "swap-vm/instructions/Controls.sol";
import {Extruction} from "swap-vm/instructions/Extruction.sol";
import {SwapQuery, SwapRegisters} from "swap-vm/libs/VM.sol";

import {TremorTestBase} from "./base/TremorTestBase.sol";
import {SeriesParams, Leg} from "../src/libs/SeriesParams.sol";
import {VariancePricing} from "../src/libs/VariancePricing.sol";
import {TremorMakerVault} from "../src/TremorMakerVault.sol";
import {TremorMarketEngine} from "../src/TremorMarketEngine.sol";
import {VarianceSeriesFactory} from "../src/VarianceSeriesFactory.sol";
import {VarianceReceipt} from "../src/tokens/VarianceReceipt.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @dev A counterfeit receipt that tries to release liability by calling the controller directly with a
///   real series' burn-leg order hash.
contract FakeReceipt {
    function attack(address controller, bytes32 orderHash, address holder, uint256 units, uint256 amountOut) external {
        VarianceSeriesFactory(controller).onBurn(orderHash, holder, units, amountOut);
    }
}

/// @notice Every writer rug path from Section 2 of the implementation plan, plus forged orders, hook
///   replays, cross-series confusion and reserve overdraw.
///
///   The v1 trust boundary was explicit: "a seller can drain or revoke collateral after selling receipts,
///   so outstanding receipts remain unsecured claims." These tests are what replaced that sentence.
contract AdversarialTest is TremorTestBase {
    function _sold(uint256 units)
        internal
        returns (uint256 id, VarianceReceipt receipt, TremorMakerVault vault, SeriesParams memory p)
    {
        p = forwardParams();
        (id, receipt, vault) = openMarket(p);
        buyUnits(buyer1, id, units);
    }

    // ------------------------------------------------------------------ the writer

    function test_writerCannotWithdrawLockedCollateral() public {
        (,, TremorMakerVault vault,) = _sold(20e18);
        uint256 locked = vault.lockedQuote();
        uint256 free = vault.freeQuote();
        assertGt(locked, 0);

        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(TremorMakerVault.ExceedsFree.selector, free + 1, free));
        vault.withdrawFree(free + 1, writer);

        // Even after taking every free dollar, the reservation is untouched.
        vm.prank(writer);
        vault.withdrawFree(free, writer);
        assertEq(vault.quoteBalance(), locked);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(TremorMakerVault.ExceedsFree.selector, 1, 0));
        vault.withdrawFree(1, writer);
    }

    function test_writerCannotRevokeTheAquaAllowance() public {
        (,, TremorMakerVault vault,) = _sold(20e18);
        assertEq(vault.aquaAllowance(), type(uint256).max);

        // Nor by calling the token directly: the allowance belongs to the vault, not to the writer.
        vm.prank(writer);
        usdc.approve(address(aqua), 0);
        assertEq(vault.aquaAllowance(), type(uint256).max, "a writer's own approval is irrelevant");
    }

    function test_writerCannotDockTheBurnLegs() public {
        (uint256 id, VarianceReceipt receipt, TremorMakerVault vault,) = _sold(20e18);
        (,,,, bytes32 exitHash, bytes32 settleHash,) = factory.series(id);
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) =
            address(usdc) < address(receipt) ? (address(usdc), address(receipt)) : (address(receipt), address(usdc));

        // Directly, as the writer: Aqua keys strategies by msg.sender, so this touches nothing.
        vm.prank(writer);
        vm.expectRevert();
        aqua.dock(address(router), exitHash, tokens);

        // Through the vault: docking is controller-only.
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(TremorMakerVault.NotController.selector, writer));
        vault.dockStrategy(exitHash, tokens);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(TremorMakerVault.NotController.selector, writer));
        vault.dockStrategy(settleHash, tokens);

        // And the controller refuses to close a series that still owes anybody anything.
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.ClaimsOutstanding.selector, 20e18));
        factory.closeSeries(id);

        assertTrue(lens.state(id).legs.exitLegActive);
        assertTrue(lens.state(id).legs.settleLegActive);
    }

    function test_writerCannotStopHoldersByStoppingIssuance() public {
        (uint256 id,, TremorMakerVault vault, SeriesParams memory p) = _sold(20e18);
        vm.prank(writer);
        factory.stopIssuance(id);

        warpWithFeed(block.timestamp + 1 days);
        checkpointAll(id, 32);
        assertGt(exitUnits(buyer1, id, 5e18), 0, "exit survives stopped issuance");

        warpWithFeed(uint256(p.expiry) + 1);
        finalizeSeries(id);
        assertGt(redeemUnits(buyer1, id, 15e18), 0, "settlement survives stopped issuance");
        assertEq(vault.lockedQuote(), 0);
    }

    function test_writerCannotMakeTheVaultDoAnythingElse() public {
        (, VarianceReceipt receipt, TremorMakerVault vault,) = _sold(20e18);
        bytes[] memory attempts = new bytes[](7);
        attempts[0] = abi.encodeWithSignature("execute(address,bytes)", address(usdc), "");
        attempts[1] = abi.encodeWithSignature("delegatecall(address,bytes)", address(usdc), "");
        attempts[2] = abi.encodeWithSignature("rescueFunds(address,uint256)", address(receipt), 1);
        attempts[3] = abi.encodeWithSignature("rescue(address,uint256)", address(usdc), 1);
        attempts[4] = abi.encodeWithSignature("setOwner(address)", buyer1);
        attempts[5] = abi.encodeWithSignature("pause()");
        attempts[6] = abi.encodeWithSignature("selfdestruct()");
        for (uint256 i = 0; i < attempts.length; i++) {
            vm.prank(writer);
            (bool ok,) = address(vault).call(attempts[i]);
            assertFalse(ok, "the vault answered an unexpected call");
        }
    }

    function test_writerCannotSellTheirOwnUnsoldInventory() public {
        SeriesParams memory p = forwardParams();
        (uint256 id, VarianceReceipt receipt, TremorMakerVault vault) = openMarket(p);
        // The inventory is in the vault, the writer holds none, and the vault will not move it.
        assertEq(receipt.balanceOf(writer), 0);
        vm.prank(writer);
        vm.expectRevert();
        receipt.transferFrom(address(vault), writer, 1e18);
        assertEq(receipt.balanceOf(address(vault)), p.maxUnits);
        id;
    }

    // ------------------------------------------------------------------ forged orders and hooks

    function test_forgedOrderWithCheaperTerms_isUnknownToTheRegistry() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,, TremorMakerVault vault) = openMarket(p);

        // Rebuild the ISSUE order claiming a different series id in the engine arguments. Both the Aqua
        // strategy hash and the registry lookup change, so it prices nothing.
        ISwapVM.Order memory real = issueOrder(id);
        (,, address receipt,,,,) = factory.series(id);
        bytes memory program = bytes.concat(
            Salt.build(abi.encodePacked(uint64(id), uint8(Leg.ISSUE))),
            Extruction.build(address(engine), abi.encodePacked(uint8(1), uint8(Leg.ISSUE), uint64(999)))
        );
        ISwapVM.Order memory forged = _order(address(vault), address(usdc), receipt, program, address(0));
        assertTrue(keccak256(abi.encode(forged)) != keccak256(abi.encode(real)));

        bytes memory d = lens.buildTakerData(buyer1, true, address(usdc) < receipt, 0, 0, false);
        // Aqua has no such strategy, so the router cannot even read balances for it.
        vm.prank(buyer1);
        vm.expectRevert();
        router.swap(forged, 100e6, d);
    }

    function test_fakeReceiptCannotReleaseLiability() public {
        (uint256 id,,,) = _sold(20e18);
        (,,,, bytes32 exitHash,,) = factory.series(id);
        FakeReceipt fake = new FakeReceipt();
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.NotSeriesReceipt.selector, address(fake)));
        fake.attack(address(factory), exitHash, buyer1, 1e18, 1);
    }

    function test_genuineReceiptWithAnotherSeriesLegHash_cannotReleaseLiability() public {
        SeriesParams memory p = forwardParams();
        TremorMakerVault vault = createVault(writer);
        fundVault(vault, writer, 2 * maxLiabilityOf(p));
        (uint256 idA, VarianceReceipt receiptA) = createSeries(vault, p);
        SeriesParams memory q = forwardParams();
        q.anchorVariance = 0.3e18;
        (uint256 idB,) = createSeries(vault, q);

        buyUnits(buyer1, idA, 10e18);
        buyUnits(buyer2, idB, 10e18);

        // Series A's receipt presenting series B's EXIT hash: the controller checks that the caller is the
        // receipt of the series the hash belongs to.
        (,,,, bytes32 exitHashB,,) = factory.series(idB);
        vm.prank(address(receiptA));
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.NotSeriesReceipt.selector, address(receiptA)));
        factory.onBurn(exitHashB, buyer1, 1e18, 1);
        idA;
    }

    function test_hookReplayFails() public {
        (uint256 id, VarianceReceipt receipt,, SeriesParams memory p) = _sold(20e18);
        warpWithFeed(block.timestamp + 1 days);
        checkpointAll(id, 32);
        exitUnits(buyer1, id, 5e18);

        // Calling the hook again, from anywhere but the router, is refused outright.
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(VarianceReceipt.NotRouter.selector, writer));
        receipt.postTransferIn(address(0), buyer1, address(receipt), address(usdc), 5e18, 1, 0, bytes32(0), "", "");
        p;
    }

    function test_hookFromTheRouterButWithNoTokensBurnsNothing() public {
        (uint256 id, VarianceReceipt receipt, TremorMakerVault vault,) = _sold(20e18);
        (,,,, bytes32 exitHash,,) = factory.series(id);
        uint256 supplyBefore = receipt.totalSupply();
        uint256 lockedBefore = vault.lockedQuote();

        // Even impersonating the router, the burn must come out of the vault's own balance, and the
        // controller still bounds the payout by the liability released.
        vm.prank(address(router));
        vm.expectRevert(
            abi.encodeWithSelector(
                VarianceSeriesFactory.PayoutExceedsReleasedLiability.selector,
                type(uint128).max,
                expectedMaxLiability(20e18, forwardParams().unitNotional, forwardParams().capVariance)
                    - expectedMaxLiability(19e18, forwardParams().unitNotional, forwardParams().capVariance)
            )
        );
        receipt.postTransferIn(
            address(vault), buyer1, address(receipt), address(usdc), 1e18, type(uint128).max, 0, exitHash, "", ""
        );
        assertEq(receipt.totalSupply(), supplyBefore);
        assertEq(vault.lockedQuote(), lockedBefore);
    }

    function test_hookRejectsAMakerThatIsNotTheVault() public {
        (uint256 id, VarianceReceipt receipt,,) = _sold(20e18);
        (,,,, bytes32 exitHash,,) = factory.series(id);
        vm.prank(address(router));
        vm.expectRevert(abi.encodeWithSelector(VarianceReceipt.WrongMaker.selector, buyer1));
        receipt.postTransferIn(buyer1, buyer1, address(receipt), address(usdc), 1e18, 1, 0, exitHash, "", "");
    }

    function test_hookRejectsANonZeroReceiptFee() public {
        (uint256 id, VarianceReceipt receipt, TremorMakerVault vault,) = _sold(20e18);
        (,,,, bytes32 exitHash,,) = factory.series(id);
        vm.prank(address(router));
        vm.expectRevert(abi.encodeWithSelector(VarianceReceipt.ReceiptFeeUnsupported.selector, uint256(1)));
        receipt.postTransferIn(address(vault), buyer1, address(receipt), address(usdc), 1e18, 1, 1, exitHash, "", "");
    }

    function test_hookRejectsAForeignTokenIn() public {
        (uint256 id, VarianceReceipt receipt, TremorMakerVault vault,) = _sold(20e18);
        (,,,, bytes32 exitHash,,) = factory.series(id);
        vm.prank(address(router));
        vm.expectRevert(abi.encodeWithSelector(VarianceReceipt.WrongTokenIn.selector, address(usdc)));
        receipt.postTransferIn(address(vault), buyer1, address(usdc), address(usdc), 1e18, 1, 0, exitHash, "", "");
    }

    function test_receiptBurnHelpers_areControllerOnly() public {
        (, VarianceReceipt receipt,,) = _sold(20e18);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(VarianceReceipt.NotController.selector, writer));
        receipt.burnFromHolder(buyer1, 1e18);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(VarianceReceipt.NotController.selector, writer));
        receipt.burnUnsoldInventory(1e18);
    }

    function test_postTransferIn_matchesMakerHooksSelector() public pure {
        assertEq(VarianceReceipt.postTransferIn.selector, IMakerHooks.postTransferIn.selector);
    }

    // ------------------------------------------------------------------ reserve integrity

    function test_overlappingExitAndSettleVirtualBalancesCannotOverdrawTheReserve() public {
        SeriesParams memory p = forwardParams();
        p.expiry = uint40(block.timestamp + 2 days);
        p.saleEnd = p.expiry;
        (uint256 id, VarianceReceipt receipt, TremorMakerVault vault) = openMarket(p);
        buyUnits(buyer1, id, 20e18);
        (,,,, bytes32 exitHash, bytes32 settleHash,) = factory.series(id);

        // Both burn legs are shipped for the full liability: 2x the reserve, in virtual balance.
        (uint248 exitVirtual,) = aqua.rawBalances(address(vault), address(router), exitHash, address(usdc));
        (uint248 settleVirtual,) = aqua.rawBalances(address(vault), address(router), settleHash, address(usdc));
        assertEq(exitVirtual, maxLiabilityOf(p));
        assertEq(settleVirtual, maxLiabilityOf(p));
        assertGt(uint256(exitVirtual) + settleVirtual, vault.quoteBalance(), "virtual allowance exceeds the reserve");

        // Yet a holder can only ever take out what burning their receipts releases. Exit half...
        warpWithFeed(block.timestamp + 1 days);
        checkpointAll(id, 32);
        uint256 exited = exitUnits(buyer1, id, 10e18);

        // ...and settle the other half, and the total never exceeds what was reserved for those 20 units.
        warpWithFeed(uint256(p.expiry) + 1);
        finalizeSeries(id);
        uint256 settled = redeemUnits(buyer1, id, 10e18);

        assertLe(
            exited + settled,
            expectedMaxLiability(20e18, p.unitNotional, p.capVariance),
            "the two legs together drew more than the reservation"
        );
        assertEq(receipt.balanceOf(buyer1), 0);
        assertEq(vault.lockedQuote(), 0);
        assertGe(usdc.balanceOf(address(vault)), 0);
    }

    function test_crossSeriesActivityCannotSpendAnotherSeriesLockedLiability() public {
        SeriesParams memory p = forwardParams();
        p.expiry = uint40(block.timestamp + 2 days);
        p.saleEnd = p.expiry;
        TremorMakerVault vault = createVault(writer);
        // Fund only enough for one series' worth of sales, then sell in both.
        fundVault(vault, writer, expectedMaxLiability(20e18, p.unitNotional, p.capVariance));
        (uint256 idA,) = createSeries(vault, p);
        SeriesParams memory q = p;
        q.anchorVariance = 0.3e18;
        (uint256 idB,) = createSeries(vault, q);

        buyUnits(buyer1, idA, 10e18);
        uint256 lockedA = factory.seriesView(idA).lockedLiability;
        buyUnits(buyer2, idB, 10e18);
        assertEq(vault.lockedQuote(), lockedA + factory.seriesView(idB).lockedLiability);
        assertEq(vault.freeQuote(), usdc.balanceOf(address(vault)) - vault.lockedQuote());

        // Series B is now the binding constraint: nothing further can be sold in A beyond the premiums.
        // Redeeming B must not be able to reach into A's reservation.
        warpWithFeed(uint256(p.expiry) + 1);
        finalizeSeries(idB);
        uint256 out = redeemUnits(buyer2, idB, 10e18);
        assertGe(usdc.balanceOf(address(vault)), vault.lockedQuote(), "A's reservation is still backed");
        assertEq(factory.seriesView(idA).lockedLiability, lockedA, "A's reservation is untouched");
        assertGt(out, 0);
    }

    function test_settlementWithAnotherSeriesReceiptReverts() public {
        SeriesParams memory p = forwardParams();
        p.expiry = uint40(block.timestamp + 2 days);
        p.saleEnd = p.expiry;
        TremorMakerVault vault = createVault(writer);
        fundVault(vault, writer, 2 * maxLiabilityOf(p));
        (uint256 idA, VarianceReceipt receiptA) = createSeries(vault, p);
        SeriesParams memory q = p;
        q.anchorVariance = 0.3e18;
        (uint256 idB,) = createSeries(vault, q);
        buyUnits(buyer1, idA, 10e18);
        buyUnits(buyer1, idB, 10e18);
        warpWithFeed(uint256(p.expiry) + 1);
        finalizeSeries(idA);
        finalizeSeries(idB);

        // Series B's SETTLE order with series A's receipt as tokenIn is simply not a shipped strategy.
        ISwapVM.Order memory oB = settlementOrder(idB);
        bytes memory d = lens.buildTakerData(buyer1, true, address(receiptA) < address(usdc), 0, 0, false);
        vm.startPrank(buyer1);
        receiptA.approve(address(router), type(uint256).max);
        vm.expectRevert();
        router.swap(oB, 1e18, d);
        vm.stopPrank();
    }

    function test_engineCannotBeDrivenDirectly() public {
        (uint256 id,,,) = _sold(20e18);
        (,,, bytes32 issueHash,,,) = factory.series(id);
        // A direct call carries a query the caller controls end to end — including one naming the REAL
        // vault as maker — so the router check, not the maker check, is what stops it.
        (, address vault,,,,,) = factory.series(id);
        SwapQuery memory q = SwapQuery(issueHash, vault, buyer1, address(usdc), address(0), true);
        bytes memory args = abi.encodePacked(uint8(1), uint8(Leg.ISSUE), uint64(id));
        vm.prank(buyer1);
        vm.expectRevert(abi.encodeWithSelector(TremorMarketEngine.NotRouter.selector, buyer1));
        engine.extruction(false, 0, q, SwapRegisters(0, 0, 1e6, 0), args, "");
    }

    function test_engineRejectsALegMismatchOnARealHash() public {
        (uint256 id,,,) = _sold(20e18);
        (, address vault, address receipt, bytes32 issueHash,,,) = factory.series(id);
        // A real ISSUE hash but arguments claiming EXIT.
        SwapQuery memory q = SwapQuery(issueHash, vault, buyer1, receipt, address(usdc), true);
        bytes memory args = abi.encodePacked(uint8(1), uint8(Leg.EXIT), uint64(id));
        vm.prank(address(router));
        vm.expectRevert(abi.encodeWithSelector(TremorMarketEngine.OrderNotRegistered.selector, issueHash, id, Leg.EXIT));
        engine.extruction(false, 0, q, SwapRegisters(0, 0, 1e18, 0), args, "");
    }

    function test_theStackIsWiredToItself() public view {
        assertEq(engine.CONTROLLER(), address(factory));
        assertEq(engine.ACCUMULATOR(), address(accumulator));
        assertEq(accumulator.CONTROLLER(), address(factory));
        assertEq(accumulator.FEED(), address(feed));
        assertEq(factory.ENGINE(), address(engine));
        assertEq(factory.ACCUMULATOR(), address(accumulator));
        assertEq(factory.ROUTER(), address(router));
        assertEq(factory.AQUA(), address(aqua));
        assertEq(address(lens.FACTORY()), address(factory));
        assertEq(address(lens.ENGINE()), address(engine));
    }

    // ------------------------------------------------------------------ helpers

    function _order(address maker, address t1, address t2, bytes memory program, address hook)
        internal
        pure
        returns (ISwapVM.Order memory)
    {
        (address tokenA, address tokenB) = t1 < t2 ? (t1, t2) : (t2, t1);
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: maker,
                receiver: address(0),
                tokenA: tokenA,
                tokenB: tokenB,
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: hook != address(0),
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: hook,
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program
            })
        );
    }
}
