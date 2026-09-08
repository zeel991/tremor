//! Small shared helpers: time, window parsing, WAD <-> f64 formatting.

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Result};

pub const SECONDS_PER_DAY: u64 = 86_400;

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn sqlite_i64(value: u64, field: &str) -> Result<i64> {
    i64::try_from(value).map_err(|_| anyhow::anyhow!("{field} exceeds SQLite INTEGER range"))
}

pub fn nonnegative_u64(value: i64, field: &str) -> Result<u64> {
    if value < 0 {
        bail!("{field} is negative in SQLite");
    }
    Ok(value as u64)
}

/// Parses `1d`, `7d`, `30d`, `12h`, `90m` or plain seconds into seconds.
pub fn parse_window(s: &str) -> Option<u64> {
    let s = s.trim().to_ascii_lowercase();
    if s.is_empty() {
        return None;
    }
    let (num, mult) = match s.chars().last()? {
        'd' => (&s[..s.len() - 1], SECONDS_PER_DAY),
        'h' => (&s[..s.len() - 1], 3600),
        'm' => (&s[..s.len() - 1], 60),
        's' => (&s[..s.len() - 1], 1),
        c if c.is_ascii_digit() => (s.as_str(), 1),
        _ => return None,
    };
    let n: u64 = num.parse().ok()?;
    if n == 0 {
        return None;
    }
    n.checked_mul(mult)
}

/// Formats a non-negative f64 quantity as an exact WAD (1e18) integer string.
pub fn wad_string(x: f64) -> String {
    if !x.is_finite() || x <= 0.0 {
        return "0".to_string();
    }
    let scaled = (x * 1e18).round();
    if scaled >= u128::MAX as f64 {
        return u128::MAX.to_string();
    }
    (scaled as u128).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_parse() {
        assert_eq!(parse_window("1d"), Some(86_400));
        assert_eq!(parse_window("7d"), Some(604_800));
        assert_eq!(parse_window("30d"), Some(2_592_000));
        assert_eq!(parse_window("12h"), Some(43_200));
        assert_eq!(parse_window("3600"), Some(3600));
        assert_eq!(parse_window("0d"), None);
        assert_eq!(parse_window("abc"), None);
        assert_eq!(parse_window("18446744073709551615d"), None);
    }

    #[test]
    fn wad_roundtrip() {
        assert_eq!(wad_string(1.0), "1000000000000000000");
        assert_eq!(wad_string(0.0), "0");
        assert_eq!(wad_string(-1.0), "0");
    }

    #[test]
    fn sqlite_integer_conversions_are_checked() {
        assert_eq!(sqlite_i64(42, "value").unwrap(), 42);
        assert!(sqlite_i64(u64::MAX, "value").is_err());
        assert_eq!(nonnegative_u64(42, "value").unwrap(), 42);
        assert!(nonnegative_u64(-1, "value").is_err());
    }
}
