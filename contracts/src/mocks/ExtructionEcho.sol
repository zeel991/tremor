// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SwapQuery, SwapRegisters} from "swap-vm/libs/VM.sol";
import {IExtruction} from "swap-vm/instructions/Extruction.sol";

/// @notice Minimal `IExtruction` target used only by the router compatibility gate
///   (`test/RouterCompat.t.sol`). It prices deterministically — `amountOut = amountIn * rateNum / rateDen`
///   for exact-in and the inverse for exact-out — records that it was reached, and consumes zero taker
///   argument bytes. Identical arithmetic in quote and swap; the only difference between the two modes is
///   the recorded call trace, written only when `isStaticContext == false`, so a test can prove the router
///   dispatched the non-view branch. Nothing is written in a static context: `quote` runs under
///   `staticcall`, and any storage write there aborts the whole quote.
contract ExtructionEcho is IExtruction {
    error EchoZeroDenominator();

    uint256 public calls;
    bytes32 public lastOrderHash;
    address public lastMaker;
    address public lastTaker;

    uint256 public immutable RATE_NUM;
    uint256 public immutable RATE_DEN;

    constructor(uint256 rateNum, uint256 rateDen) {
        require(rateDen > 0, EchoZeroDenominator());
        RATE_NUM = rateNum;
        RATE_DEN = rateDen;
    }

    function extruction(
        bool isStaticContext,
        uint256 nextPC,
        SwapQuery calldata query,
        SwapRegisters calldata swap,
        bytes calldata,
        bytes calldata
    ) external returns (uint256 updatedNextPC, uint256 choppedLength, SwapRegisters memory updatedSwap) {
        updatedSwap = swap;
        if (query.isExactIn) {
            updatedSwap.amountOut = swap.amountIn * RATE_NUM / RATE_DEN;
        } else {
            updatedSwap.amountIn = (swap.amountOut * RATE_DEN + RATE_NUM - 1) / RATE_NUM;
        }
        if (!isStaticContext) {
            calls += 1;
            lastOrderHash = query.orderHash;
            lastMaker = query.maker;
            lastTaker = query.taker;
        }
        return (nextPC, 0, updatedSwap);
    }
}
