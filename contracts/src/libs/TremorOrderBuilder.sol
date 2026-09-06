// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "swap-vm/libs/MakerTraits.sol";
import {Salt, Deadline} from "swap-vm/instructions/Controls.sol";
import {Extruction} from "swap-vm/instructions/Extruction.sol";

import {SeriesParams, Leg} from "./SeriesParams.sol";

/// @notice THE single encoding path for a series' three Aqua-mode SwapVM programs. The bytes the vault
///   ships to Aqua and the order a taker hands the router both come from here, so
///     router.hash(order) == keccak256(abi.encode(order)) == aqua strategyHash
///   holds by construction for all three legs.
///
///     ISSUE   Salt(id,1) . Deadline(saleEnd) . Extruction(engine, [1,1,id])
///     EXIT    Salt(id,2) . Deadline(expiry)  . Extruction(engine, [1,2,id])   + postTransferIn -> receipt
///     SETTLE  Salt(id,3) .                     Extruction(engine, [1,3,id])   + postTransferIn -> receipt
///
///   Every program is built entirely from stock SwapVM instructions — `Salt` (0x02), `Deadline` (0x20) and
///   `Extruction` (0x04) — so the unmodified official `AquaSwapVMRouter` executes them. Tremor's own logic
///   lives behind the `Extruction` target (`TremorMarketEngine`) and the maker hook (`VarianceReceipt`),
///   not in a custom opcode: v1's private opcode bank required Tremor's own router, and
///   `test/RouterCompat.t.sol` is the evidence that this encoding does not.
///
///   MakerTraits: maker is the writer's vault, receiver defaults to the maker (Aqua requires it),
///   `useAquaInsteadOfSignature` is set, and tokens are sorted. Direction is enforced inside the engine by
///   token address, not by the sorted-direction flag.
///
///   SETTLE deliberately has no deadline. A holder who redeems years late still redeems.
library TremorOrderBuilder {
    /// @dev Program version encoded in the engine's immutable arguments.
    uint8 internal constant ENGINE_ARGS_VERSION = 1;

    // ------------------------------------------------------------------ legs

    function issueOrder(SeriesParams memory p, uint256 seriesId, address receipt, address vault, address engine)
        internal
        pure
        returns (ISwapVM.Order memory)
    {
        bytes memory program = bytes.concat(
            Salt.build(_salt(seriesId, Leg.ISSUE)),
            Deadline.build(p.saleEnd),
            Extruction.build(engine, engineArgs(seriesId, Leg.ISSUE))
        );
        return _order(vault, p.quoteToken, receipt, program, address(0));
    }

    function exitOrder(SeriesParams memory p, uint256 seriesId, address receipt, address vault, address engine)
        internal
        pure
        returns (ISwapVM.Order memory)
    {
        bytes memory program = bytes.concat(
            Salt.build(_salt(seriesId, Leg.EXIT)),
            Deadline.build(p.expiry),
            Extruction.build(engine, engineArgs(seriesId, Leg.EXIT))
        );
        return _order(vault, p.quoteToken, receipt, program, receipt);
    }

    /// @dev SETTLE deliberately carries no deadline: a holder who redeems years late still redeems.
    function settlementOrder(SeriesParams memory p, uint256 seriesId, address receipt, address vault, address engine)
        internal
        pure
        returns (ISwapVM.Order memory)
    {
        bytes memory program = bytes.concat(
            Salt.build(_salt(seriesId, Leg.SETTLE)), Extruction.build(engine, engineArgs(seriesId, Leg.SETTLE))
        );
        return _order(vault, p.quoteToken, receipt, program, receipt);
    }

    /// @notice Leg-dispatching wrapper, so a caller that already has a `Leg` needs one call site.
    function order(SeriesParams memory p, uint256 seriesId, address receipt, address vault, address engine, Leg leg)
        internal
        pure
        returns (ISwapVM.Order memory)
    {
        if (leg == Leg.ISSUE) return issueOrder(p, seriesId, receipt, vault, engine);
        if (leg == Leg.EXIT) return exitOrder(p, seriesId, receipt, vault, engine);
        return settlementOrder(p, seriesId, receipt, vault, engine);
    }

    // ------------------------------------------------------------------ encoding helpers

    /// @notice The engine's immutable arguments: `[uint8 version, uint8 mode, uint64 seriesId]`.
    function engineArgs(uint256 seriesId, Leg leg) internal pure returns (bytes memory) {
        return abi.encodePacked(ENGINE_ARGS_VERSION, uint8(leg), SafeCast.toUint64(seriesId));
    }

    function parseEngineArgs(bytes calldata args) internal pure returns (uint8 version, Leg leg, uint256 seriesId) {
        version = uint8(args[0]);
        leg = Leg(uint8(args[1]));
        seriesId = uint64(bytes8(args[2:10]));
    }

    /// @notice Exact bytes for `aqua.ship` — must stay the only encoding path.
    function shipBytes(ISwapVM.Order memory order) internal pure returns (bytes memory) {
        return abi.encode(order);
    }

    function orderHash(ISwapVM.Order memory order) internal pure returns (bytes32) {
        return keccak256(abi.encode(order));
    }

    /// @notice Tokens in MakerTraits order (tokenA < tokenB).
    function sortedTokens(address quoteToken, address receipt) internal pure returns (address[] memory tokens) {
        tokens = new address[](2);
        (tokens[0], tokens[1]) = quoteToken < receipt ? (quoteToken, receipt) : (receipt, quoteToken);
    }

    /// @notice Aqua ship amounts for a leg, in `sortedTokens` order.
    /// @dev ISSUE is shipped with the whole receipt inventory and no quote. EXIT and SETTLE are each
    ///   shipped with the maximum liability in quote virtual balance and no receipts. Shipping is virtual
    ///   accounting, not a transfer, so the two burn legs do not require two reserves: the engine bounds
    ///   every payout by the liability the burn actually releases, and unsold receipts can never leave the
    ///   vault, so the surplus virtual allowance is unreachable.
    function shipAmounts(SeriesParams memory p, address receipt, Leg leg, uint256 maxLiability)
        internal
        pure
        returns (uint256[] memory amounts)
    {
        address[] memory tokens = sortedTokens(p.quoteToken, receipt);
        amounts = new uint256[](2);
        for (uint256 i = 0; i < 2; i++) {
            if (leg == Leg.ISSUE) {
                if (tokens[i] == receipt) amounts[i] = p.maxUnits;
            } else if (tokens[i] == p.quoteToken) {
                amounts[i] = maxLiability;
            }
        }
    }

    // ------------------------------------------------------------------ internals

    /// @dev `Salt` carries the series id and leg so two legs of one series, and the same leg of two series,
    ///   can never collide on an Aqua strategy hash even if every other byte matched.
    function _salt(uint256 seriesId, Leg leg) private pure returns (bytes memory) {
        return abi.encodePacked(SafeCast.toUint64(seriesId), uint8(leg));
    }

    /// @param postTransferInHook hook target run after tokenIn reaches the maker (0 = no hook).
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
