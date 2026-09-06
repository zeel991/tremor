// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Chainlink AggregatorV3 proxy surface used by Tremor (incl. phase accessors of the proxy).
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function version() external view returns (uint256);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function getRoundData(uint80 _roundId)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function phaseId() external view returns (uint16);
    function phaseAggregators(uint16 phaseId) external view returns (address);
}
