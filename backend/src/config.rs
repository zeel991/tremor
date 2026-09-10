//! Environment configuration and the deployment manifest.
//!
//! The manifest is versioned. A v1 manifest — the one the unsecured-writer design wrote, with a
//! `factory` key and no vault, engine or accumulator — is rejected outright rather than partially
//! understood, so a stale file cannot make the backend serve v1 state under v2 field names.

use std::net::IpAddr;
use std::path::{Path, PathBuf};

use alloy::primitives::{Address, B256};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// The only manifest shape this binary understands. Must match `Deploy.s.sol`.
pub const MANIFEST_SCHEMA_VERSION: u32 = 3;

#[derive(Clone, Debug)]
pub struct Config {
    pub rpc_url: String,
    pub deployment_json: PathBuf,
    pub database_url: String,
    pub port: u16,
    pub bind_address: IpAddr,
    pub poll_ms: u64,
    pub cors_origin: String,
}

// The implementation plan allows an optional backend checkpoint worker. This backend deliberately does
// not have one, and the reason is worth stating rather than leaving as an omission:
//
//   - the repository's standing rule is that this API never signs and never sends transactions, which is
//     a property worth more than the convenience;
//   - checkpointing and finalization are permissionless, so nothing depends on a worker existing — if no
//     automation ever runs, the next holder who wants their money checkpoints the window themselves;
//   - the web app exposes Checkpoint and Finalize as ordinary wallet transactions, so the same job gets
//     done by whoever cares, signed by their own key, with no server-side key to manage or leak.
//
// If a worker is ever added, it must take an explicitly provided key, submit only `checkpoint` and
// `finalize`, stop and report rather than skip samples, and stay off by default.

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn env_bool(key: &str) -> bool {
    matches!(
        env_or(key, "false").trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

impl Config {
    pub fn from_env() -> Result<Self> {
        // Fail loudly if someone tries to configure the worker this backend does not have, rather than
        // silently ignoring it and leaving them believing a keeper is running.
        if env_bool("CHECKPOINT_WORKER") || std::env::var("CHECKPOINT_PRIVATE_KEY").is_ok() {
            bail!(
                "this backend never signs transactions, so CHECKPOINT_WORKER / CHECKPOINT_PRIVATE_KEY \
                 do nothing. Checkpointing and finalization are permissionless: use the web app's \
                 Checkpoint and Finalize actions, or `cast send <accumulator> 'checkpoint(uint256,uint16)'`"
            );
        }
        Ok(Self {
            rpc_url: env_or("RPC_URL", "http://127.0.0.1:8545"),
            deployment_json: PathBuf::from(env_or(
                "DEPLOYMENT_JSON",
                "../contracts/deployments/31337.json",
            )),
            database_url: env_or("DATABASE_URL", "sqlite://tremor.db"),
            port: env_or("PORT", "8787")
                .parse()
                .context("PORT must be a u16")?,
            bind_address: env_or("BIND_ADDRESS", "127.0.0.1")
                .parse()
                .context("BIND_ADDRESS must be an IP address")?,
            poll_ms: env_or("POLL_MS", "3000")
                .parse()
                .context("POLL_MS must be an integer")?,
            cors_origin: env_or("CORS_ORIGIN", "http://localhost:3000"),
        })
    }
}

/// `contracts/deployments/<chainId>.json`, written by `Deploy.s.sol`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    pub chain_id: u64,
    pub aqua: Address,
    pub router: Address,
    #[serde(default)]
    pub router_source_commit: Option<String>,
    #[serde(default)]
    pub router_bytecode_hash: Option<B256>,
    pub weth: Address,
    pub usdc: Address,
    pub feed: Address,
    pub series_factory: Address,
    pub market_engine: Address,
    pub accumulator: Address,
    pub series_deployer: Address,
    pub programs: Address,
    pub lens: Address,
    pub oracle: Address,
    pub portfolio_market: Address,
    pub portfolio_accumulator: Address,
    pub deployment_block: u64,
    #[serde(default)]
    pub writer: Option<Address>,
    #[serde(default)]
    pub buyer: Option<Address>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Manifest {
    pub fn load(path: &Path) -> Result<Self> {
        let text =
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let raw: serde_json::Value =
            serde_json::from_str(&text).context("manifest is not valid JSON")?;
        let version = raw.get("schemaVersion").and_then(|v| v.as_u64());
        match version {
            Some(v) if v as u32 == MANIFEST_SCHEMA_VERSION => {}
            Some(v) => bail!(
                "manifest schemaVersion {v} is not {MANIFEST_SCHEMA_VERSION}; \
                 re-run contracts/script/Deploy.s.sol to write a current manifest"
            ),
            None => bail!(
                "manifest has no schemaVersion, so it predates the covered-market design; \
                 re-run contracts/script/Deploy.s.sol"
            ),
        }
        let m: Self =
            serde_json::from_value(raw).context("manifest does not match the v3 shape")?;
        m.validate()?;
        Ok(m)
    }

    /// Every address the backend will actually call must be non-zero. The plan's example manifest is
    /// all zeroes on purpose, and it must fail readiness rather than start and then fail per request.
    fn validate(&self) -> Result<()> {
        let required: [(&str, Address); 12] = [
            ("aqua", self.aqua),
            ("router", self.router),
            ("usdc", self.usdc),
            ("feed", self.feed),
            ("seriesFactory", self.series_factory),
            ("marketEngine", self.market_engine),
            ("accumulator", self.accumulator),
            ("seriesDeployer", self.series_deployer),
            ("programs", self.programs),
            ("lens", self.lens),
            ("portfolioMarket", self.portfolio_market),
            ("portfolioAccumulator", self.portfolio_accumulator),
        ];
        let zeroed: Vec<&str> = required
            .iter()
            .filter(|(_, a)| a.is_zero())
            .map(|(k, _)| *k)
            .collect();
        if !zeroed.is_empty() {
            bail!("manifest has zero addresses for {zeroed:?}");
        }
        if self.chain_id == 0 {
            bail!("manifest chainId is zero");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn configuring_a_signing_worker_fails_loudly() {
        // Serial by construction: the guard reads the environment, so the variable is removed again.
        std::env::set_var("CHECKPOINT_WORKER", "true");
        let err = Config::from_env().unwrap_err().to_string();
        std::env::remove_var("CHECKPOINT_WORKER");
        assert!(
            err.contains("never signs transactions"),
            "unexpected error: {err}"
        );
    }

    fn write_temp(json: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(json.as_bytes()).unwrap();
        f
    }

    fn v3_manifest() -> String {
        let a = "0x1111111111111111111111111111111111111111";
        format!(
            r#"{{"schemaVersion":3,"chainId":31337,"aqua":"{a}","router":"{a}","weth":"{a}",
            "usdc":"{a}","feed":"{a}","seriesFactory":"{a}","marketEngine":"{a}","accumulator":"{a}",
            "seriesDeployer":"{a}","programs":"{a}","lens":"{a}","oracle":"{a}",
            "portfolioMarket":"{a}","portfolioAccumulator":"{a}","deploymentBlock":7}}"#
        )
    }

    #[test]
    fn v3_manifest_loads() {
        let f = write_temp(&v3_manifest());
        let m = Manifest::load(f.path()).unwrap();
        assert_eq!(m.schema_version, 3);
        assert_eq!(m.chain_id, 31_337);
        assert_eq!(m.deployment_block, 7);
        assert!(!m.portfolio_market.is_zero());
        assert!(!m.portfolio_accumulator.is_zero());
    }

    #[test]
    fn a_v1_manifest_is_rejected_rather_than_reinterpreted() {
        let a = "0x1111111111111111111111111111111111111111";
        let v1 = format!(
            r#"{{"chainId":31337,"aqua":"{a}","weth":"{a}","usdc":"{a}","feed":"{a}","router":"{a}",
            "factory":"{a}","lens":"{a}","oracle":"{a}","deploymentBlock":7,"seller":"{a}","buyer":"{a}"}}"#
        );
        let f = write_temp(&v1);
        let err = Manifest::load(f.path()).unwrap_err().to_string();
        assert!(err.contains("no schemaVersion"), "unexpected error: {err}");
    }

    #[test]
    fn a_future_schema_is_rejected() {
        let f = write_temp(&v3_manifest().replace("\"schemaVersion\":3", "\"schemaVersion\":4"));
        let err = Manifest::load(f.path()).unwrap_err().to_string();
        assert!(err.contains("schemaVersion 4"), "unexpected error: {err}");
    }

    #[test]
    fn zero_addresses_fail_readiness() {
        let f = write_temp(&v3_manifest().replace(
            "\"lens\":\"0x1111111111111111111111111111111111111111\"",
            "\"lens\":\"0x0000000000000000000000000000000000000000\"",
        ));
        let err = Manifest::load(f.path()).unwrap_err().to_string();
        assert!(err.contains("zero addresses"), "unexpected error: {err}");
        assert!(err.contains("lens"), "unexpected error: {err}");
    }
}
