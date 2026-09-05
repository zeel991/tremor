// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {ITakerCallbacks} from "swap-vm/interfaces/ITakerCallbacks.sol";
import {TakerTraitsLib} from "swap-vm/libs/TakerTraits.sol";
import {AquaSwapVMRouter} from "swap-vm/routers/AquaSwapVMRouter.sol";

import {TremorMakerVault} from "../src/TremorMakerVault.sol";
import {VarianceReceipt} from "../src/tokens/VarianceReceipt.sol";
import {PortfolioOrderBuilder as POB} from "../src/portfolio/PortfolioOrderBuilder.sol";
import {TremorPortfolioMarket} from "../src/portfolio/TremorPortfolioMarket.sol";
import {PortfolioTestBase} from "./base/PortfolioTestBase.sol";

/// @notice A taker contract that can run ONE queued nested call from inside a SwapVM taker callback —
///   the actual interleaving surface the router exposes — plus arbitrary owner-driven calls so it can act
///   as a writer (create vaults/groups, withdraw free collateral) mid-swap.
contract ReentrantTaker is ITakerCallbacks {
    address public immutable OWNER;

    address internal _nestedTarget;
    bytes internal _nestedData;
    bool internal _fired;

    constructor() {
        OWNER = msg.sender;
    }

    /// @notice Arbitrary call as this contract (owner-only test harness surface).
    function exec(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == OWNER, "not owner");
        (bool ok, bytes memory ret) = target.call(data);
        _bubble(ok, ret);
        return ret;
    }

    /// @notice Queue one call to run inside the next taker callback this contract receives.
    function queue(address target, bytes calldata data) external {
        require(msg.sender == OWNER, "not owner");
        _nestedTarget = target;
        _nestedData = data;
        _fired = false;
    }

    function preTransferInCallback(address, address, address, address, uint256, uint256, bytes32, bytes calldata)
        external
    {
        _runQueued();
    }

    function preTransferOutCallback(address, address, address, address, uint256, uint256, bytes32, bytes calldata)
        external
    {
        _runQueued();
    }

    function _runQueued() internal {
        if (_fired || _nestedTarget == address(0)) return;
        _fired = true;
        (bool ok, bytes memory ret) = _nestedTarget.call(_nestedData);
        _bubble(ok, ret);
    }

    function _bubble(bool ok, bytes memory ret) private pure {
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}

