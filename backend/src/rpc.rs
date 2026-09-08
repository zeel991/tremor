//! RPC helpers: revert detection (a reverting `getRoundData` means "round does not exist"),
//! rate-limit detection and a small exponential-backoff retry.

use std::future::Future;
use std::time::Duration;

use alloy::contract::Error as ContractError;
use alloy::transports::{RpcError, TransportError};

/// True when a contract call failed because the callee reverted (as opposed to an RPC problem).
pub fn is_revert(err: &ContractError) -> bool {
    match err {
        ContractError::TransportError(RpcError::ErrorResp(p)) => {
            let m = p.message.to_ascii_lowercase();
            p.code == 3
                || m.contains("revert")
                || m.contains("no data present")
                || (p.data.is_some() && !is_rate_limited_msg(&m))
        }
        _ => false,
    }
}

pub fn is_rate_limited_msg(m: &str) -> bool {
    let l = m.to_ascii_lowercase();
    l.contains("rate limit")
        || l.contains("too many requests")
        || l.contains("429")
        || l.contains("-32016")
        || l.contains("-32005")
        || l.contains("capacity")
        || l.contains("exceeded")
        || l.contains("try again")
}

pub fn transport_retryable(err: &TransportError) -> bool {
    match err {
        RpcError::ErrorResp(p) => {
            matches!(p.code, -32016 | -32005 | -32029 | 429) || is_rate_limited_msg(&p.message)
        }
        RpcError::Transport(_) | RpcError::NullResp => true,
        other => is_rate_limited_msg(&other.to_string()),
    }
}

pub fn contract_retryable(err: &ContractError) -> bool {
    match err {
        ContractError::TransportError(t) => transport_retryable(t),
        _ => false,
    }
}

pub fn anyhow_retryable(err: &anyhow::Error) -> bool {
    if let Some(t) = err.downcast_ref::<TransportError>() {
        return transport_retryable(t);
    }
    if let Some(c) = err.downcast_ref::<ContractError>() {
        return contract_retryable(c);
    }
    is_rate_limited_msg(&format!("{err:#}"))
}

/// Retries `f` with exponential backoff (400ms, 800ms, ... capped at 6s; 7 attempts) while
/// `should_retry` says the error is transient.
pub async fn retry<T, E, F, Fut>(
    label: &str,
    should_retry: impl Fn(&E) -> bool,
    mut f: F,
) -> Result<T, E>
where
    E: std::fmt::Display,
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    const ATTEMPTS: u32 = 7;
    let mut delay = Duration::from_millis(400);
    let mut attempt = 0;
    loop {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) if attempt + 1 < ATTEMPTS && should_retry(&e) => {
                attempt += 1;
                tracing::debug!(label, attempt, delay_ms = delay.as_millis() as u64, error = %e, "retrying rpc call");
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_secs(6));
            }
            Err(e) => return Err(e),
        }
    }
}
