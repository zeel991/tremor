// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The writer's protected Aqua maker. See `TremorMakerVault` for the enforcement notes.
interface ITremorMakerVault {
    function OWNER() external view returns (address);
    function QUOTE_TOKEN() external view returns (address);
    function AQUA() external view returns (address);
    function ROUTER() external view returns (address);
    function CONTROLLER() external view returns (address);

    function lockedQuote() external view returns (uint256);
    function quoteBalance() external view returns (uint256);
    function freeQuote() external view returns (uint256);
    function aquaAllowance() external view returns (uint256);
    function isProtectedReceipt(address receipt) external view returns (bool);

    function deposit(uint256 amount) external;
    function withdrawFree(uint256 amount, address recipient) external;

    function increaseLocked(uint256 amount) external;
    function decreaseLocked(uint256 amount) external;
    function registerAndApproveReceipt(address receipt) external;
    function shipStrategy(bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        external
        returns (bytes32 strategyHash);
    function dockStrategy(bytes32 strategyHash, address[] calldata tokens) external;
}
