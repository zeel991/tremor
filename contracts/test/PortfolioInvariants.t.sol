// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {TakerTraitsLib} from "swap-vm/libs/TakerTraits.sol";
import {AquaSwapVMRouter} from "swap-vm/routers/AquaSwapVMRouter.sol";

import {TremorMakerVault} from "../src/TremorMakerVault.sol";
import {VarianceAccumulator} from "../src/VarianceAccumulator.sol";
import {VarianceReceipt} from "../src/tokens/VarianceReceipt.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {PortfolioOrderBuilder as POB} from "../src/portfolio/PortfolioOrderBuilder.sol";
import {TremorPortfolioMarket} from "../src/portfolio/TremorPortfolioMarket.sol";

/// @notice A holder wallet the handler can drive through the router.
contract PortfolioHolder {
    address public immutable OWNER;

    error NotOwner();

    constructor() {
        OWNER = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert NotOwner();
        _;
    }

    function approve(address token, address spender) external onlyOwner {
        IERC20(token).approve(spender, type(uint256).max);
    }

    function swap(address router, ISwapVM.Order calldata order, uint256 amount, bytes calldata takerData)
        external
        onlyOwner
        returns (uint256 amountIn, uint256 amountOut)
    {
        (amountIn, amountOut,) = ISwapVM(router).swap(order, amount, takerData);
    }

    function transfer(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).transfer(to, amount);
    }

    function burnWorthless(address market, uint256 groupId, bool high, uint256 units) external onlyOwner {
        TremorPortfolioMarket(market).burnWorthless(groupId, high, units);
    }
}

