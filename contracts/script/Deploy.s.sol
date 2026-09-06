// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {AquaSwapVMRouter} from "swap-vm/routers/AquaSwapVMRouter.sol";

import {VarianceSeriesFactory} from "../src/VarianceSeriesFactory.sol";
import {VarianceAccumulator} from "../src/VarianceAccumulator.sol";
import {TremorMarketEngine} from "../src/TremorMarketEngine.sol";
import {TremorSeriesDeployer} from "../src/TremorSeriesDeployer.sol";
import {TremorPrograms} from "../src/TremorPrograms.sol";
import {TremorLens} from "../src/TremorLens.sol";
import {TremorPortfolioMarket} from "../src/portfolio/TremorPortfolioMarket.sol";
import {RealizedVarianceOracle} from "../src/RealizedVarianceOracle.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice Deploys the Tremor v2 stack and writes `deployments/<chainId>.json`.
///
///   Order matters and is asserted rather than assumed:
///
///     1. The router. Preference is the unmodified official `AquaSwapVMRouter` compiled from the pinned
///        `lib/swap-vm` submodule, which is what `test/RouterCompat.t.sol` gates on. Pass `ROUTER` to reuse
///        one already on chain; its code is checked either way, and its bytecode hash goes in the manifest.
///     2. `VarianceSeriesFactory`. Its constructor deploys the accumulator, the market engine and the
///        series deployer, so each child records the factory's final address as an immutable — no
///        initializer, no predicted-address wiring, no window in which the cross-links are wrong.
///     3. `TremorPrograms` and `TremorLens`, both of which verify every cross-link in their constructors.
///     4. `RealizedVarianceOracle`, the trailing-variance cache the LVR page reads. Not on the settlement
///        path.
///
///   env: AQUA (unset => deploy a local Aqua), ROUTER (unset => deploy the pinned official router),
///        WETH, USDC (unset => deploy MockUSDC and fund WRITER/BUYER), FEED, WRITER, BUYER,
///        ORACLE_INTERVAL (default 3600), ROUTER_SOURCE_COMMIT (recorded in the manifest).
///   Base fork: AQUA=0x1111113ccf1426a8e30e2bff5e005d929bf6a90a
///              USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
///              FEED=0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70
contract Deploy is Script {
    /// @notice Bumped whenever the manifest's shape changes, so a v1 manifest cannot be read as a v2 one.
    uint256 constant MANIFEST_SCHEMA_VERSION = 3;

    address constant ANVIL_0 = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address constant ANVIL_1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    address constant BASE_ETH_USD = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    address constant BASE_SEPOLIA_ETH_USD = 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1;

    function run() external {
        address aquaAddr = vm.envOr("AQUA", address(0));
        address routerAddr = vm.envOr("ROUTER", address(0));
        address weth = vm.envOr("WETH", BASE_WETH);
        address usdc = vm.envOr("USDC", address(0));
        address feed = vm.envOr("FEED", block.chainid == 84_532 ? BASE_SEPOLIA_ETH_USD : BASE_ETH_USD);
        address writerAddr = vm.envOr("WRITER", ANVIL_0);
        address buyerAddr = vm.envOr("BUYER", ANVIL_1);
        uint32 oracleInterval = uint32(vm.envOr("ORACLE_INTERVAL", uint256(3600)));
        string memory routerCommit = vm.envOr("ROUTER_SOURCE_COMMIT", string("unrecorded"));
        uint256 deploymentBlock = block.number;

        vm.startBroadcast();
        address owner = msg.sender;

        if (aquaAddr == address(0)) {
            aquaAddr = address(new Aqua());
            console2.log("DEPLOY own Aqua", aquaAddr);
        }
        if (usdc == address(0)) {
            MockUSDC m = new MockUSDC();
            m.mint(writerAddr, 10_000_000e6);
            m.mint(buyerAddr, 1_000_000e6);
            usdc = address(m);
            console2.log("DEPLOY MockUSDC", usdc);
        }
        require(aquaAddr.code.length > 0, "AQUA has no code");
        require(usdc.code.length > 0, "USDC has no code");
        require(feed.code.length > 0, "FEED has no code");

        if (routerAddr == address(0)) {
            // The unmodified official router, compiled from the pinned submodule.
            routerAddr = address(new AquaSwapVMRouter(aquaAddr, weth, owner, "SwapVM", "1"));
            console2.log("DEPLOY official AquaSwapVMRouter", routerAddr);
        }
        require(routerAddr.code.length > 0, "ROUTER has no code");

        VarianceSeriesFactory factory = new VarianceSeriesFactory(routerAddr, aquaAddr, feed, usdc);
        TremorPrograms programs = new TremorPrograms(factory);
        TremorPortfolioMarket portfolioMarket = new TremorPortfolioMarket(routerAddr, aquaAddr, feed, usdc);
        TremorLens lens = new TremorLens(factory);
        RealizedVarianceOracle oracle = new RealizedVarianceOracle(feed, oracleInterval);
        vm.stopBroadcast();

        address accumulator = factory.ACCUMULATOR();
        address engine = factory.ENGINE();
        address seriesDeployer = address(factory.DEPLOYER());

        // Every cross-link, verified after the fact as well as inside the constructors.
        require(factory.ROUTER() == routerAddr, "factory router mismatch");
        require(factory.AQUA() == aquaAddr, "factory aqua mismatch");
        require(factory.FEED() == feed, "factory feed mismatch");
        require(factory.QUOTE_TOKEN() == usdc, "factory quote token mismatch");
        require(TremorMarketEngine(engine).CONTROLLER() == address(factory), "engine controller mismatch");
        require(TremorMarketEngine(engine).ACCUMULATOR() == accumulator, "engine accumulator mismatch");
        require(VarianceAccumulator(accumulator).CONTROLLER() == address(factory), "accumulator controller mismatch");
        require(VarianceAccumulator(accumulator).FEED() == feed, "accumulator feed mismatch");
        require(TremorSeriesDeployer(seriesDeployer).CONTROLLER() == address(factory), "deployer controller mismatch");
        require(TremorSeriesDeployer(seriesDeployer).QUOTE_TOKEN() == usdc, "deployer quote token mismatch");
        require(TremorSeriesDeployer(seriesDeployer).ROUTER() == routerAddr, "deployer router mismatch");
        require(address(programs.FACTORY()) == address(factory), "programs factory mismatch");
        require(address(lens.FACTORY()) == address(factory), "lens factory mismatch");
        require(address(lens.ENGINE()) == engine, "lens engine mismatch");
        require(engine.code.length > 0 && accumulator.code.length > 0, "child has no code");
        require(seriesDeployer.code.length > 0, "series deployer has no code");

        bytes32 routerBytecodeHash = keccak256(routerAddr.code);

        console2.log("DEPLOY chainId", block.chainid);
        console2.log("  aqua        ", aquaAddr);
        console2.log("  router      ", routerAddr);
        console2.log("  usdc        ", usdc);
        console2.log("  feed        ", feed);
        console2.log("  seriesFactory", address(factory));
        console2.log("  marketEngine", engine);
        console2.log("  accumulator ", accumulator);
        console2.log("  seriesDeployer", seriesDeployer);
        console2.log("  programs    ", address(programs));
        console2.log("  lens        ", address(lens));
        console2.log("  portfolio   ", address(portfolioMarket));
        console2.log("  oracle      ", address(oracle));
        console2.log("  block       ", deploymentBlock);

        string memory json = "deployment";
        vm.serializeUint(json, "schemaVersion", MANIFEST_SCHEMA_VERSION);
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "aqua", aquaAddr);
        vm.serializeAddress(json, "router", routerAddr);
        vm.serializeString(json, "routerSourceCommit", routerCommit);
        vm.serializeBytes32(json, "routerBytecodeHash", routerBytecodeHash);
        vm.serializeAddress(json, "weth", weth);
        vm.serializeAddress(json, "usdc", usdc);
        vm.serializeAddress(json, "feed", feed);
        vm.serializeAddress(json, "seriesFactory", address(factory));
        vm.serializeAddress(json, "marketEngine", engine);
        vm.serializeAddress(json, "accumulator", accumulator);
        vm.serializeAddress(json, "seriesDeployer", seriesDeployer);
        vm.serializeAddress(json, "programs", address(programs));
        vm.serializeAddress(json, "lens", address(lens));
        vm.serializeAddress(json, "oracle", address(oracle));
        vm.serializeAddress(json, "portfolioMarket", address(portfolioMarket));
        vm.serializeAddress(json, "portfolioAccumulator", portfolioMarket.ACCUMULATOR());
        vm.serializeUint(json, "deploymentBlock", deploymentBlock);
        vm.serializeAddress(json, "writer", writerAddr);
        string memory out = vm.serializeAddress(json, "buyer", buyerAddr);
        vm.writeJson(out, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}
