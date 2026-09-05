// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Unix timestamp -> civil date formatting (Howard Hinnant's days-to-civil algorithm).
library DateLib {
    function civil(uint256 ts) internal pure returns (uint256 y, uint256 m, uint256 d) {
        uint256 z = ts / 86400 + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        d = doy - (153 * mp + 2) / 5 + 1;
        m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
    }

    function _pad2(uint256 v) private pure returns (string memory) {
        bytes memory b = new bytes(2);
        b[0] = bytes1(uint8(48 + (v / 10) % 10));
        b[1] = bytes1(uint8(48 + v % 10));
        return string(b);
    }

    function _pad4(uint256 v) private pure returns (string memory) {
        bytes memory b = new bytes(4);
        b[0] = bytes1(uint8(48 + (v / 1000) % 10));
        b[1] = bytes1(uint8(48 + (v / 100) % 10));
        b[2] = bytes1(uint8(48 + (v / 10) % 10));
        b[3] = bytes1(uint8(48 + v % 10));
        return string(b);
    }

    /// @return "YYYY-MM-DD"
    function iso(uint256 ts) internal pure returns (string memory) {
        (uint256 y, uint256 m, uint256 d) = civil(ts);
        return string.concat(_pad4(y), "-", _pad2(m), "-", _pad2(d));
    }

    /// @return "yymmdd"
    function yymmdd(uint256 ts) internal pure returns (string memory) {
        (uint256 y, uint256 m, uint256 d) = civil(ts);
        return string.concat(_pad2(y % 100), _pad2(m), _pad2(d));
    }
}
