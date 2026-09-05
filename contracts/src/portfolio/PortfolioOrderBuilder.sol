// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "swap-vm/libs/MakerTraits.sol";
import {Salt, Deadline} from "swap-vm/instructions/Controls.sol";
import {Extruction} from "swap-vm/instructions/Extruction.sol";

/// @notice THE single encoding path for a portfolio risk group's six Aqua-mode SwapVM programs — the same
///   stock-instruction discipline as `TremorOrderBuilder`, one order per (side, leg):
///
///     ISSUE_HIGH   Salt(g,1) . Deadline(saleEnd) . Extruction(market, [2,1,g])
///     ISSUE_CALM   Salt(g,2) . Deadline(saleEnd) . Extruction(market, [2,2,g])
///     EXIT_HIGH    Salt(g,3) . Deadline(expiry)  . Extruction(market, [2,3,g])   + postTransferIn -> HIGH receipt
///     EXIT_CALM    Salt(g,4) . Deadline(expiry)  . Extruction(market, [2,4,g])   + postTransferIn -> CALM receipt
///     SETTLE_HIGH  Salt(g,5) .                     Extruction(market, [2,5,g])   + postTransferIn -> HIGH receipt
///     SETTLE_CALM  Salt(g,6) .                     Extruction(market, [2,6,g])   + postTransferIn -> CALM receipt
///
///   All six run on the unmodified official `AquaSwapVMRouter`. The args version is 2, so a v1 series
///   program can never be interpreted as a portfolio program or vice versa.
library PortfolioOrderBuilder {
    /// @dev Program-arguments version for portfolio groups. v1 is the single-claim series engine.
    uint8 internal constant ARGS_VERSION = 2;

    /// @notice One of the six strategies of a group. Order matters: it is the on-wire mode byte.
    enum PMode {
        NONE,
        ISSUE_HIGH,
        ISSUE_CALM,
        EXIT_HIGH,
        EXIT_CALM,
        SETTLE_HIGH,
        SETTLE_CALM
    }

    function isIssue(PMode m) internal pure returns (bool) {
        return m == PMode.ISSUE_HIGH || m == PMode.ISSUE_CALM;
    }

    function isExit(PMode m) internal pure returns (bool) {
        return m == PMode.EXIT_HIGH || m == PMode.EXIT_CALM;
    }

    function isSettle(PMode m) internal pure returns (bool) {
        return m == PMode.SETTLE_HIGH || m == PMode.SETTLE_CALM;
    }

    /// @notice true when the mode's claim side is HIGH.
    function isHigh(PMode m) internal pure returns (bool) {
        return m == PMode.ISSUE_HIGH || m == PMode.EXIT_HIGH || m == PMode.SETTLE_HIGH;
    }

    function order(
        PMode mode,
        uint256 groupId,
        address quoteToken,
        address receipt,
        address vault,
        address market,
        uint40 saleEnd,
        uint40 expiry
    ) internal pure returns (ISwapVM.Order memory) {
        bytes memory program;
        address hook;
        if (isIssue(mode)) {
            program = bytes.concat(
                Salt.build(_salt(groupId, mode)), Deadline.build(saleEnd), Extruction.build(market, args(groupId, mode))
            );
        } else if (isExit(mode)) {
            program = bytes.concat(
                Salt.build(_salt(groupId, mode)), Deadline.build(expiry), Extruction.build(market, args(groupId, mode))
            );
            hook = receipt;
        } else {
            // SETTLE deliberately carries no deadline: a holder who redeems years late still redeems.
            program = bytes.concat(Salt.build(_salt(groupId, mode)), Extruction.build(market, args(groupId, mode)));
            hook = receipt;
        }
        return _order(vault, quoteToken, receipt, program, hook);
    }

    /// @notice The market's immutable arguments: `[uint8 version, uint8 mode, uint64 groupId]`.
    function args(uint256 groupId, PMode mode) internal pure returns (bytes memory) {
        return abi.encodePacked(ARGS_VERSION, uint8(mode), SafeCast.toUint64(groupId));
    }

    function parseArgs(bytes calldata a) internal pure returns (uint8 version, PMode mode, uint256 groupId) {
        version = uint8(a[0]);
        mode = PMode(uint8(a[1]));
        groupId = uint64(bytes8(a[2:10]));
    }

    function shipBytes(ISwapVM.Order memory o) internal pure returns (bytes memory) {
        return abi.encode(o);
    }

    function orderHash(ISwapVM.Order memory o) internal pure returns (bytes32) {
        return keccak256(abi.encode(o));
    }

    function sortedTokens(address quoteToken, address receipt) internal pure returns (address[] memory tokens) {
        tokens = new address[](2);
        (tokens[0], tokens[1]) = quoteToken < receipt ? (quoteToken, receipt) : (receipt, quoteToken);
    }

    /// @notice Aqua ship amounts: ISSUE ships the side's whole receipt inventory; EXIT and SETTLE each ship
    ///   the side's standalone maximum liability as quote virtual balance. Virtual accounting only — the
    ///   market bounds every payout by the reserve the burn actually releases plus the locked exit buffer.
    function shipAmounts(PMode mode, address quoteToken, address receipt, uint256 maxUnits, uint256 maxLiability)
        internal
        pure
        returns (uint256[] memory amounts)
    {
        address[] memory tokens = sortedTokens(quoteToken, receipt);
        amounts = new uint256[](2);
        for (uint256 i = 0; i < 2; i++) {
            if (isIssue(mode)) {
                if (tokens[i] == receipt) amounts[i] = maxUnits;
            } else if (tokens[i] == quoteToken) {
                amounts[i] = maxLiability;
            }
        }
    }

    function _salt(uint256 groupId, PMode mode) private pure returns (bytes memory) {
        return abi.encodePacked(SafeCast.toUint64(groupId), uint8(mode));
    }

    function _order(address maker, address t1, address t2, bytes memory program, address postTransferInHook)
        private
        pure
        returns (ISwapVM.Order memory)
    {
        (address tokenA, address tokenB) = t1 < t2 ? (t1, t2) : (t2, t1);
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
                hasPostTransferInHook: postTransferInHook != address(0),
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: postTransferInHook,
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program
            })
        );
    }
}
