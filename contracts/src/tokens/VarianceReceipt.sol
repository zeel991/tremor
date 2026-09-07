// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {DateLib} from "../libs/DateLib.sol";
import {ITremorController} from "../interfaces/ITremorController.sol";

/// @notice One series' capped realized-variance receipt. 1e18 units pay
///   `unitNotional * min(finalRealizedVariance, capVariance) / 1e18` quote-token base units at settlement.
///
///   The whole supply — `maxUnits` — is minted to the writer's vault at creation and the supply only ever
///   moves DOWN. That is the mechanism which lets the EXIT and SETTLE strategies share one real reserve:
///
///     EXIT   receipt -> USDC before expiry  (Aqua pushes the receipt into the vault)
///     SETTLE receipt -> USDC after finalization (same)
///
///   Both legs end with the receipt back in the vault and the router calling `postTransferIn` here, which
///   burns exactly what arrived and tells the controller to release exactly the matching liability. A unit
///   can therefore be exited or settled, never both, and never twice — enforced by supply itself rather
///   than by bookkeeping a writer might be able to confuse.
///
///   `msg.sender == ROUTER` plus `tokenIn == address(this)` is the whole authorization for the hook: being
///   called means the router just executed an order that named this token as its post-transfer-in target,
///   and the controller then independently checks that the order hash really is one of this series' two
///   burn legs. An impostor receipt cannot release liability (the controller checks the caller), and a
///   genuine receipt presented against the wrong leg's hash cannot either (the controller checks the leg).
contract VarianceReceipt is ERC20 {
    /// @dev Hook caller is not the router this receipt was created for.
    error NotRouter(address caller);
    /// @dev Caller is not this series' controller.
    error NotController(address caller);
    /// @dev Hook fired for a swap whose tokenIn is not this receipt.
    error WrongTokenIn(address tokenIn);
    /// @dev SwapVM charged a maker-side fee on the receipt leg; the burn would not match the fill.
    error ReceiptFeeUnsupported(uint256 feeIn);
    /// @dev Hook fired for a maker that is not this series' vault.
    error WrongMaker(address maker);

    address public immutable CONTROLLER;
    address public immutable ROUTER;
    address public immutable VAULT;
    uint256 public immutable SERIES_ID;
    uint40 public immutable EXPIRY;

    constructor(uint256 seriesId, uint40 expiry, address vault, uint256 supply, address router, address controller)
        ERC20(
            string.concat("Tremor ETH Variance ", DateLib.iso(expiry)),
            string.concat("tVAR-ETH-", DateLib.yymmdd(expiry))
        )
    {
        CONTROLLER = controller;
        ROUTER = router;
        VAULT = vault;
        SERIES_ID = seriesId;
        EXPIRY = expiry;
        _mint(vault, supply);
    }

    /// @notice `IMakerHooks.postTransferIn` — burns the receipts an EXIT or SETTLE fill just returned to the
    ///   vault, then hands the controller the burned units and the quote amount that was paid for them.
    /// @dev SwapVM calls this from `_transferIn`, after `AQUA.push` has moved `amountIn - feeIn` receipts
    ///   into the maker's balance, so that balance always covers the burn. The v1 signature is preserved
    ///   verbatim and is pinned against `IMakerHooks` by `test_postTransferIn_matchesMakerHooksSelector`;
    ///   the interface is not inherited so the three unused hooks stay off this token.
    function postTransferIn(
        address maker,
        address taker,
        address tokenIn,
        address, /* tokenOut */
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeIn,
        bytes32 orderHash,
        bytes calldata, /* makerData */
        bytes calldata /* takerData */
    ) external {
        require(msg.sender == ROUTER, NotRouter(msg.sender));
        require(tokenIn == address(this), WrongTokenIn(tokenIn));
        require(maker == VAULT, WrongMaker(maker));
        require(feeIn == 0, ReceiptFeeUnsupported(feeIn));
        _burn(maker, amountIn);
        ITremorController(CONTROLLER).onBurn(orderHash, taker, amountIn, amountOut);
    }

    /// @notice Burns a holder's worthless receipts so a zero-payout series can be closed.
    /// @dev Controller-only, and the controller only reaches it once the series is finalized at a payout of
    ///   zero — a state SwapVM cannot express, because it rejects a swap with `amountOut == 0`.
    function burnFromHolder(address holder, uint256 units) external {
        require(msg.sender == CONTROLLER, NotController(msg.sender));
        _burn(holder, units);
    }

    /// @notice Burns receipts that were never sold, when the series closes.
    function burnUnsoldInventory(uint256 units) external {
        require(msg.sender == CONTROLLER, NotController(msg.sender));
        _burn(VAULT, units);
    }
}
