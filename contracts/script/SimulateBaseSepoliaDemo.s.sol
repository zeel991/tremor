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

contract SimulateBaseSepoliaDemo is Script {
    address constant WRITER = 0x975D862A1f01a292EDf11b12cC809dffaC35997A;
    address constant BUYER = 0xbaAe28c72177Bc3814dd0961b9aA09fddB56B752;

    struct Env {
        TremorPortfolioMarket market;
        VarianceAccumulator accumulator;
        AquaSwapVMRouter router;
        IERC20 usdc;
        address feed;
    }

    function _env() internal view returns (Env memory e) {
        string memory json = vm.readFile("./deployments/84532.json");
        require(vm.parseJsonUint(json, ".schemaVersion") == 3, "manifest is not schema v3");
        e.market = TremorPortfolioMarket(vm.parseJsonAddress(json, ".portfolioMarket"));
        e.accumulator = VarianceAccumulator(vm.parseJsonAddress(json, ".portfolioAccumulator"));
        e.router = AquaSwapVMRouter(payable(vm.parseJsonAddress(json, ".router")));
        e.usdc = IERC20(vm.parseJsonAddress(json, ".usdc"));
        e.feed = vm.parseJsonAddress(json, ".feed");
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

    function run() external {
        Env memory e = _env();
        console2.log("=== BASE SEPOLIA DEMO SIMULATION ===");
        console2.log("Market:", address(e.market));
        console2.log("Router:", address(e.router));
        console2.log("USDC:  ", address(e.usdc));
        console2.log("Writer:", WRITER);
        console2.log("Buyer: ", BUYER);

        uint40 start = uint40(block.timestamp);
        uint40 saleEnd = start + 600;
        uint40 expiry = start + 600;

        TremorPortfolioMarket.GroupParams memory p = TremorPortfolioMarket.GroupParams({
            feed: e.feed,
            quoteToken: address(e.usdc),
            start: start,
            expiry: expiry,
            saleEnd: saleEnd,
            sampleInterval: 300,
            capVariance: 1e18,
            capPayoutPerUnit: 1e6,
            maxUnitsPerSide: 1000e18,
            askHigh: 0.3e6,
            bidHigh: 0.25e6,
            askCalm: 0.75e6,
            bidCalm: 0.7e6
        });

        // 1. Writer creates vault & deposits 100 USDC
        vm.startPrank(WRITER);
        address vaultAddr = e.market.createVault();
        console2.log("[Step 0] Created Vault:", vaultAddr);
        require(e.market.vaultOf(WRITER) == vaultAddr, "Vault ownership mismatch");

        e.usdc.approve(vaultAddr, 100e6);
        TremorMakerVault vault = TremorMakerVault(vaultAddr);
        vault.deposit(100e6);
        console2.log("[Step 1] Vault Quote Balance:", vault.quoteBalance());

        uint256 gid = e.market.createGroup(vaultAddr, p);
        console2.log("[Step 2] Group Created ID:", gid);
        vm.stopPrank();

        TremorPortfolioMarket.GroupView memory v = e.market.groupView(gid);
        console2.log("  High Receipt:", v.highReceipt);
        console2.log("  Calm Receipt:", v.calmReceipt);

        // 2. Buyer approves USDC & buys 100 HIGH + 100 CALM
        vm.startPrank(BUYER);
        e.usdc.approve(address(e.router), 105e6);

        (uint256 premHigh,,) = e.router
            .swap(
                e.market.orderFor(gid, POB.PMode.ISSUE_HIGH),
                100e18,
                _takerData(BUYER, false, address(e.usdc) < v.highReceipt)
            );
        console2.log("[Step 3A] Bought 100 HIGH. Premium:", premHigh);

        (uint256 premCalm,,) = e.router
            .swap(
                e.market.orderFor(gid, POB.PMode.ISSUE_CALM),
                100e18,
                _takerData(BUYER, false, address(e.usdc) < v.calmReceipt)
            );
        console2.log("[Step 3B] Bought 100 CALM. Premium:", premCalm);

        v = e.market.groupView(gid);
        console2.log("  Vault Quote Balance:", vault.quoteBalance());
        console2.log("  Vault Reserve Locked:", v.reserveLocked);
        console2.log("  Vault Free Quote:", vault.freeQuote());

        // 3. Buyer approves receipts (bounded 100e18)
        VarianceReceipt(v.highReceipt).approve(address(e.router), 100e18);
        VarianceReceipt(v.calmReceipt).approve(address(e.router), 100e18);
        console2.log("[Step 4] Approved bounded receipt allowances (100e18)");

        // 4. Underfunded exit rejection simulation
        try e.router
            .swap(
                e.market.orderFor(gid, POB.PMode.EXIT_HIGH),
                10e18,
                _takerData(BUYER, true, v.highReceipt < address(e.usdc))
            ) {
            revert("Exit should have reverted!");
        } catch (bytes memory reason) {
            require(bytes4(reason) == TremorPortfolioMarket.ExitUnderfunded.selector, "Wrong revert selector");
            console2.log("[Step 5] Exit correctly reverted ExitUnderfunded(needed: 2.5 USDC, avail: 0)");
        }
        vm.stopPrank();

        // 5. Writer allocates $5 exit buffer from free cash
        vm.startPrank(WRITER);
        e.market.allocateExitBuffer(gid, 5e6);
        console2.log("[Step 6] Writer allocated 5 USDC exit buffer. Buffer:", e.market.groupView(gid).exitBuffer);
        vm.stopPrank();

        // 6. Buyer executes 10 HIGH exit
        vm.startPrank(BUYER);
        (, uint256 proceeds,) = e.router
            .swap(
                e.market.orderFor(gid, POB.PMode.EXIT_HIGH),
                10e18,
                _takerData(BUYER, true, v.highReceipt < address(e.usdc))
            );
        console2.log("[Step 7] Exit 10 HIGH succeeded. Proceeds:", proceeds);
        vm.stopPrank();

        v = e.market.groupView(gid);
        console2.log("  High Outstanding:", v.highOutstanding);
        console2.log("  Exit Buffer Left:", v.exitBuffer);
        console2.log("  Vault Quote Balance:", vault.quoteBalance());

        console2.log("=== SIMULATION PASSED CLEANLY ===");
    }
}
