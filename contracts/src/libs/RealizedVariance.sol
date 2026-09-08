// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FixedPointMathLib} from "solady/src/utils/FixedPointMathLib.sol";

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";

/// @notice Realized variance straight from a Chainlink proxy's own round history (ARCHITECTURE.md §1, §3.3).
///
///   Sample prices: P_i = answer of the latest round with updatedAt <= t_i, t_i = start + i*interval.
///   "Latest" is resolved phase-first: the highest phase whose FIRST round is <= t_i wins, then the
///   largest round in that phase with updatedAt <= t_i (updatedAt is monotone within a phase).
///   RV = sum(ln(P_i/P_{i-1})^2) * 31_536_000 / (end - start), all WAD.
///
///   Round existence: a getRoundData revert OR a zero updatedAt both mean "round does not exist"
///   (FluxAggregator reverts "No data present"; OCR aggregators on Base return zeros).
///   All feed reads are staticcalls. Cost is O(log rounds) for the first sample and O(log delta) for
///   each following sample (galloping search from the previous round), identical results to a plain
///   binary search per sample.
library RealizedVariance {
    error WindowPredatesFeed(address feed, uint256 t);
    error InvalidWindow(uint40 start, uint40 end, uint32 interval);
    error WindowInFuture(uint40 end, uint256 nowTs);
    error InvalidAnswer(address feed, uint80 roundId, int256 answer);
    error FeedDecimalsUnsupported(uint8 decimals);

    uint256 internal constant YEAR = 31_536_000;
    uint256 internal constant WAD = 1e18;

    struct Cursor {
        uint16 phase;
        uint64 round;
        uint64 hi; // last existing round of `phase`
        int256 answer; // answer of `round`
    }

    // ------------------------------------------------------------------ public API

    /// @notice Annualized realized variance over [start, end] sampled every `interval` seconds.
    function compute(address feed, uint40 start, uint40 end, uint32 interval)
        internal
        view
        returns (uint256 rv, uint256 nSamples)
    {
        (uint256[] memory p,) = samples(feed, start, end, interval);
        nSamples = p.length - 1;
        uint256 sum;
        for (uint256 i = 1; i <= nSamples; i++) {
            sum += squaredReturn(p[i - 1], p[i]);
        }
        rv = sum * YEAR / (uint256(end) - uint256(start));
    }

    /// @notice Latest round with updatedAt <= t (phase-aware). Answer scaled to 18 decimals.
    function priceAt(address feed, uint256 t) internal view returns (uint256 answer, uint80 roundId) {
        (uint16 curPhase, uint64 curHi) = _latest(feed);
        Cursor memory c = _locate(feed, t, curPhase, curHi);
        roundId = _wrap(c.phase, c.round);
        require(c.answer > 0, InvalidAnswer(feed, roundId, c.answer));
        answer = uint256(c.answer) * _scale(feed);
    }

    /// @notice All sample prices (18 dec) and their proxy round ids for the window.
    function samples(address feed, uint40 start, uint40 end, uint32 interval)
        internal
        view
        returns (uint256[] memory prices, uint80[] memory roundIds)
    {
        require(
            interval > 0 && end > start && (uint256(end) - start) % interval == 0, InvalidWindow(start, end, interval)
        );
        require(end <= block.timestamp, WindowInFuture(end, block.timestamp));

        uint256 n = (uint256(end) - start) / interval;
        prices = new uint256[](n + 1);
        roundIds = new uint80[](n + 1);

        uint256 scale = _scale(feed);
        (uint16 curPhase, uint64 curHi) = _latest(feed);
        Cursor memory c = _locate(feed, start, curPhase, curHi);

        // per-phase cache of round-1 timestamps/answers for phases above the cursor (0 = unknown)
        uint256[] memory firstTs = new uint256[](uint256(curPhase) + 1);
        int256[] memory firstAns = new int256[](uint256(curPhase) + 1);

        for (uint256 i = 0; i <= n; i++) {
            uint256 t = uint256(start) + i * interval;
            if (i > 0) {
                // phase upgrade: the highest phase whose first round is <= t wins
                for (uint16 q = curPhase; q > c.phase; q--) {
                    if (firstTs[q] == 0) {
                        (bool ok, int256 a, uint256 ts) = _read(feed, q, 1);
                        firstTs[q] = ok ? ts : type(uint256).max;
                        firstAns[q] = a;
                    }
                    if (firstTs[q] <= t) {
                        c.phase = q;
                        c.round = 1;
                        c.answer = firstAns[q];
                        c.hi = q == curPhase ? curHi : _findLast(feed, q);
                        break;
                    }
                }
                (c.round, c.answer) = _advance(feed, c.phase, c.round, c.answer, c.hi, t);
            }
            uint80 rid = _wrap(c.phase, c.round);
            require(c.answer > 0, InvalidAnswer(feed, rid, c.answer));
            prices[i] = uint256(c.answer) * scale;
            roundIds[i] = rid;
        }
    }

    // ------------------------------------------------------------------ resumable scanning

    /// @notice A feed cursor that survives across sample points, so a bounded checkpoint call pays for the
    ///   phase/decimals lookup once and then only gallops forward.
    /// @param curPhase the proxy's current phase id
    /// @param curHi the last round of `curPhase`
    /// @param scale 10 ** (18 - feed decimals)
    /// @param c cursor at the last resolved sample
    struct Scan {
        uint16 curPhase;
        uint64 curHi;
        uint256 scale;
        Cursor c;
    }

    /// @notice Open a scan at time `t`, resolving the first sample from scratch.
    function beginScan(address feed, uint256 t)
        internal
        view
        returns (Scan memory s, uint256 priceWad, uint80 roundId)
    {
        (s.curPhase, s.curHi) = _latest(feed);
        s.scale = _scale(feed);
        s.c = _locate(feed, t, s.curPhase, s.curHi);
        (priceWad, roundId) = _resolve(s);
    }

    /// @notice Re-open a scan on a round id a previous call already validated and stored.
    /// @dev The stored round is re-read so a feed that has since become unreadable at that round fails
    ///   loudly instead of silently continuing from a stale answer.
    function resumeScan(address feed, uint80 fromRoundId) internal view returns (Scan memory s) {
        (s.curPhase, s.curHi) = _latest(feed);
        s.scale = _scale(feed);
        uint16 phase = uint16(fromRoundId >> 64);
        uint64 round = uint64(fromRoundId);
        (bool ok, int256 answer,) = _read(feed, phase, round);
        require(ok && answer > 0, InvalidAnswer(feed, fromRoundId, answer));
        s.c = Cursor({
            phase: phase, round: round, hi: phase == s.curPhase ? s.curHi : _findLast(feed, phase), answer: answer
        });
    }

    /// @notice Advance an open scan to the latest valid round at or before `t`, phase upgrades included.
    ///   Identical selection rule to `samples`, so a checkpointed window and a one-shot `compute` over the
    ///   same window agree exactly.
    function nextSample(Scan memory s, address feed, uint256 t)
        internal
        view
        returns (uint256 priceWad, uint80 roundId)
    {
        for (uint16 q = s.curPhase; q > s.c.phase; q--) {
            (bool ok, int256 a1, uint256 ts1) = _read(feed, q, 1);
            if (ok && ts1 <= t) {
                s.c.phase = q;
                s.c.round = 1;
                s.c.answer = a1;
                s.c.hi = q == s.curPhase ? s.curHi : _findLast(feed, q);
                break;
            }
        }
        (s.c.round, s.c.answer) = _advance(feed, s.c.phase, s.c.round, s.c.answer, s.c.hi, t);
        (priceWad, roundId) = _resolve(s);
    }

    /// @notice Squared log return between two 18-decimal sample prices (WAD).
    function squaredReturn(uint256 previousPriceWad, uint256 priceWad) internal pure returns (uint256) {
        int256 r = FixedPointMathLib.lnWad(int256(priceWad * WAD / previousPriceWad));
        return uint256(r * r) / WAD;
    }

    function _resolve(Scan memory s) private pure returns (uint256 priceWad, uint80 roundId) {
        roundId = _wrap(s.c.phase, s.c.round);
        require(s.c.answer > 0, InvalidAnswer(address(0), roundId, s.c.answer));
        priceWad = uint256(s.c.answer) * s.scale;
    }

    // ------------------------------------------------------------------ search internals

    function _latest(address feed) private view returns (uint16 curPhase, uint64 curHi) {
        curPhase = IAggregatorV3(feed).phaseId();
        (uint80 latestId,,,,) = IAggregatorV3(feed).latestRoundData();
        curHi = uint64(latestId);
    }

    function _scale(address feed) private view returns (uint256) {
        uint8 dec = IAggregatorV3(feed).decimals();
        require(dec <= 18, FeedDecimalsUnsupported(dec));
        return 10 ** (18 - uint256(dec));
    }

    function _wrap(uint16 phase, uint64 round) private pure returns (uint80) {
        return uint80((uint256(phase) << 64) | round);
    }

    /// @dev staticcall getRoundData; a valid answer must be finalized for this round and timestamped.
    function _read(address feed, uint16 phase, uint64 round)
        private
        view
        returns (bool ok, int256 answer, uint256 updatedAt)
    {
        (bool success, bytes memory ret) =
            feed.staticcall(abi.encodeWithSelector(IAggregatorV3.getRoundData.selector, _wrap(phase, round)));
        if (!success || ret.length < 160) return (false, 0, 0);
        (uint80 returnedId, int256 readAnswer,, uint256 readUpdatedAt, uint80 answeredInRound) =
            abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
        uint80 requestedId = _wrap(phase, round);
        answer = readAnswer;
        updatedAt = readUpdatedAt;
        ok = returnedId == requestedId && updatedAt != 0 && answeredInRound >= requestedId;
    }

    /// @dev Highest phase (<= curPhase) whose first round is <= t, then the largest round <= t in it.
    function _locate(address feed, uint256 t, uint16 curPhase, uint64 curHi) private view returns (Cursor memory c) {
        for (uint16 p = curPhase; p >= 1; p--) {
            (bool ok, int256 a1, uint256 ts1) = _read(feed, p, 1);
            if (ok && ts1 <= t) {
                c.phase = p;
                c.hi = p == curPhase ? curHi : _findLast(feed, p);
                (c.round, c.answer) = _advance(feed, p, 1, a1, c.hi, t);
                return c;
            }
            if (p == 1) break;
        }
        revert WindowPredatesFeed(feed, t);
    }

    /// @dev Last existing round of a non-current phase: exponential probe, then binary search the edge.
    function _findLast(address feed, uint16 phase) private view returns (uint64) {
        uint64 lo = 1; // caller verified round 1 exists
        uint64 probe = 2;
        while (true) {
            (bool ok,,) = _read(feed, phase, probe);
            if (!ok) break;
            lo = probe;
            if (probe >= type(uint64).max / 2) break;
            probe *= 2;
        }
        while (probe - lo > 1) {
            uint64 mid = lo + (probe - lo) / 2;
            (bool ok,,) = _read(feed, phase, mid);
            if (ok) lo = mid;
            else probe = mid;
        }
        return lo;
    }

    /// @dev Largest round r in [lo, hi] with updatedAt(r) <= t, given updatedAt(lo) <= t. Gallops then bisects.
    function _advance(address feed, uint16 phase, uint64 lo, int256 loAnswer, uint64 hi, uint256 t)
        private
        view
        returns (uint64, int256)
    {
        if (lo >= hi) return (lo, loAnswer);
        uint256 step = 1;
        uint256 bad; // first round known (or assumed) to be > t
        while (true) {
            uint256 probe = uint256(lo) + step;
            if (probe > hi) {
                bad = uint256(hi) + 1;
                break;
            }
            (bool ok, int256 a, uint256 ts) = _read(feed, phase, uint64(probe));
            if (ok && ts <= t) {
                lo = uint64(probe);
                loAnswer = a;
                if (lo == hi) return (lo, loAnswer);
                step *= 2;
            } else {
                bad = probe;
                break;
            }
        }
        while (bad - lo > 1) {
            uint64 mid = uint64(lo + (bad - lo) / 2);
            (bool ok, int256 a, uint256 ts) = _read(feed, phase, mid);
            if (ok && ts <= t) {
                lo = mid;
                loAnswer = a;
            } else {
                bad = mid;
            }
        }
        return (lo, loAnswer);
    }
}
