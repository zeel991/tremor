// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TremorTestBase} from "./base/TremorTestBase.sol";
import {SeriesParams} from "../src/libs/SeriesParams.sol";
import {TremorMakerVault} from "../src/TremorMakerVault.sol";
import {TremorSeriesDeployer} from "../src/TremorSeriesDeployer.sol";
import {VarianceSeriesFactory} from "../src/VarianceSeriesFactory.sol";
import {VarianceReceipt} from "../src/tokens/VarianceReceipt.sol";

/// @notice `TremorMakerVault` in isolation: deterministic deployment, immutable wiring, deposit and
///   free-withdrawal accounting, and the authorization boundary that makes a writer unable to rug a holder.
contract MakerVaultTest is TremorTestBase {
    function test_deployment_isDeterministicAndIdempotent() public {
        address predicted = factory.predictVault(writer);
        TremorMakerVault vault = createVault(writer);
        assertEq(address(vault), predicted, "vault landed at the predicted CREATE2 address");
        assertTrue(factory.isVault(address(vault)));
        assertEq(factory.vaultOf(writer), address(vault));

        // A second call returns the same vault rather than deploying or reverting.
        vm.prank(writer);
        assertEq(factory.createVault(), address(vault), "second createVault returns the existing vault");
    }

    function test_deployment_isPerWriter() public {
        TremorMakerVault a = createVault(writer);
        TremorMakerVault b = createVault(buyer1);
        assertTrue(address(a) != address(b));
        assertEq(a.OWNER(), writer);
        assertEq(b.OWNER(), buyer1);
    }

    function test_immutables_pointAtTheOfficialStack() public {
        TremorMakerVault vault = createVault(writer);
        assertEq(vault.OWNER(), writer);
        assertEq(vault.QUOTE_TOKEN(), address(usdc));
        assertEq(vault.AQUA(), address(aqua));
        assertEq(vault.ROUTER(), address(router));
        assertEq(vault.CONTROLLER(), address(factory));
    }

    function test_aquaAllowance_isMaximumAndUnrevokable() public {
        TremorMakerVault vault = createVault(writer);
        assertEq(vault.aquaAllowance(), type(uint256).max);

        // There is no code path that approves the quote token again, from any caller.
        bytes4[3] memory guesses = [
            bytes4(keccak256("approve(address,uint256)")),
            bytes4(keccak256("setAllowance(address,uint256)")),
            bytes4(keccak256("revokeAqua()"))
        ];
        for (uint256 i = 0; i < guesses.length; i++) {
            vm.prank(writer);
            (bool ok,) = address(vault).call(abi.encodeWithSelector(guesses[i], address(aqua), uint256(0)));
            assertFalse(ok, "vault exposed an allowance setter");
        }
        assertEq(vault.aquaAllowance(), type(uint256).max, "allowance unchanged");
    }

    function test_deposit_accountsAndIsOpenToAnyone() public {
        TremorMakerVault vault = createVault(writer);
        fundVault(vault, buyer1, 500e6); // a third party may capitalise a writer
        assertEq(vault.quoteBalance(), 500e6);
        assertEq(vault.freeQuote(), 500e6);
        assertEq(vault.lockedQuote(), 0);

        fundVault(vault, writer, 250e6);
        assertEq(vault.quoteBalance(), 750e6);
    }

    function test_deposit_zeroReverts() public {
        TremorMakerVault vault = createVault(writer);
        vm.prank(writer);
        vm.expectRevert(TremorMakerVault.ZeroAmount.selector);
        vault.deposit(0);
    }

    function test_withdrawFree_exactlyFreeSucceedsOneMoreReverts() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,, TremorMakerVault vault) = openMarket(p);
        buyUnits(buyer1, id, 10e18);

        uint256 free = vault.freeQuote();
        assertGt(free, 0);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(TremorMakerVault.ExceedsFree.selector, free + 1, free));
        vault.withdrawFree(free + 1, writer);

        vm.prank(writer);
        vault.withdrawFree(free, writer);
        assertEq(vault.freeQuote(), 0);
        assertEq(vault.quoteBalance(), vault.lockedQuote(), "exactly the reservation is left behind");
    }

    function test_withdrawFree_nonOwnerReverts() public {
        TremorMakerVault vault = createVault(writer);
        fundVault(vault, writer, 100e6);
        vm.prank(buyer1);
        vm.expectRevert(abi.encodeWithSelector(TremorMakerVault.NotOwner.selector, buyer1));
        vault.withdrawFree(1e6, buyer1);
    }

    function test_withdrawFree_zeroAmountOrRecipientReverts() public {
        TremorMakerVault vault = createVault(writer);
        fundVault(vault, writer, 100e6);
        vm.prank(writer);
        vm.expectRevert(TremorMakerVault.ZeroAmount.selector);
        vault.withdrawFree(0, writer);
        vm.prank(writer);
        vm.expectRevert(TremorMakerVault.ZeroRecipient.selector);
        vault.withdrawFree(1e6, address(0));
    }

    function test_controllerOnlyFunctions_rejectEveryOtherCaller() public {
        TremorMakerVault vault = createVault(writer);
        fundVault(vault, writer, 100e6);
        address[] memory callers = new address[](3);
        callers[0] = writer;
        callers[1] = buyer1;
        callers[2] = address(this);

        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        uint256[] memory amounts = new uint256[](1);

        for (uint256 i = 0; i < callers.length; i++) {
            bytes memory err = abi.encodeWithSelector(TremorMakerVault.NotController.selector, callers[i]);
            vm.prank(callers[i]);
            vm.expectRevert(err);
            vault.increaseLocked(1);
            vm.prank(callers[i]);
            vm.expectRevert(err);
            vault.decreaseLocked(1);
            vm.prank(callers[i]);
            vm.expectRevert(err);
            vault.registerAndApproveReceipt(address(usdc));
            vm.prank(callers[i]);
            vm.expectRevert(err);
            vault.shipStrategy("", tokens, amounts);
            vm.prank(callers[i]);
            vm.expectRevert(err);
            vault.dockStrategy(bytes32(0), tokens);
        }
    }

    function test_decreaseLocked_cannotUnderflow() public {
        TremorMakerVault vault = createVault(writer);
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(TremorMakerVault.ExceedsLocked.selector, 1, 0));
        vault.decreaseLocked(1);
    }

    function test_increaseLocked_beyondBalanceReverts() public {
        TremorMakerVault vault = createVault(writer);
        fundVault(vault, writer, 100e6);
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(TremorMakerVault.Undercollateralized.selector, 100e6, 100e6 + 1));
        vault.increaseLocked(100e6 + 1);
    }

    function test_noArbitraryCallSurface() public {
        TremorMakerVault vault = createVault(writer);
        fundVault(vault, writer, 100e6);
        // Anything a writer might reach for to move the vault's tokens directly.
        bytes[] memory attempts = new bytes[](6);
        attempts[0] = abi.encodeWithSignature("execute(address,bytes)", address(usdc), "");
        attempts[1] = abi.encodeWithSignature("call(address,uint256,bytes)", address(usdc), 0, "");
        attempts[2] = abi.encodeWithSignature("rescue(address,uint256)", address(usdc), 1);
        attempts[3] = abi.encodeWithSignature("rescueFunds(address,uint256)", address(usdc), 1);
        attempts[4] = abi.encodeWithSignature("transferOwnership(address)", buyer1);
        attempts[5] = abi.encodeWithSignature("upgradeTo(address)", buyer1);
        for (uint256 i = 0; i < attempts.length; i++) {
            vm.prank(writer);
            (bool ok,) = address(vault).call(attempts[i]);
            assertFalse(ok, "vault exposed an arbitrary-call surface");
        }
        assertEq(vault.quoteBalance(), 100e6);
        // No plain-ETH receiver either.
        vm.deal(writer, 1 ether);
        vm.prank(writer);
        (bool sent,) = address(vault).call{value: 1 ether}("");
        assertFalse(sent, "vault accepted ETH");
    }

    function test_protectedReceipt_cannotBeMovedOutByTheWriter() public {
        SeriesParams memory p = forwardParams();
        (, VarianceReceipt receipt, TremorMakerVault vault) = openMarket(p);
        assertTrue(vault.isProtectedReceipt(address(receipt)));
        assertEq(receipt.balanceOf(address(vault)), p.maxUnits);
        assertEq(receipt.allowance(address(vault), address(aqua)), type(uint256).max);
        assertEq(receipt.allowance(address(vault), writer), 0, "the writer has no receipt allowance");

        // The writer cannot make the vault transfer, approve or rescue its inventory.
        bytes[] memory attempts = new bytes[](3);
        attempts[0] = abi.encodeWithSignature("transferReceipt(address,address,uint256)", address(receipt), writer, 1);
        attempts[1] = abi.encodeWithSignature("rescueFunds(address,uint256)", address(receipt), 1);
        attempts[2] = abi.encodeWithSignature("approveReceipt(address,address,uint256)", address(receipt), writer, 1);
        for (uint256 i = 0; i < attempts.length; i++) {
            vm.prank(writer);
            (bool ok,) = address(vault).call(attempts[i]);
            assertFalse(ok);
        }
        assertEq(receipt.balanceOf(address(vault)), p.maxUnits, "inventory untouched");
    }

    function test_writerCannotShipOrDockAsTheVault() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,, TremorMakerVault vault) = openMarket(p);
        (,,, bytes32 issueHash, bytes32 exitHash,,) = factory.series(id);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        // Aqua keys strategies by `msg.sender`, so a writer acting in their own name can never touch the
        // vault's strategies: this dock is a no-op on the writer's own empty strategy space.
        vm.prank(writer);
        vm.expectRevert();
        aqua.dock(address(router), exitHash, tokens);

        // And both legs are still exactly as shipped.
        (uint248 exitQuote, uint8 exitCount) =
            aqua.rawBalances(address(vault), address(router), exitHash, address(usdc));
        assertEq(exitQuote, maxLiabilityOf(p));
        assertEq(exitCount, 2);
        (uint248 issueReceipt,) = aqua.rawBalances(address(vault), address(router), issueHash, address(usdc));
        assertEq(issueReceipt, 0, "ISSUE ships no quote");
    }

    function test_deployer_rejectsEveryCallerButTheController() public {
        TremorSeriesDeployer deployer = factory.DEPLOYER();
        assertEq(deployer.CONTROLLER(), address(factory));
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(TremorSeriesDeployer.NotController.selector, writer));
        deployer.deployVault(writer);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(TremorSeriesDeployer.NotController.selector, writer));
        deployer.deployReceipt(1, uint40(block.timestamp + 1), writer, 1);
    }

    function test_deployerPrediction_matchesTheFactory() public view {
        assertEq(factory.predictVault(writer), factory.DEPLOYER().predictVault(writer));
    }
}
