// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {TakerTraitsLib} from "swap-vm/libs/TakerTraits.sol";
import {AquaSwapVMRouter} from "swap-vm/routers/AquaSwapVMRouter.sol";

import {TremorMakerVault} from "../src/TremorMakerVault.sol";
import {VarianceAccumulator} from "../src/VarianceAccumulator.sol";
import {VarianceReceipt} from "../src/tokens/VarianceReceipt.sol";
import {PortfolioOrderBuilder as POB} from "../src/portfolio/PortfolioOrderBuilder.sol";
import {TremorPortfolioMarket} from "../src/portfolio/TremorPortfolioMarket.sol";

/// @notice Portfolio (v3) demo stages, run by `script/demo.sh` after the v2 stages, against the same anvil
///   Base fork. Each stage asserts what it claims rather than printing it:
///
///     stageP1        writer funds a protected vault with $100 and opens one HIGH/CALM risk group
///     stageP2        buyer1 buys 100 HIGH for $30 — the full $100 cap locks
///     stageP3        buyer2 buys 100 CALM for $75 — the reserve DOES NOT MOVE ($100, not $200)
///     stageP4        the writer strips every free cent (allowed: premiums are not backing)
///     stageP4Attack  buyer1's $5 buyback of 20 HIGH reverts ExitUnderfunded (simulated: reverts
///                    cannot be broadcast)
///     stageP5        the writer locks a $5 exit buffer; the same buyback executes
///     stageP6        a back-dated group: both sides sold, REAL Chainlink history walked in bounded
///                    permissionless checkpoints by a third account, one finalization fixes both payouts
///                    (summing to exactly $1), both holders redeem without the writer
contract PortfolioDemoFlow is Script {
    uint256 constant PK_WRITER = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // anvil 0
    uint256 constant PK_BUYER1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; // anvil 1
    uint256 constant PK_BUYER2 = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a; // anvil 2

    uint256 constant WAD = 1e18;
    uint128 constant S = 1e6; // $1 cap payout per unit

    struct Env {
        TremorPortfolioMarket market;
        VarianceAccumulator accumulator;
        AquaSwapVMRouter router;
        IERC20 usdc;
        address feed;
    }

    function _env() internal view returns (Env memory e) {
        string memory json = vm.readFile(string.concat("./deployments/", vm.toString(block.chainid), ".json"));
        require(vm.parseJsonUint(json, ".schemaVersion") == 3, "manifest is not schema v3");
        e.market = TremorPortfolioMarket(vm.parseJsonAddress(json, ".portfolioMarket"));
        e.accumulator = VarianceAccumulator(vm.parseJsonAddress(json, ".portfolioAccumulator"));
        e.router = AquaSwapVMRouter(payable(vm.parseJsonAddress(json, ".router")));
        e.usdc = IERC20(vm.parseJsonAddress(json, ".usdc"));
        e.feed = vm.parseJsonAddress(json, ".feed");
    }

    function _params(Env memory e, uint40 start, uint40 expiry, uint40 saleEnd)
        internal
        pure
        returns (TremorPortfolioMarket.GroupParams memory p)
    {
        p = TremorPortfolioMarket.GroupParams({
            feed: e.feed,
            quoteToken: address(e.usdc),
            start: start,
            expiry: expiry,
            saleEnd: saleEnd,
            sampleInterval: 7200,
            capVariance: 1e18,
            capPayoutPerUnit: S,
            maxUnitsPerSide: 1000e18,
            askHigh: 0.30e6,
            bidHigh: 0.25e6,
            askCalm: 0.75e6,
            bidCalm: 0.70e6
        });
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

    function _buy(Env memory e, uint256 pk, uint256 gid, bool high, uint256 units) internal returns (uint256 premium) {
        TremorPortfolioMarket.GroupView memory v = e.market.groupView(gid);
        address receipt = high ? v.highReceipt : v.calmReceipt;
        POB.PMode mode = high ? POB.PMode.ISSUE_HIGH : POB.PMode.ISSUE_CALM;
        address buyer = vm.addr(pk);
        vm.startBroadcast(pk);
        e.usdc.approve(address(e.router), type(uint256).max);
        (premium,,) = e.router.swap(e.market.orderFor(gid, mode), units, _takerData(buyer, false, address(e.usdc) < receipt));
        vm.stopBroadcast();
    }

    function _demoGroup(Env memory e) internal view returns (uint256) {
        // The forward demo group is the first one the demo writer created.
        require(e.market.groupCount() >= 1, "run stageP1 first");
        return 1;
    }

    // ------------------------------------------------------------------ stages

    function stageP1() external {
        Env memory e = _env();
        address writer = vm.addr(PK_WRITER);
        vm.startBroadcast(PK_WRITER);
        TremorMakerVault vault = TremorMakerVault(e.market.createVault());
        e.usdc.approve(address(vault), type(uint256).max);
        vault.deposit(100e6);
        uint256 gid = e.market.createGroup(
            address(vault), _params(e, uint40(block.timestamp), uint40(block.timestamp + 7 days), uint40(block.timestamp + 7 days))
        );
        vm.stopBroadcast();

        TremorPortfolioMarket.GroupView memory v = e.market.groupView(gid);
        require(v.writer == writer && v.reserveLocked == 0 && vault.lockedQuote() == 0, "P1: nothing reserved yet");
        console2.log("P1  group", gid, "vault funded (USDC)", vault.quoteBalance());
    }

    function stageP2() external {
        Env memory e = _env();
        uint256 gid = _demoGroup(e);
        uint256 premium = _buy(e, PK_BUYER1, gid, true, 100e18);
        TremorPortfolioMarket.GroupView memory v = e.market.groupView(gid);
        require(premium == 30e6, "P2: premium");
        require(v.reserveLocked == 100e6, "P2: 100 HIGH reserve the full cap");
        console2.log("P2  100 HIGH sold for $30, reserve now (USDC)", v.reserveLocked);
    }

    function stageP3() external {
        Env memory e = _env();
        uint256 gid = _demoGroup(e);
        uint256 premium = _buy(e, PK_BUYER2, gid, false, 100e18);
        TremorPortfolioMarket.GroupView memory v = e.market.groupView(gid);
        require(premium == 75e6, "P3: premium");
        require(v.reserveLocked == 100e6, "P3: the reserve did not move");
        require(v.standaloneCaps == 200e6, "P3: separate backing would be double");
        console2.log("P3  +100 CALM: reserve still", v.reserveLocked, "- separately backed would lock", v.standaloneCaps);
    }

    function stageP4() external {
        Env memory e = _env();
        uint256 gid = _demoGroup(e);
        TremorPortfolioMarket.GroupView memory v = e.market.groupView(gid);
        TremorMakerVault vault = TremorMakerVault(v.vault);
        uint256 free = vault.freeQuote();
        vm.startBroadcast(PK_WRITER);
        vault.withdrawFree(free, vm.addr(PK_WRITER));
        vm.stopBroadcast();
        require(vault.quoteBalance() == 100e6 && vault.lockedQuote() == 100e6, "P4: only the reserve remains");
        console2.log("P4  writer withdrew free premiums (USDC)", free, "- backing untouched:", vault.quoteBalance());
    }

    /// @dev Run WITHOUT --broadcast: the point is the revert, and a reverting tx cannot be broadcast.
    function stageP4Attack() external {
        Env memory e = _env();
        uint256 gid = _demoGroup(e);
        TremorPortfolioMarket.GroupView memory v = e.market.groupView(gid);
        address buyer = vm.addr(PK_BUYER1);

        vm.startPrank(buyer);
        VarianceReceipt(v.highReceipt).approve(address(e.router), type(uint256).max);
        bytes memory d = _takerData(buyer, true, v.highReceipt < address(e.usdc));
        try e.router.swap(e.market.orderFor(gid, POB.PMode.EXIT_HIGH), 20e18, d) {
            revert("P4A: the underfunded buyback must revert");
        } catch (bytes memory reason) {
            require(bytes4(reason) == TremorPortfolioMarket.ExitUnderfunded.selector, "P4A: wrong revert");
        }
        vm.stopPrank();
        console2.log("P4A the $5 buyback of 20 HIGH reverted ExitUnderfunded(needed $5, available $0) - as designed");
    }

    function stageP5() external {
        Env memory e = _env();
        uint256 gid = _demoGroup(e);
        TremorPortfolioMarket.GroupView memory v = e.market.groupView(gid);
        TremorMakerVault vault = TremorMakerVault(v.vault);

        vm.startBroadcast(PK_WRITER);
        vault.deposit(5e6);
        e.market.allocateExitBuffer(gid, 5e6);
        vm.stopBroadcast();

        address buyer = vm.addr(PK_BUYER1);
        vm.startBroadcast(PK_BUYER1);
        VarianceReceipt(v.highReceipt).approve(address(e.router), type(uint256).max);
        (, uint256 got,) = e.router.swap(
            e.market.orderFor(gid, POB.PMode.EXIT_HIGH), 20e18, _takerData(buyer, true, v.highReceipt < address(e.usdc))
        );
        vm.stopBroadcast();

        v = e.market.groupView(gid);
        require(got == 5e6, "P5: exit proceeds");
        require(v.highOutstanding == 80e18 && v.reserveLocked == 100e6 && v.exitBuffer == 0, "P5: buffer paid");
        require(vault.quoteBalance() == 100e6 && vault.lockedQuote() == 100e6, "P5: exactly solvent");
        console2.log("P5  writer locked a $5 exit buffer; the same buyback executed for (USDC)", got);
    }

    function stageP6() external {
        Env memory e = _env();
        // Back-dated group over real, already-published Chainlink rounds (local fork only, by construction).
        uint40 expiry = uint40(block.timestamp - 1 hours);
        vm.startBroadcast(PK_WRITER);
        TremorMakerVault vault = TremorMakerVault(e.market.createVault());
        vault.deposit(100e6);
        uint256 gid = e.market.createBackdatedDemoGroup(
            address(vault), _params(e, uint40(expiry - 5 days), expiry, uint40(block.timestamp + 1 hours))
        );
        vm.stopBroadcast();

        _buy(e, PK_BUYER1, gid, true, 100e18);
        _buy(e, PK_BUYER2, gid, false, 100e18);

        // A third account — neither writer nor holder of this side — walks the window and finalizes.
        vm.startBroadcast(PK_BUYER2);
        uint256 calls;
        while (true) {
            (uint256 stored, uint256 available,) = e.accumulator.progress(gid);
            if (stored >= available) break;
            e.accumulator.checkpoint(gid, 32);
            calls += 1;
            require(calls < 64, "P6: checkpoint loop did not converge");
        }
        uint256 finalVariance = e.accumulator.finalize(gid);
        vm.stopBroadcast();

        TremorPortfolioMarket.GroupView memory v = e.market.groupView(gid);
        require(v.finalized && v.highPpu + v.calmPpu == S, "P6: complementary payouts");
        console2.log("P6  finalized from real history: variance (WAD)", finalVariance);
        console2.log("    HIGH pays (USDC/unit)", v.highPpu, "CALM pays", v.calmPpu);

        uint256 payout;
        if (v.highPpu > 0) {
            vm.startBroadcast(PK_BUYER1);
            VarianceReceipt(v.highReceipt).approve(address(e.router), type(uint256).max);
            (, uint256 outH,) = e.router.swap(
                e.market.orderFor(gid, POB.PMode.SETTLE_HIGH),
                100e18,
                _takerData(vm.addr(PK_BUYER1), true, v.highReceipt < address(e.usdc))
            );
            vm.stopBroadcast();
            payout += outH;
        }
        if (v.calmPpu > 0) {
            vm.startBroadcast(PK_BUYER2);
            VarianceReceipt(v.calmReceipt).approve(address(e.router), type(uint256).max);
            (, uint256 outC,) = e.router.swap(
                e.market.orderFor(gid, POB.PMode.SETTLE_CALM),
                100e18,
                _takerData(vm.addr(PK_BUYER2), true, v.calmReceipt < address(e.usdc))
            );
            vm.stopBroadcast();
            payout += outC;
        }
        v = e.market.groupView(gid);
        require(v.highOutstanding == 0 && v.calmOutstanding == 0 && v.reserveLocked == 0, "P6: fully settled");
        require(payout <= 100e6, "P6: payouts inside the shared reserve");
        console2.log("    both holders redeemed without the writer; total payout (USDC)", payout);
    }
}
