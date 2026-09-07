// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "swap-vm/libs/MakerTraits.sol";
import {TakerTraitsLib} from "swap-vm/libs/TakerTraits.sol";
import {IMakerHooks} from "swap-vm/interfaces/IMakerHooks.sol";
import {Salt} from "swap-vm/instructions/Controls.sol";
import {Extruction} from "swap-vm/instructions/Extruction.sol";
import {AquaSwapVMRouter} from "swap-vm/routers/AquaSwapVMRouter.sol";

import {MockERC20} from "../src/mocks/MockERC20.sol";
import {ExtructionEcho} from "../src/mocks/ExtructionEcho.sol";
import {HookProbe} from "../src/mocks/HookProbe.sol";

/// @notice Section 8 router compatibility gate. Tremor v2 prices and settles through the built-in SwapVM
///   `Extruction` instruction (opcode 0x04) and a maker `postTransferIn` hook. Before any production order
///   encoding depends on those two facts, this suite proves them against
///     1. the router deployed at the canonical SwapVM address on a Base fork, and
///     2. the unmodified `AquaSwapVMRouter` compiled from the pinned `lib/swap-vm` submodule,
///   which is the documented fallback when the deployed router's identity cannot be confirmed.
///
///   Nothing here is a Tremor contract: the maker is a bare EOA, pricing comes from `ExtructionEcho`, and
///   the hook target is `HookProbe`. The gate therefore measures the router, not Tremor.
///
/// @dev BASE_RPC_URL=... forge test --match-contract RouterCompat -vv
contract RouterCompatTest is Test {
    /// @dev Canonical SwapVM router address published in `lib/swap-vm/README.md`.
    address internal constant CANONICAL_ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;
    /// @dev Canonical Aqua shared-liquidity layer.
    address internal constant CANONICAL_AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;

    address internal maker = vm.addr(0xA11CE);
    address internal taker = vm.addr(0xB0B);

    // ------------------------------------------------------------------ gate 1: deployed canonical router

    /// @notice Records what the router deployed at the canonical SwapVM address actually is on Base.
    ///
    ///   Observed at Base block 51021219: the address holds a SwapVM router that points at canonical Aqua
    ///   and hashes Aqua-mode orders exactly as `keccak256(abi.encode(order))`, so its order identity is
    ///   byte-compatible with `lib/swap-vm`. Its swap entrypoints are NOT: neither
    ///   `quote((address,uint256,bytes),uint256,bytes)` (0xb7ebf0c5) nor
    ///   `swap((address,uint256,bytes),uint256,bytes)` (0xa69f95bd) is dispatchable, so the deployed
    ///   bytecode is a different SwapVM revision than the pinned submodule and cannot be driven through
    ///   `ISwapVM`. Section 8 of the implementation plan prescribes the fallback for exactly this case:
    ///   deploy the unmodified official `AquaSwapVMRouter` source pinned in `lib/swap-vm` and repeat the
    ///   gate, which `test_gate_pinnedOfficialRouterSource_runsExtructionAndMakerHooks` does.
    ///
    ///   This test asserts the observation rather than the wish, so a future Base state in which the
    ///   canonical address does expose the pinned ABI turns it red and forces the choice to be revisited.
    function test_gate_canonicalDeployedRouter_isSwapVmButExposesADifferentSwapAbi() public {
        _selectBaseFork();
        assertGt(CANONICAL_ROUTER.code.length, 0, "canonical router has no code");
        assertGt(CANONICAL_AQUA.code.length, 0, "canonical aqua has no code");
        emit log_named_bytes32("canonical router codehash", keccak256(CANONICAL_ROUTER.code));
        emit log_named_uint("canonical router runtime size", CANONICAL_ROUTER.code.length);
        assertEq(_routerAqua(CANONICAL_ROUTER), CANONICAL_AQUA, "deployed router does not point at canonical Aqua");

        // Aqua-mode order identity is byte-compatible with the pinned source.
        (ISwapVM.Order memory order, bytes32 strategyHash) = _shipProbeStrategy(CANONICAL_ROUTER);
        assertEq(strategyHash, keccak256(abi.encode(order)), "aqua strategy hash != keccak256(abi.encode(order))");
        assertEq(ISwapVM(CANONICAL_ROUTER).hash(order), strategyHash, "deployed router hashes Aqua orders differently");

        // The pinned swap ABI is absent, which is what disqualifies the deployed router for Tremor v2.
        assertFalse(
            _dispatchable(
                CANONICAL_ROUTER, abi.encodeWithSelector(ISwapVM.quote.selector, order, uint256(1), bytes(""))
            ),
            "deployed router unexpectedly accepts the pinned quote ABI"
        );
        assertFalse(
            _dispatchable(
                CANONICAL_ROUTER, abi.encodeWithSelector(ISwapVM.swap.selector, order, uint256(1), bytes(""))
            ),
            "deployed router unexpectedly accepts the pinned swap ABI"
        );
    }

    // ------------------------------------------------------------------ gate 2: pinned official source

    function test_gate_pinnedOfficialRouterSource_runsExtructionAndMakerHooks() public {
        _selectBaseFork();
        AquaSwapVMRouter router = new AquaSwapVMRouter(CANONICAL_AQUA, BASE_WETH, address(this), "SwapVM", "1");
        emit log_named_bytes32("pinned router codehash", keccak256(address(router).code));
        emit log_named_uint("pinned router runtime size", address(router).code.length);
        assertEq(_routerAqua(address(router)), CANONICAL_AQUA);

        _runGate(address(router), IAqua(CANONICAL_AQUA));
    }

    // ------------------------------------------------------------------ gate body

    function _runGate(address router, IAqua aqua) internal {
        ExtructionEcho echo = new ExtructionEcho(3, 2); // amountOut = amountIn * 3 / 2
        HookProbe probe = new HookProbe();

        MockERC20 t0 = new MockERC20("Gate In", "GIN", 18);
        MockERC20 t1 = new MockERC20("Gate Out", "GOUT", 18);
        (address tokenIn, address tokenOut) =
            address(t0) < address(t1) ? (address(t0), address(t1)) : (address(t1), address(t0));

        uint256 makerOut = 1_000e18;
        MockERC20(tokenOut).mint(maker, makerOut);
        MockERC20(tokenIn).mint(taker, 100e18);

        ISwapVM.Order memory order = _order(router, tokenIn, tokenOut, address(echo), address(probe));
        bytes32 expectedHash = keccak256(abi.encode(order));

        address[] memory tokens = new address[](2);
        tokens[0] = tokenIn;
        tokens[1] = tokenOut;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 0;
        amounts[1] = makerOut;

        vm.startPrank(maker);
        IERC20(tokenIn).approve(address(aqua), type(uint256).max);
        IERC20(tokenOut).approve(address(aqua), type(uint256).max);
        bytes32 strategyHash = aqua.ship(router, abi.encode(order), tokens, amounts);
        vm.stopPrank();

        // (a) Aqua-mode strategy hash equals keccak256(abi.encode(order)) and equals the router's own hash.
        assertEq(strategyHash, expectedHash, "aqua strategy hash != keccak256(abi.encode(order))");
        assertEq(ISwapVM(router).hash(order), expectedHash, "router.hash != keccak256(abi.encode(order))");

        // (b) quote reaches the Extruction target and prices it.
        uint256 amountIn = 10e18;
        bytes memory data = _takerData(tokenIn < tokenOut);
        vm.prank(taker);
        (uint256 qIn, uint256 qOut,) = ISwapVM(router).quote(order, amountIn, data);
        assertEq(qIn, amountIn, "quote amountIn");
        assertEq(qOut, amountIn * 3 / 2, "quote did not run the Extruction target");
        assertEq(echo.calls(), 0, "static context wrote target state");

        // (c) swap prices identically, moves real tokens through Aqua, and fires the maker hook.
        uint256 takerInBefore = IERC20(tokenIn).balanceOf(taker);
        uint256 takerOutBefore = IERC20(tokenOut).balanceOf(taker);
        uint256 makerInBefore = IERC20(tokenIn).balanceOf(maker);
        uint256 makerOutBefore = IERC20(tokenOut).balanceOf(maker);

        vm.startPrank(taker);
        IERC20(tokenIn).approve(router, type(uint256).max);
        (uint256 sIn, uint256 sOut,) = ISwapVM(router).swap(order, amountIn, data);
        vm.stopPrank();

        assertEq(sIn, qIn, "quote/swap amountIn divergence");
        assertEq(sOut, qOut, "quote/swap amountOut divergence");
        assertEq(echo.calls(), 1, "swap did not dispatch the non-static Extruction branch");
        assertEq(echo.lastOrderHash(), expectedHash, "target saw a different order hash");
        assertEq(echo.lastMaker(), maker, "target saw a different maker");
        assertEq(echo.lastTaker(), taker, "target saw a different taker");

        assertEq(IERC20(tokenIn).balanceOf(taker), takerInBefore - sIn, "taker tokenIn delta");
        assertEq(IERC20(tokenOut).balanceOf(taker), takerOutBefore + sOut, "taker tokenOut delta");
        assertEq(IERC20(tokenIn).balanceOf(maker), makerInBefore + sIn, "maker tokenIn delta (aqua push)");
        assertEq(IERC20(tokenOut).balanceOf(maker), makerOutBefore - sOut, "maker tokenOut delta (aqua pull)");

        (uint248 aquaIn,) = aqua.rawBalances(maker, router, expectedHash, tokenIn);
        (uint248 aquaOut,) = aqua.rawBalances(maker, router, expectedHash, tokenOut);
        assertEq(aquaIn, sIn, "aqua virtual balanceIn after push");
        assertEq(aquaOut, makerOut - sOut, "aqua virtual balanceOut after pull");

        // (d) the maker post-transfer-in hook ran with the exact IMakerHooks signature and zero fee.
        assertEq(probe.calls(), 1, "post-transfer-in maker hook did not fire");
        assertEq(probe.lastCaller(), router, "hook caller is not the router");
        assertEq(probe.lastMaker(), maker);
        assertEq(probe.lastTaker(), taker);
        assertEq(probe.lastTokenIn(), tokenIn);
        assertEq(probe.lastAmountIn(), sIn);
        assertEq(probe.lastFeeIn(), 0, "receipt-side fee must be zero for the burn hook to be exact");
        assertEq(probe.lastOrderHash(), expectedHash);
        assertEq(
            HookProbe.postTransferIn.selector,
            IMakerHooks.postTransferIn.selector,
            "probe signature drifted from IMakerHooks"
        );
    }

    // ------------------------------------------------------------------ helpers

    /// @dev Ships a two-token probe strategy so the order/hash comparison uses a real Aqua strategy.
    function _shipProbeStrategy(address router) internal returns (ISwapVM.Order memory order, bytes32 strategyHash) {
        ExtructionEcho echo = new ExtructionEcho(3, 2);
        HookProbe probe = new HookProbe();
        MockERC20 a = new MockERC20("Probe A", "PA", 18);
        MockERC20 b = new MockERC20("Probe B", "PB", 18);
        (address tokenIn, address tokenOut) =
            address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));
        MockERC20(tokenOut).mint(maker, 1e18);

        order = _order(router, tokenIn, tokenOut, address(echo), address(probe));

        address[] memory tokens = new address[](2);
        tokens[0] = tokenIn;
        tokens[1] = tokenOut;
        uint256[] memory amounts = new uint256[](2);
        amounts[1] = 1e18;

        vm.startPrank(maker);
        IERC20(tokenIn).approve(CANONICAL_AQUA, type(uint256).max);
        IERC20(tokenOut).approve(CANONICAL_AQUA, type(uint256).max);
        strategyHash = IAqua(CANONICAL_AQUA).ship(router, abi.encode(order), tokens, amounts);
        vm.stopPrank();
    }

    /// @dev True when `target` has a function body for the call's selector. A missing selector falls through
    ///   to the dispatcher's terminal revert with empty return data, which is what this distinguishes.
    function _dispatchable(address target, bytes memory call) internal returns (bool) {
        (bool ok, bytes memory ret) = target.call(call);
        return ok || ret.length > 0;
    }

    function _selectBaseFork() internal {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
    }

    /// @dev `AQUA()` is the one accessor every SwapVM router exposes; a revert means the deployed bytecode
    ///   is not a SwapVM router at all, which the caller asserts on.
    function _routerAqua(address router) internal view returns (address) {
        (bool ok, bytes memory ret) = router.staticcall(abi.encodeWithSignature("AQUA()"));
        require(ok && ret.length == 32, "router has no AQUA() accessor");
        return abi.decode(ret, (address));
    }

    function _order(address, address tokenIn, address tokenOut, address echo, address hookTarget)
        internal
        view
        returns (ISwapVM.Order memory)
    {
        (address tokenA, address tokenB) = tokenIn < tokenOut ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        bytes memory program = bytes.concat(Salt.build(uint64(1)), Extruction.build(echo, ""));
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
                hasPostTransferInHook: true,
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: hookTarget,
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program
            })
        );
    }

    function _takerData(bool isAToB) internal view returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: taker,
                isExactIn: true,
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
}