/// @notice Buffer authorization and callback-interleaving behavior, demonstrated by execution rather than
///   inspection: every nested action here really runs inside a router taker callback, in both supported
///   transfer orders, against the unmodified official router.
contract PortfolioAdversarialTest is PortfolioTestBase {
    ReentrantTaker internal taker;
    address internal attacker = makeAddr("attacker");
    address internal funder = makeAddr("funder");

    function setUp() public override {
        super.setUp();
        taker = new ReentrantTaker();
        usdc.mint(address(taker), 1_000_000e6);
        usdc.mint(funder, 1_000e6);
        taker.exec(address(usdc), abi.encodeCall(IERC20.approve, (address(router), type(uint256).max)));
    }

    // ------------------------------------------------------------------ taker-data with callbacks

    function takerDataCb(bool isExactIn, bool isAToB, bool preIn, bool preOut, bool takerFirst)
        internal
        view
        returns (bytes memory)
    {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: address(taker),
                isExactIn: isExactIn,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: takerFirst,
                useTransferFromAndAquaPush: true,
                isAToB: isAToB,
                allowPartialFill: false,
                threshold: "",
                to: address(0),
                deadline: 0,
                hasPreTransferInCallback: preIn,
                hasPreTransferOutCallback: preOut,
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

    /// @dev router.swap calldata for a nested exit by the taker contract, WITHOUT callbacks of its own.
    function nestedExitCall(uint256 groupId, bool high, uint256 units) internal view returns (bytes memory) {
        POB.PMode mode = high ? POB.PMode.EXIT_HIGH : POB.PMode.EXIT_CALM;
        TremorPortfolioMarket.GroupView memory v = market.groupView(groupId);
        address receipt = high ? v.highReceipt : v.calmReceipt;
        bytes memory d = takerData(address(taker), true, receipt < address(usdc), false);
        return abi.encodeCall(ISwapVM.swap, (market.orderFor(groupId, mode), units, d));
    }

    function nestedBuyCall(uint256 groupId, bool high, uint256 units) internal view returns (bytes memory) {
        POB.PMode mode = high ? POB.PMode.ISSUE_HIGH : POB.PMode.ISSUE_CALM;
        TremorPortfolioMarket.GroupView memory v = market.groupView(groupId);
        address receipt = high ? v.highReceipt : v.calmReceipt;
        bytes memory d = takerData(address(taker), false, address(usdc) < receipt, false);
        return abi.encodeCall(ISwapVM.swap, (market.orderFor(groupId, mode), units, d));
    }

    function approveReceipts(uint256 groupId) internal {
        TremorPortfolioMarket.GroupView memory v = market.groupView(groupId);
        taker.exec(v.highReceipt, abi.encodeCall(IERC20.approve, (address(router), type(uint256).max)));
        taker.exec(v.calmReceipt, abi.encodeCall(IERC20.approve, (address(router), type(uint256).max)));
    }

    /// @dev Outer exit initiated BY the taker contract, with a callback armed in the phase that fires FIRST
    ///   for the chosen transfer order, so the nested call runs before the outer fill's burn hook and
    ///   payment settle. Approvals must already be in place (`approveReceipts`), so an `expectRevert` set
    ///   by the caller applies to exactly this router call.
    function outerExitCall(uint256 groupId, bool high, uint256 units, bool takerFirst)
        internal
        view
        returns (bytes memory)
    {
        POB.PMode mode = high ? POB.PMode.EXIT_HIGH : POB.PMode.EXIT_CALM;
        TremorPortfolioMarket.GroupView memory v = market.groupView(groupId);
        address receipt = high ? v.highReceipt : v.calmReceipt;
        bytes memory d = takerDataCb(true, receipt < address(usdc), takerFirst, !takerFirst, takerFirst);
        return abi.encodeCall(ISwapVM.swap, (market.orderFor(groupId, mode), units, d));
    }

    function outerExit(uint256 groupId, bool high, uint256 units, bool takerFirst) internal {
        taker.exec(address(router), outerExitCall(groupId, high, units, takerFirst));
    }

    // ------------------------------------------------------------------ shared fixture

    /// @dev 100 HIGH + 100 CALM outstanding, taker holds 20 HIGH and 20 CALM, premiums stripped, buffer $5.
    function balancedBookWithBuffer() internal {
        openGroup(100e6);
        buy(buyer1, true, 100e18, false);
        buy(buyer2, false, 100e18, false);
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        vm.prank(buyer1);
        VarianceReceipt(v.highReceipt).transfer(address(taker), 20e18);
        vm.prank(buyer2);
        VarianceReceipt(v.calmReceipt).transfer(address(taker), 20e18);
        uint256 freeNow = vault.freeQuote();
        vm.prank(writer);
        vault.withdrawFree(freeNow, writer);
        fundVault(5e6);
        vm.prank(writer);
        market.allocateExitBuffer(gid, 5e6);
        approveReceipts(gid);
    }

    // ------------------------------------------------------------------ 1. buffer authorization

    function test_allocateExitBufferIsWriterOnly() public {
        openGroup(100e6);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(TremorPortfolioMarket.NotWriter.selector, writer, attacker));
        market.allocateExitBuffer(gid, 50e6);
        // The writer's free collateral is untouched and fully withdrawable.
        assertEq(vault.freeQuote(), 100e6);
        vm.prank(writer);
        vault.withdrawFree(100e6, writer);
    }

    function test_strangerCannotEnableAnOtherwiseUnfundedBuyback() public {
        openGroup(100e6);
        buy(buyer1, true, 100e18, false);
        buy(buyer2, false, 100e18, false);
        // The vault has free premiums, but no buffer: an attacker cannot allocate them.
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(TremorPortfolioMarket.NotWriter.selector, writer, attacker));
        market.allocateExitBuffer(gid, 5e6);

        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        ISwapVM.Order memory o = market.orderFor(gid, POB.PMode.EXIT_HIGH);
        bytes memory d = takerData(buyer1, true, legDirection(POB.PMode.EXIT_HIGH), false);
        vm.startPrank(buyer1);
        VarianceReceipt(v.highReceipt).approve(address(router), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(TremorPortfolioMarket.ExitUnderfunded.selector, gid, 5e6, 0));
        router.swap(o, 20e18, d);
        vm.stopPrank();
    }

    function test_thirdPartyFundingSpendsTheFundersOwnTokens() public {
        openGroup(100e6);
        buy(buyer1, true, 100e18, false);
        buy(buyer2, false, 100e18, false);
        uint256 writerFreeBefore = vault.freeQuote();

        vm.startPrank(funder);
        usdc.approve(address(market), 5e6);
        market.fundExitBuffer(gid, 5e6);
        vm.stopPrank();

        assertEq(usdc.balanceOf(funder), 1_000e6 - 5e6, "the funder paid");
        assertEq(vault.freeQuote(), writerFreeBefore, "the writer's free collateral is untouched");
        assertEq(market.groupView(gid).exitBuffer, 5e6);

        // And the funded buffer makes the buyback executable.
        uint256 got = exitSwap(buyer1, true, 20e18);
        assertEq(got, 5e6);
    }

    function test_fundExitBufferWithoutTokensReverts() public {
        openGroup(100e6);
        vm.prank(attacker);
        vm.expectRevert(); // SafeERC20 transferFrom failure: no balance, no approval
        market.fundExitBuffer(gid, 5e6);
        assertEq(market.groupView(gid).exitBuffer, 0);
        // Repeated attempts cannot interfere with the writer's withdrawals.
        vm.prank(writer);
        vault.withdrawFree(100e6, writer);
    }

    // ------------------------------------------------------------------ 2. nested exits, same group

    /// @notice A nested fill that would over-draw the shared buffer reverts INSIDE the callback and takes
    ///   the whole transaction — outer fill included — down with it, in both supported transfer orders.
    ///   (A nested exit that stays within the buffer cannot strand the outer one: bids are capped at S, so
    ///   shrinking the other side below the outer burn's remaining units releases at least the reserve the
    ///   outer payout needs — see the invariant fuzz below.)
    function test_nestedOverdrawFailsClosed_makerPaysFirst() public {
        _nestedOverdrawFailsClosed(false);
    }

    function test_nestedOverdrawFailsClosed_takerPaysFirst() public {
        _nestedOverdrawFailsClosed(true);
    }

    function _nestedOverdrawFailsClosed(bool takerFirst) internal {
        balancedBookWithBuffer();
        uint256 takerUsdc = usdc.balanceOf(address(taker));

        // Nested: exit 10 CALM at $0.70 = $7.00 against zero release + $5 buffer -> reverts underfunded.
        taker.queue(address(router), nestedExitCall(gid, false, 10e18));
        bytes memory outerCall = outerExitCall(gid, true, 20e18, takerFirst);
        vm.expectRevert(abi.encodeWithSelector(TremorPortfolioMarket.ExitUnderfunded.selector, gid, 7e6, 5e6));
        taker.exec(address(router), outerCall);

        // Full rollback of BOTH fills.
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        assertEq(v.highOutstanding, 100e18);
        assertEq(v.calmOutstanding, 100e18);
        assertEq(v.exitBuffer, 5e6);
        assertEq(v.reserveLocked, 100e6);
        assertEq(vault.lockedQuote(), 105e6);
        assertEq(vault.quoteBalance(), 105e6);
        assertEq(usdc.balanceOf(address(taker)), takerUsdc);
        assertEq(VarianceReceipt(v.highReceipt).balanceOf(address(taker)), 20e18);
        assertEq(VarianceReceipt(v.calmReceipt).balanceOf(address(taker)), 20e18);
    }

    /// @notice When the buffer genuinely covers both fills, the same interleaving completes and the vault
    ///   ends exactly solvent.
    function test_nestedCrossSideExit_withinBuffer_succeedsAndSelfBalances() public {
        balancedBookWithBuffer(); // buffer $5

        // Nested: exit 5 CALM = $3.50, all buffer-funded (no release: max(100,95) == 100).
        // Outer: exit 20 HIGH = $5.00; by burn time the CALM side sits at 95, so the burn releases
        // 100 - max(80,95) = $5 of reserve and needs NO buffer at all.
        taker.queue(address(router), nestedExitCall(gid, false, 5e18));
        outerExit(gid, true, 20e18, false);

        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        assertEq(v.highOutstanding, 80e18);
        assertEq(v.calmOutstanding, 95e18);
        assertEq(v.exitBuffer, 1.5e6, "$3.50 of the $5 buffer spent by the nested fill");
        assertEq(v.reserveLocked, 95e6);
        assertEq(vault.lockedQuote(), 95e6 + 1.5e6);
        assertGe(vault.quoteBalance(), vault.lockedQuote());
    }

    /// @notice Sweep nested CALM exit sizes inside an outer HIGH exit: every interleaving either reverts
    ///   whole or ends with the vault solvent and the ledger sum exact. This is the executed evidence that
    ///   the buffer + live-release accounting cannot be double-spent by callback interleaving.
    function testFuzz_interleavedExitsNeverBreakSolvency(uint8 nestedRaw) public {
        uint256 nestedUnits = (uint256(nestedRaw) % 40) * 1e18 + 1e18; // 1..40 CALM
        balancedBookWithBuffer();

        taker.queue(address(router), nestedExitCall(gid, false, nestedUnits));
        bytes memory outerCall = outerExitCall(gid, true, 20e18, false);
        (bool ok,) = address(taker).call(abi.encodeCall(ReentrantTaker.exec, (address(router), outerCall)));

        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        if (!ok) {
            // fail-closed: complete rollback
            assertEq(v.highOutstanding, 100e18);
            assertEq(v.calmOutstanding, 100e18);
            assertEq(v.exitBuffer, 5e6);
        }
        assertEq(vault.lockedQuote(), v.reserveLocked + v.exitBuffer);
        assertGe(vault.quoteBalance(), vault.lockedQuote());
        assertGe(v.reserveLocked, _refWorstPayout(v.highOutstanding, v.calmOutstanding));
    }

    // ------------------------------------------------------------------ 3. nested exits across groups

    function test_nestedExitAcrossGroupsSharingAVault() public {
        balancedBookWithBuffer();
        uint256 gidA = gid;

        // Second group on the SAME vault, its own book and its own $5 buffer.
        fundVault(100e6);
        vm.prank(writer);
        uint256 gidB = market.createGroup(address(vault), defaultParams());
        gid = gidB;
        buy(buyer1, true, 100e18, false);
        buy(buyer2, false, 100e18, false);
        TremorPortfolioMarket.GroupView memory vb = market.groupView(gidB);
        vm.prank(buyer1);
        VarianceReceipt(vb.highReceipt).transfer(address(taker), 20e18);
        approveReceipts(gidB);
        fundVault(5e6);
        vm.prank(writer);
        market.allocateExitBuffer(gidB, 5e6);

        // Outer exit in group A, nested exit in group B: per-group buffers cannot cross-fund each other,
        // and both fills complete against their own.
        taker.queue(address(router), nestedExitCall(gidB, true, 20e18));
        outerExit(gidA, true, 20e18, false);

        TremorPortfolioMarket.GroupView memory va = market.groupView(gidA);
        vb = market.groupView(gidB);
        assertEq(va.highOutstanding, 80e18);
        assertEq(vb.highOutstanding, 80e18);
        assertEq(va.exitBuffer, 0);
        assertEq(vb.exitBuffer, 0);
        assertEq(vault.lockedQuote(), va.reserveLocked + vb.reserveLocked, "vault lock == sum of group ledgers");
        assertGe(vault.quoteBalance(), vault.lockedQuote());
    }

    // ------------------------------------------------------------------ 4. issuance inside an exit

    function test_nestedIssueDuringExit_invariantHolds() public {
        balancedBookWithBuffer();
        fundVault(50e6); // free collateral for the nested purchase to reserve against

        // Nested: buy 40 more HIGH (reserve grows to max(140,100) = $140), inside the outer exit of 20 HIGH.
        taker.queue(address(router), nestedBuyCall(gid, true, 40e18));
        outerExit(gid, true, 20e18, false);

        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        assertEq(v.highOutstanding, 120e18, "100 + 40 bought - 20 exited");
        assertEq(v.calmOutstanding, 100e18);
        assertEq(v.reserveLocked, 120e6, "max(140 - 20, 100)");
        // The nested purchase grew the reserve to $140 BEFORE the outer burn settled, so exiting 20 HIGH
        // released $20 of real reserve and the buffer was never touched.
        assertEq(v.exitBuffer, 5e6);
        assertEq(vault.lockedQuote(), 125e6);
        assertGe(vault.quoteBalance(), vault.lockedQuote());
    }

    // ------------------------------------------------------------------ 5. writer acting mid-swap

    /// @notice The taker contract IS the writer of its own group, buys its own claims (self-trading), and
    ///   withdraws every free cent from inside its exit's callback. The exit still settles from the locked
    ///   buffer, and the vault ends solvent: free withdrawal and holder backing never overlap.
    function test_writerWithdrawsFreeDuringOwnExitCallback() public {
        // taker becomes a writer with its own vault and group.
        bytes memory ret = taker.exec(address(market), abi.encodeCall(TremorPortfolioMarket.createVault, ()));
        TremorMakerVault tVault = TremorMakerVault(abi.decode(ret, (address)));
        taker.exec(address(usdc), abi.encodeCall(IERC20.approve, (address(tVault), type(uint256).max)));
        taker.exec(address(tVault), abi.encodeCall(TremorMakerVault.deposit, (200e6)));
        ret = taker.exec(
            address(market), abi.encodeCall(TremorPortfolioMarket.createGroup, (address(tVault), defaultParams()))
        );
        uint256 g = abi.decode(ret, (uint256));

        // Self-trade: the writer buys 100 of its own HIGH and 100 CALM through the router.
        gid = g;
        TremorPortfolioMarket.GroupView memory v = market.groupView(g);
        taker.exec(
            address(router),
            abi.encodeCall(
                ISwapVM.swap,
                (
                    market.orderFor(g, POB.PMode.ISSUE_HIGH),
                    100e18,
                    takerData(address(taker), false, address(usdc) < v.highReceipt, false)
                )
            )
        );
        taker.exec(
            address(router),
            abi.encodeCall(
                ISwapVM.swap,
                (
                    market.orderFor(g, POB.PMode.ISSUE_CALM),
                    100e18,
                    takerData(address(taker), false, address(usdc) < v.calmReceipt, false)
                )
            )
        );
        taker.exec(address(market), abi.encodeCall(TremorPortfolioMarket.allocateExitBuffer, (g, 5e6)));

        // Mid-exit, the writer strips ALL free collateral.
        uint256 freeNow = tVault.freeQuote();
        approveReceipts(g);
        taker.queue(address(tVault), abi.encodeCall(TremorMakerVault.withdrawFree, (freeNow, address(taker))));
        outerExit(g, true, 20e18, false);

        v = market.groupView(g);
        assertEq(v.highOutstanding, 80e18);
        assertEq(v.exitBuffer, 0);
        assertEq(v.reserveLocked, 100e6, "max(80,100) unchanged");
        assertEq(tVault.lockedQuote(), 100e6);
        assertGe(tVault.quoteBalance(), tVault.lockedQuote(), "holder backing survived the writer's raid");
        // Self-trading was a round trip, not a withdrawal: writer paid premiums in, got the bid back out.
    }

    // ------------------------------------------------------------------ 6. same-order reentry

    function test_sameOrderReentryBlockedByRouterLock() public {
        balancedBookWithBuffer();
        taker.queue(address(router), nestedExitCall(gid, true, 5e18)); // the SAME EXIT_HIGH order
        bytes memory outerCall = outerExitCall(gid, true, 10e18, false);
        vm.expectRevert(); // router transient lock: UnexpectedLock
        taker.exec(address(router), outerCall);
        // rollback
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        assertEq(v.highOutstanding, 100e18);
        assertEq(v.exitBuffer, 5e6);
    }

    // ------------------------------------------------------------------ 7. dust

    function test_dustExitPaysNothingAndReverts() public {
        balancedBookWithBuffer();
        TremorPortfolioMarket.GroupView memory v = market.groupView(gid);
        ISwapVM.Order memory o = market.orderFor(gid, POB.PMode.EXIT_HIGH);
        bytes memory d = takerData(buyer1, true, legDirection(POB.PMode.EXIT_HIGH), false);
        vm.startPrank(buyer1);
        VarianceReceipt(v.highReceipt).approve(address(router), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(TremorPortfolioMarket.NothingToFill.selector, gid, POB.PMode.EXIT_HIGH));
        router.swap(o, 3, d); // 3 wei of units floors to zero proceeds
        vm.stopPrank();
    }
}
