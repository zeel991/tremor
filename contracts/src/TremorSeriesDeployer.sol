// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {TremorMakerVault} from "./TremorMakerVault.sol";
import {VarianceReceipt} from "./tokens/VarianceReceipt.sol";

/// @notice Holds the vault and receipt creation code on behalf of `VarianceSeriesFactory`.
///
///   This contract exists for one reason: EIP-170. The controller has to embed the full creation code of
///   both children, and together with the pricing, order-building and lifecycle logic that pushes it over
///   the 24,576-byte runtime limit. Splitting the constructor bytecode out keeps the controller deployable
///   without weakening anything: the deployer is created by the controller's own constructor, records it as
///   an immutable, and refuses every caller but that one address. It has no owner, no upgrade path and no
///   state.
///
///   Vault addresses stay deterministic and independently checkable: CREATE2 from this address with salt
///   `keccak256(writer, quoteToken)` and the vault's fixed constructor arguments, which `predictVault`
///   recomputes rather than remembering.
contract TremorSeriesDeployer {
    /// @dev Caller is not the controller that deployed this contract.
    error NotController(address caller);
    /// @dev Constructor wiring is incomplete or points at a codeless address.
    error BadDeployerConfiguration();

    address public immutable CONTROLLER;
    address public immutable QUOTE_TOKEN;
    address public immutable AQUA;
    address public immutable ROUTER;

    constructor(address quoteToken, address aqua, address router) {
        require(
            quoteToken.code.length > 0 && aqua.code.length > 0 && router.code.length > 0, BadDeployerConfiguration()
        );
        CONTROLLER = msg.sender;
        QUOTE_TOKEN = quoteToken;
        AQUA = aqua;
        ROUTER = router;
    }

    modifier onlyController() {
        require(msg.sender == CONTROLLER, NotController(msg.sender));
        _;
    }

    /// @notice Address the vault for `writer` has, or will have. Pure function of this contract's address.
    function predictVault(address writer) public view returns (address) {
        return Create2.computeAddress(_salt(writer), keccak256(_vaultInitCode(writer)), address(this));
    }

    function deployVault(address writer) external onlyController returns (address vault) {
        vault = address(new TremorMakerVault{salt: _salt(writer)}(writer, QUOTE_TOKEN, AQUA, ROUTER, CONTROLLER));
    }

    function deployReceipt(uint256 seriesId, uint40 expiry, address vault, uint256 supply)
        external
        onlyController
        returns (address receipt)
    {
        receipt = address(new VarianceReceipt(seriesId, expiry, vault, supply, ROUTER, CONTROLLER));
    }

    function _salt(address writer) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(writer, QUOTE_TOKEN));
    }

    function _vaultInitCode(address writer) internal view returns (bytes memory) {
        return abi.encodePacked(
            type(TremorMakerVault).creationCode, abi.encode(writer, QUOTE_TOKEN, AQUA, ROUTER, CONTROLLER)
        );
    }
}
