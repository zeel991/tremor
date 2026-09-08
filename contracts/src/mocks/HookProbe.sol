// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Records `IMakerHooks.postTransferIn` calls. Used by the router compatibility gate to prove the
///   deployed router invokes maker post-transfer-in hooks with the exact signature `VarianceReceipt` relies
///   on for its burn.
contract HookProbe {
    uint256 public calls;
    address public lastMaker;
    address public lastTaker;
    address public lastTokenIn;
    uint256 public lastAmountIn;
    uint256 public lastFeeIn;
    bytes32 public lastOrderHash;
    address public lastCaller;

    function postTransferIn(
        address maker,
        address taker,
        address tokenIn,
        address, /* tokenOut */
        uint256 amountIn,
        uint256, /* amountOut */
        uint256 feeIn,
        bytes32 orderHash,
        bytes calldata, /* makerData */
        bytes calldata /* takerData */
    ) external {
        calls += 1;
        lastCaller = msg.sender;
        lastMaker = maker;
        lastTaker = taker;
        lastTokenIn = tokenIn;
        lastAmountIn = amountIn;
        lastFeeIn = feeIn;
        lastOrderHash = orderHash;
    }
}
