// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TremorTestBase} from "./base/TremorTestBase.sol";
import {SeriesParams, Leg} from "../src/libs/SeriesParams.sol";
import {VarianceReceipt} from "../src/tokens/VarianceReceipt.sol";
import {TremorMakerVault} from "../src/TremorMakerVault.sol";
import {TremorLens} from "../src/TremorLens.sol";

/// @notice The whole product in one test: fund a protected vault, sell receipts, exit part of the position
///   before expiry, checkpoint the window permissionlessly, finalize, redeem the rest, and close. Every
///   transition asserts vault solvency, receipt supply and the liability ledger, so a regression anywhere
///   in the three legs shows up here first.
contract LifecycleTest is TremorTestBase {
    function test_lifecycle_issueExitCheckpointFinalizeRedeemClose() public {
        SeriesParams memory p = forwardParams();
        (uint256 id, VarianceReceipt receipt, TremorMakerVault vault) = openMarket(p);

        // ---- creation reserves nothing
        assertEq(vault.lockedQuote(), 0, "no collateral locked before a sale");
        assertEq(vault.freeQuote(), maxLiabilityOf(p), "all collateral free before a sale");
        assertEq(receipt.totalSupply(), p.maxUnits);
        assertEq(receipt.balanceOf(address(vault)), p.maxUnits, "inventory minted to the vault only");
        assertEq(IERC20(address(usdc)).allowance(address(vault), address(aqua)), type(uint256).max);

        // ---- buy 10 units
        uint256 premium = buyUnits(buyer1, id, 10e18);
        assertEq(receipt.balanceOf(buyer1), 10e18);
        assertGt(premium, 0, "premium charged");
        assertEq(usdc.balanceOf(address(vault)), maxLiabilityOf(p) + premium, "premium reached the vault");
        uint256 lockedAfterIssue = vault.lockedQuote();
        assertEq(lockedAfterIssue, expectedMaxLiability(10e18, p.unitNotional, p.capVariance), "sold units only");
        assertGe(usdc.balanceOf(address(vault)), lockedAfterIssue, "solvent after issuance");

        // ---- the writer cannot reach the reserved collateral
        uint256 free = vault.freeQuote();
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(TremorMakerVault.ExceedsFree.selector, free + 1, free));
        vault.withdrawFree(free + 1, writer);

        // ---- exit 4 of the 10 units before expiry
        warpWithFeed(block.timestamp + 1 days);
        checkpointAll(id, 32);
        (uint256 quotedUnits, uint256 quotedOut) = lens.quoteExitExactIn(id, 4e18);
        assertEq(quotedUnits, 4e18);
        uint256 buyerBefore = usdc.balanceOf(buyer1);
        uint256 exitProceeds = exitUnits(buyer1, id, 4e18);
        assertEq(exitProceeds, quotedOut, "Lens exit quote equals the swap");
        assertEq(usdc.balanceOf(buyer1), buyerBefore + exitProceeds);
        assertEq(receipt.balanceOf(buyer1), 6e18, "exited units left the holder");
        assertEq(receipt.totalSupply(), p.maxUnits - 4e18, "exited units were burned, not recycled");
        assertEq(vault.lockedQuote(), expectedMaxLiability(6e18, p.unitNotional, p.capVariance), "liability repriced");
        assertGe(usdc.balanceOf(address(vault)), vault.lockedQuote(), "solvent after exit");

        // ---- checkpoint the rest of the window in bounded, permissionless calls
        warpWithFeed(uint256(p.expiry) + 1);
        uint256 calls = checkpointAll(id, 32);
        assertGt(calls, 0, "window needed checkpointing");
        (uint256 stored, uint256 available, uint256 total) = accumulator.progress(id);
        assertEq(stored, total, "whole window stored");
        assertEq(available, total);

        // ---- finalize from an account with no privileges at all
        uint256 lockedBeforeFinalize = vault.lockedQuote();
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        uint256 finalVariance = accumulator.finalize(id);
        assertGt(finalVariance, 0);
        TremorLens.SeriesState memory st = lens.state(id);
        assertEq(uint8(st.status), uint8(TremorLens.Status.FINALIZED));
        assertLe(vault.lockedQuote(), lockedBeforeFinalize, "cap surplus released at finalization");
        assertEq(
            vault.lockedQuote(),
            _ceilDiv(6e18 * st.payoutPerUnit, WAD),
            "final liability uses the final payout, not the cap"
        );

        // ---- redeem the remaining 6 units
        (uint256 rUnits, uint256 rOut) = lens.quoteSettleExactIn(id, 6e18);
        assertEq(rUnits, 6e18);
        uint256 redeemed = redeemUnits(buyer1, id, 6e18);
        assertEq(redeemed, rOut, "Lens redeem quote equals the swap");
        assertEq(redeemed, 6e18 * st.payoutPerUnit / WAD);
        assertEq(receipt.balanceOf(buyer1), 0);
        assertEq(receipt.totalSupply(), p.maxUnits - 10e18, "every consumed receipt burned");
        assertEq(vault.lockedQuote(), 0, "liability fully released");
        assertGe(usdc.balanceOf(address(vault)), 0);

        // ---- close: unsold inventory burns, strategies dock, residual releases
        vm.prank(writer);
        factory.stopIssuance(id);
        factory.closeSeries(id);
        assertEq(receipt.totalSupply(), 0, "unsold inventory burned at close");
        assertEq(vault.lockedQuote(), 0);
        st = lens.state(id);
        assertEq(uint8(st.status), uint8(TremorLens.Status.CLOSED));
        assertFalse(st.legs.issueLegActive);
        assertFalse(st.legs.exitLegActive);
        assertFalse(st.legs.settleLegActive);

        // ---- the writer can now withdraw everything, and that is the only thing left to do
        uint256 balance = usdc.balanceOf(address(vault));
        vm.prank(writer);
        vault.withdrawFree(balance, writer);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }
}
