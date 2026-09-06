// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";

/// @notice One Chainlink "phase" aggregator: sequential round ids starting at 1.
///   Unknown rounds either revert "No data present" (FluxAggregator behaviour) or return zeros
///   (OCR aggregators on Base do this) depending on `zerosForMissing`.
contract MockPhaseAggregator {
    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    address public immutable PROXY;
    uint64 public latestRound;
    bool public zerosForMissing;
    mapping(uint64 => Round) internal _rounds;

    modifier onlyProxy() {
        require(msg.sender == PROXY, "only proxy");
        _;
    }

    constructor() {
        PROXY = msg.sender;
    }

    function push(int256 answer, uint256 updatedAt) external onlyProxy returns (uint64 id) {
        id = ++latestRound;
        _rounds[id] = Round(answer, updatedAt);
    }

    function setAnswer(uint64 id, int256 answer) external onlyProxy {
        _rounds[id].answer = answer;
    }

    function setZerosForMissing(bool v) external onlyProxy {
        zerosForMissing = v;
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = _rounds[uint64(roundId)];
        if (r.updatedAt == 0) {
            if (zerosForMissing) return (roundId, 0, 0, 0, roundId);
            revert("No data present");
        }
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }
}

/// @notice Phase-aware Chainlink proxy mock: roundId = (phaseId << 64) | aggregatorRoundId,
///   distinct sub-aggregator contract per phase, reverts "No data present" for unknown phases /
///   rounds exactly like the real EACAggregatorProxy.
contract MockAggregator is IAggregatorV3 {
    uint8 internal immutable _decimals;
    uint16 public phaseId;
    mapping(uint16 => MockPhaseAggregator) internal _phases;

    constructor(uint8 decimals_) {
        _decimals = decimals_;
        setPhase(1);
    }

    // ---- admin (tests / scripts)

    /// @notice Switch the proxy to phase `p` (creating its aggregator if new). Monotone like the real proxy.
    function setPhase(uint16 p) public {
        require(p >= phaseId && p > 0, "phase must not decrease");
        if (address(_phases[p]) == address(0)) _phases[p] = new MockPhaseAggregator();
        phaseId = p;
    }

    /// @notice Append a round to the CURRENT phase. Returns the proxy-level roundId.
    function pushRound(int256 answer, uint256 updatedAt) external returns (uint80 roundId) {
        uint64 id = _phases[phaseId].push(answer, updatedAt);
        roundId = _wrap(phaseId, id);
    }

    function pushRounds(int256[] calldata answers, uint256[] calldata updatedAts) external {
        require(answers.length == updatedAts.length, "len");
        for (uint256 i = 0; i < answers.length; i++) {
            _phases[phaseId].push(answers[i], updatedAts[i]);
        }
    }

    /// @notice Tamper with a historical answer (used to prove settlement reads its cache).
    function setRoundAnswer(uint16 phase, uint64 round, int256 answer) external {
        _phases[phase].setAnswer(round, answer);
    }

    /// @notice OCR-style zeros for missing rounds (vs revert) on a given phase.
    function setZerosForMissing(uint16 phase, bool v) external {
        _phases[phase].setZerosForMissing(v);
    }

    // ---- IAggregatorV3

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external pure returns (string memory) {
        return "MOCK ETH / USD";
    }

    function version() external pure returns (uint256) {
        return 4;
    }

    function phaseAggregators(uint16 p) external view returns (address) {
        return address(_phases[p]);
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        MockPhaseAggregator agg = _phases[phaseId];
        uint64 latest = agg.latestRound();
        require(latest > 0, "No data present");
        return getRoundData(_wrap(phaseId, latest));
    }

    function getRoundData(uint80 roundId_)
        public
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint16 p = uint16(roundId_ >> 64);
        MockPhaseAggregator agg = _phases[p];
        require(address(agg) != address(0), "No data present"); // real proxy: call to address(0) reverts
        (uint80 rid, int256 a, uint256 s, uint256 u, uint80 air) = agg.getRoundData(uint80(uint64(roundId_)));
        return (_wrap(p, uint64(rid)), a, s, u, _wrap(p, uint64(air)));
    }

    function _wrap(uint16 p, uint64 id) internal pure returns (uint80) {
        return uint80((uint256(p) << 64) | id);
    }
}
