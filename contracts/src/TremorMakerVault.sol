// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";

import {ITremorMakerVault} from "./interfaces/ITremorMakerVault.sol";

/// @notice The Aqua maker for every one of a writer's series. Deployed deterministically, once per
///   (writer, quote token), by `VarianceSeriesFactory`, and never upgradeable.
///
///   Aqua is an allowance layer, not an escrow: it moves a maker's own tokens. In Tremor v1 the maker was
///   the writer's wallet, so a writer could sell receipts and then move the USDC, leaving holders with an
///   unsecured claim. This contract is the fix. The collateral lives here, and the only ways out are
///
///     - `AQUA.pull` for a strategy the controller shipped, i.e. an EXIT or SETTLE fill that simultaneously
///       burns the receipt it paid for, and
///     - `withdrawFree`, which the owner may call for at most `balance - lockedQuote`.
///
///   What the owner deliberately cannot do:
///
///     - reduce the Aqua allowance. It is set to `type(uint256).max` in the constructor and there is no
///       code path that approves the quote token again.
///     - dock a strategy. `dockStrategy` is controller-only, and the controller refuses to dock EXIT or
///       SETTLE while any receipt is outstanding.
///     - move unsold receipt inventory. Receipts are only ever approved to Aqua, and this contract has no
///       transfer, generic-call, delegatecall or rescue surface at all.
///     - touch reserved collateral. Every mutation ends by asserting `balance >= lockedQuote`.
///
///   There is no owner change, no pause, no proxy, no emergency custodian and no way for the writer to
///   stand between a holder and a settlement.
contract TremorMakerVault is ITremorMakerVault {
    using SafeERC20 for IERC20;

    /// @dev Caller is not the vault owner.
    error NotOwner(address caller);
    /// @dev Caller is not the controller that deployed this vault.
    error NotController(address caller);
    /// @dev Zero-amount deposit or withdrawal.
    error ZeroAmount();
    /// @dev Withdrawal target is the zero address.
    error ZeroRecipient();
    /// @dev Requested withdrawal exceeds unreserved collateral.
    error ExceedsFree(uint256 requested, uint256 free);
    /// @dev Unlock request exceeds what is locked.
    error ExceedsLocked(uint256 requested, uint256 locked);
    /// @dev A mutation would leave reserved collateral unbacked.
    error Undercollateralized(uint256 balance, uint256 locked);
    /// @dev Constructor wiring is incomplete or points at a codeless address.
    error BadVaultConfiguration();

    event Deposited(address indexed payer, uint256 amount, uint256 newBalance, uint256 lockedBalance);
    event FreeWithdrawn(address indexed recipient, uint256 amount, uint256 newBalance, uint256 lockedBalance);
    event LockedIncreased(uint256 amount, uint256 lockedBalance);
    event LockedDecreased(uint256 amount, uint256 lockedBalance);
    event ReceiptRegistered(address indexed receipt);
    event StrategyShipped(bytes32 indexed strategyHash);
    event StrategyDocked(bytes32 indexed strategyHash);

    address public immutable OWNER;
    address public immutable QUOTE_TOKEN;
    address public immutable AQUA;
    address public immutable ROUTER;
    address public immutable CONTROLLER;

    /// @notice Quote-token collateral reserved for receipts already sold. Never withdrawable by the owner.
    uint256 public lockedQuote;

    mapping(address receipt => bool) internal _protectedReceipts;

    constructor(address owner, address quoteToken, address aqua, address router, address controller) {
        require(
            owner != address(0) && quoteToken.code.length > 0 && aqua.code.length > 0 && router.code.length > 0
                && controller != address(0),
            BadVaultConfiguration()
        );
        OWNER = owner;
        QUOTE_TOKEN = quoteToken;
        AQUA = aqua;
        ROUTER = router;
        CONTROLLER = controller;
        // The one and only approval of the quote token, granted here and never revocable: no other function
        // in this contract calls `approve` on QUOTE_TOKEN.
        IERC20(quoteToken).forceApprove(aqua, type(uint256).max);
    }

    modifier onlyOwner() {
        require(msg.sender == OWNER, NotOwner(msg.sender));
        _;
    }

    modifier onlyController() {
        require(msg.sender == CONTROLLER, NotController(msg.sender));
        _;
    }

    // ------------------------------------------------------------------ views

    function quoteBalance() public view returns (uint256) {
        return IERC20(QUOTE_TOKEN).balanceOf(address(this));
    }

    /// @notice Collateral the owner may withdraw right now.
    function freeQuote() public view returns (uint256) {
        uint256 balance = quoteBalance();
        uint256 locked = lockedQuote;
        return balance > locked ? balance - locked : 0;
    }

    function aquaAllowance() external view returns (uint256) {
        return IERC20(QUOTE_TOKEN).allowance(address(this), AQUA);
    }

    function isProtectedReceipt(address receipt) external view returns (bool) {
        return _protectedReceipts[receipt];
    }

    // ------------------------------------------------------------------ collateral

    /// @notice Fund the vault. Open to anyone so a writer can be capitalised by a third party.
    function deposit(uint256 amount) external {
        require(amount > 0, ZeroAmount());
        IERC20(QUOTE_TOKEN).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount, quoteBalance(), lockedQuote);
    }

    /// @notice Withdraw collateral that is not reserved for outstanding receipts.
    function withdrawFree(uint256 amount, address recipient) external onlyOwner {
        require(amount > 0, ZeroAmount());
        require(recipient != address(0), ZeroRecipient());
        uint256 free = freeQuote();
        require(amount <= free, ExceedsFree(amount, free));
        IERC20(QUOTE_TOKEN).safeTransfer(recipient, amount);
        _assertSolvent();
        emit FreeWithdrawn(recipient, amount, quoteBalance(), lockedQuote);
    }

    // ------------------------------------------------------------------ controller-only

    function increaseLocked(uint256 amount) external onlyController {
        lockedQuote += amount;
        _assertSolvent();
        emit LockedIncreased(amount, lockedQuote);
    }

    function decreaseLocked(uint256 amount) external onlyController {
        uint256 locked = lockedQuote;
        require(amount <= locked, ExceedsLocked(amount, locked));
        lockedQuote = locked - amount;
        _assertSolvent();
        emit LockedDecreased(amount, lockedQuote);
    }

    /// @notice Marks a series receipt as vault-owned inventory and approves Aqua to move it.
    /// @dev Only ever called by the controller, immediately after it deployed the receipt, so a writer
    ///   cannot register an arbitrary token in order to obtain an allowance for it.
    function registerAndApproveReceipt(address receipt) external onlyController {
        _protectedReceipts[receipt] = true;
        IERC20(receipt).forceApprove(AQUA, type(uint256).max);
        emit ReceiptRegistered(receipt);
    }

    function shipStrategy(bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        external
        onlyController
        returns (bytes32 strategyHash)
    {
        strategyHash = IAqua(AQUA).ship(ROUTER, strategy, tokens, amounts);
        emit StrategyShipped(strategyHash);
    }

    function dockStrategy(bytes32 strategyHash, address[] calldata tokens) external onlyController {
        IAqua(AQUA).dock(ROUTER, strategyHash, tokens);
        emit StrategyDocked(strategyHash);
    }

    // ------------------------------------------------------------------ internals

    function _assertSolvent() internal view {
        uint256 balance = quoteBalance();
        uint256 locked = lockedQuote;
        require(balance >= locked, Undercollateralized(balance, locked));
    }
}