/// @notice Drives every portfolio state transition in whatever order the fuzzer picks — issuance of both
///   sides, exits, buffer funding and withdrawal, free withdrawal, checkpointing, finalization, redemption
///   and worthless burns — and counts what actually SUCCEEDED so the suite can prove non-vacuity.
contract PortfolioHandler is Test {
    TremorPortfolioMarket public immutable MARKET;
    VarianceAccumulator public immutable ACCUMULATOR;
    AquaSwapVMRouter public immutable ROUTER;
    MockUSDC public immutable USDC;
    MockAggregator public immutable FEED;
    address public immutable WRITER;

    TremorMakerVault public vault;
    PortfolioHolder public holderA;
    PortfolioHolder public holderB;

    uint256[] public groupIds;
    uint256 public constant MAX_GROUPS = 2;

    uint256 public okBuy;
    uint256 public okExit;
    uint256 public okRedeem;
    uint256 public okFinalize;
    uint256 public okAllocate;
    uint256 public okBufferWithdraw;
    uint256 public okFreeWithdraw;
    uint256 public okBurnWorthless;

    uint256 public feedLastTs;
    int256 public feedLastPrice;
    uint256 public feedNonce;

    constructor(
        TremorPortfolioMarket market,
        AquaSwapVMRouter router,
        MockUSDC usdc,
        MockAggregator feed,
        address writer,
        uint256 startTs,
        int256 startPrice
    ) {
        MARKET = market;
        ACCUMULATOR = VarianceAccumulator(market.ACCUMULATOR());
        ROUTER = router;
        USDC = usdc;
        FEED = feed;
        WRITER = writer;
        feedLastTs = startTs;
        feedLastPrice = startPrice;
        holderA = new PortfolioHolder();
        holderB = new PortfolioHolder();
    }

    function groupCount() external view returns (uint256) {
        return groupIds.length;
    }

    // ------------------------------------------------------------------ time and feed

    function _pushRoundsUntil(uint256 untilTs) internal {
        while (feedLastTs + 600 <= untilTs) {
            feedLastTs += 600;
            int256 delta = int256(uint256(keccak256(abi.encode(feedNonce++))) % 6001) - 3000;
            feedLastPrice = feedLastPrice * (1_000_000 + delta) / 1_000_000;
            FEED.pushRound(feedLastPrice, feedLastTs);
        }
    }

    function warp(uint256 seed) public {
        uint256 dt = bound(seed, 10 minutes, 6 hours);
        _pushRoundsUntil(block.timestamp + dt);
        vm.warp(block.timestamp + dt);
    }

    // ------------------------------------------------------------------ setup actions

    function init() external {
        deposit(uint96(500_000e6));
        createGroup(1);
        require(groupIds.length == 1, "handler failed to seed a group");
    }

    function deposit(uint96 rawAmount) public {
        uint256 amount = bound(uint256(rawAmount), 10_000e6, 500_000e6);
        if (address(vault) == address(0)) {
            vm.prank(WRITER);
            vault = TremorMakerVault(MARKET.createVault());
        }
        USDC.mint(address(this), amount);
        USDC.approve(address(vault), amount);
        vault.deposit(amount);
    }

    function createGroup(uint256 seed) public {
        if (groupIds.length >= MAX_GROUPS) return;
        if (address(vault) == address(0)) deposit(uint96(500_000e6));

        uint128 s = uint128(bound(uint256(keccak256(abi.encode(seed, 1))), 1, 10e6)); // $0.000001..$10 scale
        uint256 hours_ = bound(seed, 4, 40);
        TremorPortfolioMarket.GroupParams memory p = TremorPortfolioMarket.GroupParams({
            feed: address(FEED),
            quoteToken: address(USDC),
            start: uint40(block.timestamp),
            expiry: uint40(block.timestamp + hours_ * 1 hours),
            saleEnd: uint40(block.timestamp + hours_ * 1 hours),
            sampleInterval: 3600,
            capVariance: uint64(bound(uint256(keccak256(abi.encode(seed, 2))), 1e16, 2e18)),
            capPayoutPerUnit: s,
            maxUnitsPerSide: uint128(bound(uint256(keccak256(abi.encode(seed, 3))), 1e18, 5_000e18)),
            askHigh: 0,
            bidHigh: 0,
            askCalm: 0,
            bidCalm: 0
        });
        p.askHigh = uint128(bound(uint256(keccak256(abi.encode(seed, 4))), 1, s));
        p.bidHigh = uint128(bound(uint256(keccak256(abi.encode(seed, 5))), 0, p.askHigh));
        p.askCalm = uint128(bound(uint256(keccak256(abi.encode(seed, 6))), 1, s));
        p.bidCalm = uint128(bound(uint256(keccak256(abi.encode(seed, 7))), 0, p.askCalm));

        vm.prank(WRITER);
        try MARKET.createGroup(address(vault), p) returns (uint256 id) {
            groupIds.push(id);
            TremorPortfolioMarket.GroupView memory v = MARKET.groupView(id);
            holderA.approve(v.highReceipt, address(ROUTER));
            holderA.approve(v.calmReceipt, address(ROUTER));
            holderB.approve(v.highReceipt, address(ROUTER));
            holderB.approve(v.calmReceipt, address(ROUTER));
            holderA.approve(address(USDC), address(ROUTER));
            holderB.approve(address(USDC), address(ROUTER));
        } catch {}
    }

    // ------------------------------------------------------------------ trading actions

    function _pick(uint256 seed) internal view returns (bool ok, uint256 id) {
        if (groupIds.length == 0) return (false, 0);
        return (true, groupIds[seed % groupIds.length]);
    }

    function _holder(uint256 seed) internal view returns (PortfolioHolder) {
        return seed % 2 == 0 ? holderA : holderB;
    }

    function _takerData(address taker, bool isExactIn, bool isAToB) internal pure returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: taker,
                isExactIn: isExactIn,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                isAToB: isAToB,
                allowPartialFill: true,
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

    function buy(uint256 seed, uint96 rawUnits, bool high) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        PortfolioHolder holder = _holder(seed);
        TremorPortfolioMarket.GroupView memory v = MARKET.groupView(id);
        address receipt = high ? v.highReceipt : v.calmReceipt;
        uint256 units = bound(uint256(rawUnits), 1e15, 500e18);
        USDC.mint(address(holder), 100_000e6);
        POB.PMode mode = high ? POB.PMode.ISSUE_HIGH : POB.PMode.ISSUE_CALM;
        try holder.swap(
            address(ROUTER),
            MARKET.orderFor(id, mode),
            units,
            _takerData(address(holder), false, address(USDC) < receipt)
        ) {
            okBuy += 1;
        } catch {}
    }

    function exit(uint256 seed, uint96 rawUnits, bool high) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        PortfolioHolder holder = _holder(seed);
        TremorPortfolioMarket.GroupView memory v = MARKET.groupView(id);
        address receipt = high ? v.highReceipt : v.calmReceipt;
        uint256 held = IERC20(receipt).balanceOf(address(holder));
        if (held == 0) return;
        uint256 units = bound(uint256(rawUnits), 1, held);
        POB.PMode mode = high ? POB.PMode.EXIT_HIGH : POB.PMode.EXIT_CALM;
        try holder.swap(
            address(ROUTER),
            MARKET.orderFor(id, mode),
            units,
            _takerData(address(holder), true, receipt < address(USDC))
        ) {
            okExit += 1;
        } catch {}
    }

    function transferClaims(uint256 seed, uint96 rawUnits, bool high) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        TremorPortfolioMarket.GroupView memory v = MARKET.groupView(id);
        address receipt = high ? v.highReceipt : v.calmReceipt;
        uint256 held = IERC20(receipt).balanceOf(address(holderA));
        if (held == 0) return;
        holderA.transfer(receipt, address(holderB), bound(uint256(rawUnits), 1, held));
    }

    // ------------------------------------------------------------------ buffer and collateral actions

    function allocateBuffer(uint256 seed, uint96 rawAmount) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        uint256 amount = bound(uint256(rawAmount), 1, 1_000e6);
        vm.prank(WRITER);
        try MARKET.allocateExitBuffer(id, amount) {
            okAllocate += 1;
        } catch {}
    }

    function withdrawBuffer(uint256 seed, uint96 rawAmount) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        uint256 amount = bound(uint256(rawAmount), 1, 1_000e6);
        vm.prank(WRITER);
        try MARKET.withdrawExitBuffer(id, amount) {
            okBufferWithdraw += 1;
        } catch {}
    }

    function withdrawFree(uint96 rawAmount) public {
        if (address(vault) == address(0)) return;
        uint256 free = vault.freeQuote();
        if (free == 0) return;
        uint256 amount = bound(uint256(rawAmount), 1, free);
        vm.prank(WRITER);
        try vault.withdrawFree(amount, WRITER) {
            okFreeWithdraw += 1;
        } catch {}
    }

    // ------------------------------------------------------------------ lifecycle actions

    function checkpoint(uint256 seed) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        try ACCUMULATOR.checkpoint(id, 32) {} catch {}
    }

    function finalizeGroup(uint256 seed) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        TremorPortfolioMarket.GroupView memory v = MARKET.groupView(id);
        if (v.finalized) return;
        TremorPortfolioMarket.GroupParams memory p = MARKET.groupParams(id);
        if (block.timestamp < p.expiry) {
            _pushRoundsUntil(uint256(p.expiry) + 600);
            vm.warp(uint256(p.expiry) + 1);
        }
        for (uint256 i = 0; i < 16; i++) {
            (uint256 stored, uint256 available) = ACCUMULATOR.checkpoint(id, 32);
            if (stored >= available) break;
        }
        try ACCUMULATOR.finalize(id) {
            okFinalize += 1;
        } catch {}
    }

    function redeem(uint256 seed, uint96 rawUnits, bool high) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        PortfolioHolder holder = _holder(seed);
        TremorPortfolioMarket.GroupView memory v = MARKET.groupView(id);
        address receipt = high ? v.highReceipt : v.calmReceipt;
        uint256 held = IERC20(receipt).balanceOf(address(holder));
        if (held == 0) return;
        uint256 units = bound(uint256(rawUnits), 1, held);
        POB.PMode mode = high ? POB.PMode.SETTLE_HIGH : POB.PMode.SETTLE_CALM;
        try holder.swap(
            address(ROUTER),
            MARKET.orderFor(id, mode),
            units,
            _takerData(address(holder), true, receipt < address(USDC))
        ) {
            okRedeem += 1;
        } catch {}
    }

    function burnWorthless(uint256 seed, uint96 rawUnits, bool high) public {
        (bool ok, uint256 id) = _pick(seed);
        if (!ok) return;
        PortfolioHolder holder = _holder(seed);
        TremorPortfolioMarket.GroupView memory v = MARKET.groupView(id);
        address receipt = high ? v.highReceipt : v.calmReceipt;
        uint256 held = IERC20(receipt).balanceOf(address(holder));
        if (held == 0) return;
        try holder.burnWorthless(address(MARKET), id, high, bound(uint256(rawUnits), 1, held)) {
            okBurnWorthless += 1;
        } catch {}
    }
}

