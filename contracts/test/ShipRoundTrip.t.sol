// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {MakerTraitsLib, MakerTraits} from "swap-vm/libs/MakerTraits.sol";

import {TremorTestBase} from "./base/TremorTestBase.sol";
import {SeriesParams, Leg} from "../src/libs/SeriesParams.sol";
import {TremorOrderBuilder} from "../src/libs/TremorOrderBuilder.sol";
import {VarianceReceipt} from "../src/tokens/VarianceReceipt.sol";
import {TremorMakerVault} from "../src/TremorMakerVault.sol";
import {IMakerHooks} from "swap-vm/interfaces/IMakerHooks.sol";

/// @dev `MakerTraitsLib`'s slice getters read the order out of calldata, so reaching them from a test that
///   holds the order in memory needs this one hop.
contract OrderInspector {
    using MakerTraitsLib for MakerTraits;

    function program(ISwapVM.Order calldata o) external pure returns (bytes memory) {
        return o.traits.program(o.data);
    }

    function postTransferInHook(ISwapVM.Order calldata o) external pure returns (address target, bytes memory data) {
        (IMakerHooks t, bytes calldata d) = o.traits.postTransferInHook(o.maker, o.data);
        return (address(t), d);
    }
}

/// @notice Hash identity across all three legs:
///     router.hash(order) == keccak256(abi.encode(order)) == the controller's pinned hash
///                        == keccak256(shipPlan strategy) == aqua.ship(...) return value
///   One byte of drift anywhere in the encoding is a different strategy, which is exactly what makes the
///   registry lookup in `TremorMarketEngine` a real authentication and not a formality.
contract ShipRoundTripTest is TremorTestBase {
    using MakerTraitsLib for MakerTraits;

    OrderInspector internal inspector = new OrderInspector();

    function test_hashIdentity_allThreeLegs() public {
        SeriesParams memory p = forwardParams();
        (uint256 id, VarianceReceipt receipt, TremorMakerVault vault) = openMarket(p);
        (
            address writerStored,
            address vaultStored,
            address receiptStored,
            bytes32 issueHash,
            bytes32 exitHash,
            bytes32 settleHash,
        ) = factory.series(id);
        assertEq(writerStored, writer);
        assertEq(vaultStored, address(vault));
        assertEq(receiptStored, address(receipt));
        assertEq(receipt.balanceOf(address(vault)), p.maxUnits, "maxUnits minted to the vault");
        assertEq(receipt.decimals(), 18);

        (ISwapVM.Order memory issue, ISwapVM.Order memory exit, ISwapVM.Order memory settle) = programs.orders(id);
        ISwapVM.Order[3] memory orders = [issue, exit, settle];
        bytes32[3] memory pinned = [issueHash, exitHash, settleHash];
        for (uint256 i = 0; i < 3; i++) {
            assertTrue(orders[i].traits.useAquaInsteadOfSignature(), "leg is not in Aqua mode");
            assertEq(orders[i].maker, address(vault), "leg maker is not the vault");
            assertEq(orders[i].traits.receiver(orders[i].maker), address(vault), "Aqua requires maker == receiver");
            assertEq(router.hash(orders[i]), pinned[i], "router.hash != pinned hash");
            assertEq(keccak256(abi.encode(orders[i])), pinned[i], "abi.encode != pinned hash");
        }
        assertTrue(issueHash != exitHash && exitHash != settleHash && issueHash != settleHash);

        // The two burn legs carry the receipt post-transfer-in hook; ISSUE carries none.
        assertFalse(issue.traits.hasPostTransferInHook(), "ISSUE must not burn anything");
        assertTrue(exit.traits.hasPostTransferInHook(), "EXIT must burn what it takes in");
        assertTrue(settle.traits.hasPostTransferInHook(), "SETTLE must burn what it takes in");
        (address exitHookTarget, bytes memory exitHookData) = inspector.postTransferInHook(exit);
        assertEq(exitHookTarget, address(receipt), "EXIT must burn through the series receipt");
        assertEq(exitHookData.length, 0, "no maker hook data is expected");
        (address settleHookTarget,) = inspector.postTransferInHook(settle);
        assertEq(settleHookTarget, address(receipt), "SETTLE must burn through the series receipt");

        (bytes[] memory strategies, address[] memory tokens, uint256[][] memory amounts) = programs.shipPlan(id);
        for (uint256 i = 0; i < 3; i++) {
            assertEq(keccak256(strategies[i]), pinned[i], "shipPlan strategy != pinned hash");
        }

        assertLt(uint160(tokens[0]), uint160(tokens[1]), "tokens must be sorted for MakerTraits");
        uint256 liability = maxLiabilityOf(p);
        assertEq(liability, 10_000e6, "100 units * 100 USDC * 1.0 cap");
        for (uint256 i = 0; i < 2; i++) {
            assertEq(amounts[0][i], tokens[i] == address(receipt) ? uint256(p.maxUnits) : 0, "ISSUE amounts");
            assertEq(amounts[1][i], tokens[i] == address(usdc) ? liability : 0, "EXIT amounts");
            assertEq(amounts[2][i], tokens[i] == address(usdc) ? liability : 0, "SETTLE amounts");
        }

        // What Aqua actually holds matches, leg by leg.
        (uint256 issueQuote, uint256 issueReceipt) =
            aqua.safeBalances(address(vault), address(router), issueHash, address(usdc), address(receipt));
        assertEq(issueQuote, 0);
        assertEq(issueReceipt, p.maxUnits);
        (uint256 exitQuote, uint256 exitReceipt) =
            aqua.safeBalances(address(vault), address(router), exitHash, address(usdc), address(receipt));
        assertEq(exitQuote, liability);
        assertEq(exitReceipt, 0);
        (uint256 settleQuote, uint256 settleReceipt) =
            aqua.safeBalances(address(vault), address(router), settleHash, address(usdc), address(receipt));
        assertEq(settleQuote, liability);
        assertEq(settleReceipt, 0);

        // The collateral itself is in the vault and nothing is reserved yet.
        assertEq(usdc.balanceOf(address(vault)), liability);
        assertEq(vault.lockedQuote(), 0);
    }

    function test_programsUseOnlyStockSwapVmOpcodes() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,,) = openMarket(p);
        (ISwapVM.Order memory issue, ISwapVM.Order memory exit, ISwapVM.Order memory settle) = programs.orders(id);

        // Salt 0x02, Extruction 0x04, Deadline 0x20 — every one of them shipped with the official router.
        uint8[] memory issueOps = _opcodes(inspector.program(issue));
        assertEq(issueOps.length, 3);
        assertEq(issueOps[0], 0x02);
        assertEq(issueOps[1], 0x20);
        assertEq(issueOps[2], 0x04);

        uint8[] memory exitOps = _opcodes(inspector.program(exit));
        assertEq(exitOps.length, 3);
        assertEq(exitOps[0], 0x02);
        assertEq(exitOps[1], 0x20);
        assertEq(exitOps[2], 0x04);

        // SETTLE has no deadline: a late holder still redeems.
        uint8[] memory settleOps = _opcodes(inspector.program(settle));
        assertEq(settleOps.length, 2);
        assertEq(settleOps[0], 0x02);
        assertEq(settleOps[1], 0x04);
    }

    function test_engineArgs_encodeVersionModeAndSeries() public {
        (uint256 id,,) = openMarket();
        assertEq(TremorOrderBuilder.engineArgs(id, Leg.ISSUE), abi.encodePacked(uint8(1), uint8(1), uint64(id)));
        assertEq(TremorOrderBuilder.engineArgs(id, Leg.EXIT), abi.encodePacked(uint8(1), uint8(2), uint64(id)));
        assertEq(TremorOrderBuilder.engineArgs(id, Leg.SETTLE), abi.encodePacked(uint8(1), uint8(3), uint64(id)));
    }

    function test_deployedContractsFitEip170() public view {
        // forge does not enforce EIP-170 in tests, so this is the only thing standing between a passing
        // suite and an undeployable contract.
        assertLe(address(router).code.length, 24_576, "router");
        assertLe(address(factory).code.length, 24_576, "factory/controller");
        assertLe(address(lens).code.length, 24_576, "lens");
        assertLe(address(engine).code.length, 24_576, "engine");
        assertLe(address(accumulator).code.length, 24_576, "accumulator");
        assertLe(address(factory.DEPLOYER()).code.length, 24_576, "deployer");
        assertGt(address(engine).code.length, 0);
        assertGt(address(accumulator).code.length, 0);
        assertGt(address(factory.DEPLOYER()).code.length, 0);
    }

    function test_bytePerturbation_changesTheHash() public {
        (uint256 id,,) = openMarket();
        (,,, bytes32 issueHash,,,) = factory.series(id);
        (bytes[] memory strategies,,) = programs.shipPlan(id);
        bytes memory strategy = strategies[0];
        strategy[strategy.length - 1] = bytes1(uint8(strategy[strategy.length - 1]) ^ 0x01);
        assertTrue(keccak256(strategy) != issueHash, "one flipped bit must be a different strategy");
    }

    function test_reshippingAStrategyReverts() public {
        (uint256 id,, TremorMakerVault vault) = openMarket();
        (bytes[] memory strategies, address[] memory tokens, uint256[][] memory amounts) = programs.shipPlan(id);
        // Aqua strategies are immutable; even the controller cannot re-ship one.
        vm.prank(address(factory));
        vm.expectRevert();
        vault.shipStrategy(strategies[0], tokens, amounts[0]);
    }

    function test_receiptNaming() public {
        SeriesParams memory p = forwardParams();
        p.expiry = uint40(1_800_000_000 + 7 days); // 2027-01-15 00:00 UTC + 7d = 2027-01-22
        p.saleEnd = p.expiry;
        p.start = uint40(p.expiry - 7 days);
        (, VarianceReceipt receipt,) = openMarket(p);
        assertEq(receipt.name(), "Tremor ETH Variance 2027-01-22");
        assertEq(receipt.symbol(), "tVAR-ETH-270122");
    }

    function test_seriesIdsIncrementAndHashesStayDistinct() public {
        assertEq(factory.seriesCount(), 0);
        SeriesParams memory p = forwardParams();
        TremorMakerVault vault = createVault(writer);
        fundVault(vault, writer, 3 * maxLiabilityOf(p));

        (uint256 id1,) = createSeries(vault, p);
        (uint256 id2,) = createSeries(vault, p);
        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(factory.seriesCount(), 2);

        // Identical parameters, same vault, same block: the salt and the distinct receipt keep them apart.
        (,,, bytes32 h1,,,) = factory.series(1);
        (,,, bytes32 h2,,,) = factory.series(2);
        assertTrue(h1 != h2);
    }

    function test_seriesCreatedEventCarriesEverything() public {
        SeriesParams memory p = forwardParams();
        TremorMakerVault vault = writerVaultFor(p);
        vm.expectEmit(true, true, true, false, address(factory));
        emit SeriesCreated(1, writer, address(vault), address(0), bytes32(0), bytes32(0), bytes32(0), p);
        vm.prank(writer);
        factory.createSeries(address(vault), p);
    }

    // ------------------------------------------------------------------ helpers

    /// @dev Walk a SwapVM program and collect its opcodes. Encoding is `[opcode][argsLength][args...]`.
    function _opcodes(bytes memory program) internal pure returns (uint8[] memory ops) {
        uint8[] memory buffer = new uint8[](64);
        uint256 n;
        uint256 pc;
        while (pc < program.length) {
            buffer[n++] = uint8(program[pc]);
            uint256 argsLength = uint8(program[pc + 1]);
            pc += 2 + argsLength;
        }
        ops = new uint8[](n);
        for (uint256 i = 0; i < n; i++) {
            ops[i] = buffer[i];
        }
    }

    event SeriesCreated(
        uint256 indexed seriesId,
        address indexed writer,
        address indexed vault,
        address receipt,
        bytes32 issueOrderHash,
        bytes32 exitOrderHash,
        bytes32 settlementOrderHash,
        SeriesParams params
    );
}
