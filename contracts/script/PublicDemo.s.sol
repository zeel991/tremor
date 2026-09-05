// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SeriesParams} from "../src/libs/SeriesParams.sol";
import {VarianceSeriesFactory} from "../src/VarianceSeriesFactory.sol";
import {TremorMakerVault} from "../src/TremorMakerVault.sol";

interface IMintableUSDC is IERC20 {
    function mint(address to, uint256 amount) external;
}

/// @notice Creates one funded forward series on the schema-v2 public deployment.
/// @dev Intended for Base Sepolia's permissionless MockUSDC demo deployment only.
contract PublicDemo is Script {
    function run() external {
        string memory json = vm.readFile("./deployments/84532.json");
        VarianceSeriesFactory factory = VarianceSeriesFactory(vm.parseJsonAddress(json, ".seriesFactory"));
        IMintableUSDC usdc = IMintableUSDC(vm.parseJsonAddress(json, ".usdc"));
        address feed = vm.parseJsonAddress(json, ".feed");
        address writer = vm.envAddress("WRITER");
        uint256 collateral = 2_000_000e6;

        uint40 start = uint40(block.timestamp);
        SeriesParams memory p = SeriesParams({
            feed: feed,
            quoteToken: address(usdc),
            start: start,
            expiry: start + 7 days,
            saleEnd: start + 3 days,
            sampleInterval: 1 hours,
            unitNotional: 1e6,
            capVariance: 1e18,
            anchorVariance: 0.25e18,
            impactPerUnit: 0.001e18,
            halfLife: 1 hours,
            halfSpreadBps: 50,
            maxUnits: 1_000e18
        });

        vm.startBroadcast();
        usdc.mint(writer, collateral);
        address vault = factory.createVault();
        usdc.approve(vault, collateral);
        TremorMakerVault(vault).deposit(collateral);
        (uint256 seriesId, address receipt) = factory.createSeries(vault, p);
        vm.stopBroadcast();

        console2.log("PUBLIC DEMO SERIES", seriesId);
        console2.log("  writer  ", writer);
        console2.log("  vault   ", vault);
        console2.log("  receipt ", receipt);
        console2.log("  expiry  ", p.expiry);
    }
}