/// @notice Stateful invariants for the portfolio market: whatever order the fuzzer drives buys, exits,
///   buffer moves, withdrawals, finalization and redemption in, the vault stays solvent, the vault lock
///   equals the sum of the group ledgers, the reserve matches an independently re-derived model, and claim
///   supplies reconcile. The scripted non-vacuity test proves the handler actually reaches the interesting
///   states, because an invariant suite whose every action reverts proves nothing.
contract PortfolioInvariantsTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant T0 = 1_800_000_000;

    Aqua internal aqua;
    MockUSDC internal usdc;
    MockAggregator internal feed;
    AquaSwapVMRouter internal router;
    TremorPortfolioMarket internal market;
    PortfolioHandler internal handler;

    address internal writer = makeAddr("writer");

    function setUp() public {
        vm.warp(T0);
        aqua = new Aqua();
        usdc = new MockUSDC();
        feed = new MockAggregator(8);
        router = new AquaSwapVMRouter(address(aqua), address(0), address(this), "SwapVM", "1");
        int256 price = 2_400_00000000;
        feed.pushRound(price, T0 - 600);
        feed.pushRound(price, T0);
        market = new TremorPortfolioMarket(address(router), address(aqua), address(feed), address(usdc));

        handler = new PortfolioHandler(market, router, usdc, feed, writer, T0, price);
        handler.init();

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = PortfolioHandler.deposit.selector;
        selectors[1] = PortfolioHandler.createGroup.selector;
        selectors[2] = PortfolioHandler.buy.selector;
        selectors[3] = PortfolioHandler.exit.selector;
        selectors[4] = PortfolioHandler.transferClaims.selector;
        selectors[5] = PortfolioHandler.allocateBuffer.selector;
        selectors[6] = PortfolioHandler.withdrawBuffer.selector;
        selectors[7] = PortfolioHandler.withdrawFree.selector;
        selectors[8] = PortfolioHandler.warp.selector;
        selectors[9] = PortfolioHandler.checkpoint.selector;
        selectors[10] = PortfolioHandler.finalizeGroup.selector;
        selectors[11] = PortfolioHandler.redeem.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ------------------------------------------------------------------ reference model (independent)

    function _refReserve(uint256 h, uint256 c, uint256 s) internal pure returns (uint256) {
        uint256 m = h > c ? h : c;
        return (m * s + WAD - 1) / WAD;
    }

    // ------------------------------------------------------------------ invariants

    function invariant_vaultSolventAndLockMatchesLedgers() public view {
        TremorMakerVault vault = handler.vault();
        if (address(vault) == address(0)) return;
        uint256 sum;
        uint256 n = handler.groupCount();
        for (uint256 i = 0; i < n; i++) {
            TremorPortfolioMarket.GroupView memory v = market.groupView(handler.groupIds(i));
            sum += v.reserveLocked + v.exitBuffer;
        }
        assertEq(vault.lockedQuote(), sum, "vault lock != sum of group reserves + buffers");
        assertGe(vault.quoteBalance(), vault.lockedQuote(), "vault balance below locked");
    }

    function invariant_reserveMatchesReferenceModel() public view {
        uint256 n = handler.groupCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.groupIds(i);
            TremorPortfolioMarket.GroupView memory v = market.groupView(id);
            TremorPortfolioMarket.GroupParams memory p = market.groupParams(id);
            if (!v.finalized) {
                assertEq(
                    v.reserveLocked,
                    _refReserve(v.highOutstanding, v.calmOutstanding, p.capPayoutPerUnit),
                    "pre-final reserve != ceil(max(h,c)*S)"
                );
            } else {
                assertEq(v.exitBuffer, 0, "buffer must be released at finalization");
                assertEq(v.highPpu + v.calmPpu, p.capPayoutPerUnit, "payouts must sum to S");
                assertEq(
                    v.reserveLocked,
                    v.highOutstanding * v.highPpu / WAD + v.calmOutstanding * v.calmPpu / WAD,
                    "post-final reserve != exact remaining liabilities"
                );
            }
        }
    }

    function invariant_outstandingMatchesSupply() public view {
        uint256 n = handler.groupCount();
        for (uint256 i = 0; i < n; i++) {
            TremorPortfolioMarket.GroupView memory v = market.groupView(handler.groupIds(i));
            assertEq(
                v.highOutstanding,
                IERC20(v.highReceipt).totalSupply() - IERC20(v.highReceipt).balanceOf(v.vault),
                "HIGH outstanding != circulating supply"
            );
            assertEq(
                v.calmOutstanding,
                IERC20(v.calmReceipt).totalSupply() - IERC20(v.calmReceipt).balanceOf(v.vault),
                "CALM outstanding != circulating supply"
            );
        }
    }

    // ------------------------------------------------------------------ non-vacuity

    /// @notice Drives the handler through a scripted sequence and asserts every interesting state is
    ///   actually reachable through the handler's own actions.
    function test_handlerCanReachEveryState() public {
        handler.deposit(uint96(500_000e6));
        handler.buy(0, uint96(uint256(50e18)), true);
        handler.buy(0, uint96(uint256(50e18)), false);
        assertGe(handler.okBuy(), 2, "handler cannot buy");

        handler.allocateBuffer(0, uint96(uint256(1_000e6)));
        assertGe(handler.okAllocate(), 1, "handler cannot fund the buffer");

        handler.exit(0, uint96(uint256(5e18)), true);
        assertGe(handler.okExit(), 1, "handler cannot exit");

        handler.transferClaims(0, uint96(uint256(1e18)), true);
        handler.withdrawBuffer(0, uint96(uint256(1e6)));
        assertGe(handler.okBufferWithdraw(), 1, "handler cannot withdraw buffer");
        handler.withdrawFree(uint96(uint256(1e6)));
        assertGe(handler.okFreeWithdraw(), 1, "handler cannot withdraw free collateral");

        handler.finalizeGroup(0);
        assertGe(handler.okFinalize(), 1, "handler cannot finalize");

        handler.redeem(0, uint96(uint256(5e18)), true);
        handler.redeem(1, uint96(uint256(5e18)), false);
        handler.burnWorthless(0, uint96(uint256(1e18)), true);
        handler.burnWorthless(0, uint96(uint256(1e18)), false);
        assertGe(handler.okRedeem() + handler.okBurnWorthless(), 1, "handler cannot redeem or burn");

        invariant_vaultSolventAndLockMatchesLedgers();
        invariant_reserveMatchesReferenceModel();
        invariant_outstandingMatchesSupply();
    }
}
