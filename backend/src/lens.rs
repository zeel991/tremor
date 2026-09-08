//! `TremorLens` reads over RPC and their JSON (snake_case) projections.
//!
//! The Lens is authoritative for anything executable — quotes, locked collateral, the final payout,
//! current balances. Everything this backend computes itself is a replica for charts and diagnostics
//! and is labelled as such in the API responses (`source`).

#![allow(dead_code)]

use alloy::primitives::aliases::{U40, U80};
use alloy::primitives::{Address, U256};
use alloy::providers::DynProvider;
use anyhow::{anyhow, Result};
use serde::Serialize;

use crate::abi::TremorLens;
use crate::rpc::{contract_retryable, retry};

#[derive(Clone, Debug, Serialize)]
pub struct SeriesParamsJson {
    pub feed: String,
    pub quote_token: String,
    pub start: u64,
    pub expiry: u64,
    pub sale_end: u64,
    pub sample_interval: u32,
    pub unit_notional: String,
    pub cap_variance: String,
    pub anchor_variance: String,
    pub impact_per_unit: String,
    pub half_life: u32,
    pub half_spread_bps: u16,
    pub max_units: String,
}

/// The writer's enforceable collateral position. Replaces v1's `coverage`, which measured a wallet the
/// seller could empty at will.
#[derive(Clone, Debug, Serialize)]
pub struct VaultStateJson {
    pub vault: String,
    pub owner: String,
    pub balance: String,
    pub locked: String,
    pub free: String,
    pub aqua_allowance: String,
    pub allowance_sufficient: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct LensStateJson {
    pub id: u64,
    pub writer: String,
    pub vault: String,
    pub receipt: String,
    pub params: SeriesParamsJson,
    pub issue_order_hash: String,
    pub exit_order_hash: String,
    pub settlement_order_hash: String,
    pub status: &'static str,
    pub issuance_open: bool,
    pub exit_open: bool,
    pub settle_open: bool,
    /// The market's own forward variance after inventory-skew decay (WAD). Not a fair value.
    pub market_variance: String,
    /// Realized-so-far blended with the forward variance over the whole window (WAD), unclamped.
    pub projected_variance: String,
    pub realized_variance_so_far: String,
    pub bid_variance: String,
    pub ask_variance: String,
    pub bid_per_unit: String,
    pub ask_per_unit: String,
    pub max_payout_per_unit: String,
    pub units_outstanding: String,
    pub units_available: String,
    pub locked_liability: String,
    pub final_variance: String,
    pub payout_per_unit: String,
    pub samples_stored: u64,
    pub samples_available: u64,
    pub samples_total: u64,
    pub processed_through: u64,
    pub checkpoints_current: bool,
    pub issue_leg_active: bool,
    pub exit_leg_active: bool,
    pub settle_leg_active: bool,
    pub fully_collateralized: bool,
    pub vault_state: VaultStateJson,
    pub source: &'static str,
}

pub fn status_name(s: u8) -> &'static str {
    match s {
        0 => "upcoming",
        1 => "live",
        2 => "expired_unfinalized",
        3 => "finalized",
        4 => "closed",
        _ => "unknown",
    }
}

fn hex_addr(a: &Address) -> String {
    format!("{a:#x}")
}

fn u64_of(x: &U256) -> u64 {
    u64::try_from(*x).unwrap_or(u64::MAX)
}

pub fn params_json(p: &TremorLens::SeriesParams) -> SeriesParamsJson {
    SeriesParamsJson {
        feed: hex_addr(&p.feed),
        quote_token: hex_addr(&p.quoteToken),
        start: p.start.to::<u64>(),
        expiry: p.expiry.to::<u64>(),
        sale_end: p.saleEnd.to::<u64>(),
        sample_interval: p.sampleInterval,
        unit_notional: p.unitNotional.to_string(),
        cap_variance: p.capVariance.to_string(),
        anchor_variance: p.anchorVariance.to_string(),
        impact_per_unit: p.impactPerUnit.to_string(),
        half_life: p.halfLife,
        half_spread_bps: p.halfSpreadBps,
        max_units: p.maxUnits.to_string(),
    }
}

pub fn vault_state_json(v: &TremorLens::VaultState) -> VaultStateJson {
    VaultStateJson {
        vault: hex_addr(&v.vault),
        owner: hex_addr(&v.owner),
        balance: v.balance.to_string(),
        locked: v.locked.to_string(),
        free: v.free.to_string(),
        aqua_allowance: v.aquaAllowance.to_string(),
        allowance_sufficient: v.allowanceSufficient,
    }
}

pub fn state_json(s: &TremorLens::SeriesState) -> LensStateJson {
    LensStateJson {
        id: u64_of(&s.id),
        writer: hex_addr(&s.writer),
        vault: hex_addr(&s.vault),
        receipt: hex_addr(&s.receipt),
        params: params_json(&s.params),
        issue_order_hash: format!("{:#x}", s.issueOrderHash),
        exit_order_hash: format!("{:#x}", s.exitOrderHash),
        settlement_order_hash: format!("{:#x}", s.settlementOrderHash),
        status: status_name(s.status),
        issuance_open: s.legs.issuanceOpen,
        exit_open: s.legs.exitOpen,
        settle_open: s.legs.settleOpen,
        market_variance: s.quote.marketVariance.to_string(),
        projected_variance: s.quote.projectedVariance.to_string(),
        realized_variance_so_far: s.quote.realizedVarianceSoFar.to_string(),
        bid_variance: s.quote.bidVariance.to_string(),
        ask_variance: s.quote.askVariance.to_string(),
        bid_per_unit: s.quote.bidPerUnit.to_string(),
        ask_per_unit: s.quote.askPerUnit.to_string(),
        max_payout_per_unit: s.quote.maxPayoutPerUnit.to_string(),
        units_outstanding: s.unitsOutstanding.to_string(),
        units_available: s.unitsAvailable.to_string(),
        locked_liability: s.lockedLiability.to_string(),
        final_variance: s.finalVariance.to_string(),
        payout_per_unit: s.payoutPerUnit.to_string(),
        samples_stored: u64_of(&s.oracle.samplesStored),
        samples_available: u64_of(&s.oracle.samplesAvailable),
        samples_total: u64_of(&s.oracle.samplesTotal),
        processed_through: u64_of(&s.oracle.processedThrough),
        checkpoints_current: s.oracle.checkpointsCurrent,
        issue_leg_active: s.legs.issueLegActive,
        exit_leg_active: s.legs.exitLegActive,
        settle_leg_active: s.legs.settleLegActive,
        fully_collateralized: s.fullyCollateralized,
        vault_state: vault_state_json(&s.vaultState),
        source: "lens",
    }
}

#[derive(Clone)]
pub struct LensClient {
    pub address: Address,
    provider: DynProvider,
}

impl LensClient {
    pub fn new(address: Address, provider: DynProvider) -> Self {
        Self { address, provider }
    }

    fn contract(&self) -> TremorLens::TremorLensInstance<DynProvider> {
        TremorLens::new(self.address, self.provider.clone())
    }

    fn err(&self, what: &str, e: impl std::fmt::Display) -> anyhow::Error {
        anyhow!("TremorLens.{what} @ {}: {e}", self.address)
    }

    pub async fn state(&self, id: u64) -> Result<LensStateJson> {
        let c = self.contract();
        let s = retry("lens.state", contract_retryable, || async {
            c.state(U256::from(id)).call().await
        })
        .await
        .map_err(|e| self.err(&format!("state({id})"), e))?;
        Ok(state_json(&s))
    }

    pub async fn states(&self, from: u64, to: u64) -> Result<Vec<LensStateJson>> {
        let c = self.contract();
        let v = retry("lens.states", contract_retryable, || async {
            c.states(U256::from(from), U256::from(to)).call().await
        })
        .await
        .map_err(|e| self.err(&format!("states({from},{to})"), e))?;
        Ok(v.iter().map(state_json).collect())
    }

    pub async fn vault_state(&self, vault: Address) -> Result<VaultStateJson> {
        let c = self.contract();
        let v = retry("lens.vaultState", contract_retryable, || async {
            c.vaultState(vault).call().await
        })
        .await
        .map_err(|e| self.err("vaultState", e))?;
        Ok(vault_state_json(&v))
    }

    /// `(vault, exists, state)`. When the writer has no vault yet, `vault` is the address the one they
    /// create will have, which is a pure function of the deployer's address.
    pub async fn writer_vault(&self, writer: Address) -> Result<(String, bool, VaultStateJson)> {
        let c = self.contract();
        let r = retry("lens.writerVault", contract_retryable, || async {
            c.writerVault(writer).call().await
        })
        .await
        .map_err(|e| self.err("writerVault", e))?;
        Ok((hex_addr(&r.vault), r.exists, vault_state_json(&r.vs)))
    }

    /// `(units, premium)` for an exact-in ISSUE fill.
    pub async fn quote_issue_exact_in(&self, id: u64, quote_in: U256) -> Result<(U256, U256)> {
        let c = self.contract();
        let r = retry("lens.quoteIssueExactIn", contract_retryable, || async {
            c.quoteIssueExactIn(U256::from(id), quote_in).call().await
        })
        .await
        .map_err(|e| self.err("quoteIssueExactIn", e))?;
        Ok((r.units, r.premium))
    }

    /// `(filledUnits, premium)` for an exact-out ISSUE fill. `filledUnits` can be below the request
    /// when inventory, the vault's free collateral or the cap binds first.
    pub async fn quote_issue_exact_out(&self, id: u64, units: U256) -> Result<(U256, U256)> {
        let c = self.contract();
        let r = retry("lens.quoteIssueExactOut", contract_retryable, || async {
            c.quoteIssueExactOut(U256::from(id), units).call().await
        })
        .await
        .map_err(|e| self.err("quoteIssueExactOut", e))?;
        Ok((r.filledUnits, r.premium))
    }

    /// `(filledUnits, quoteOut)` for an EXIT fill — an executable bid, not an indication.
    pub async fn quote_exit_exact_in(&self, id: u64, units: U256) -> Result<(U256, U256)> {
        let c = self.contract();
        let r = retry("lens.quoteExitExactIn", contract_retryable, || async {
            c.quoteExitExactIn(U256::from(id), units).call().await
        })
        .await
        .map_err(|e| self.err("quoteExitExactIn", e))?;
        Ok((r.filledUnits, r.quoteOut))
    }

    /// `(filledUnits, quoteOut)` for a SETTLE fill at the fixed final payout.
    pub async fn quote_settle_exact_in(&self, id: u64, units: U256) -> Result<(U256, U256)> {
        let c = self.contract();
        let r = retry("lens.quoteSettleExactIn", contract_retryable, || async {
            c.quoteSettleExactIn(U256::from(id), units).call().await
        })
        .await
        .map_err(|e| self.err("quoteSettleExactIn", e))?;
        Ok((r.filledUnits, r.quoteOut))
    }

    /// `(rv, samples)` as computed on chain over an explicit window.
    pub async fn realized_variance(
        &self,
        feed: Address,
        start: u64,
        end: u64,
        interval: u32,
    ) -> Result<(U256, U256)> {
        let c = self.contract();
        let r = retry("lens.realizedVariance", contract_retryable, || async {
            c.realizedVariance(feed, U40::from(start), U40::from(end), interval)
                .call()
                .await
        })
        .await
        .map_err(|e| self.err("realizedVariance", e))?;
        Ok((r.rv, r.samples))
    }

    pub async fn sample_prices(
        &self,
        feed: Address,
        start: u64,
        end: u64,
        interval: u32,
    ) -> Result<(Vec<U256>, Vec<U80>)> {
        let c = self.contract();
        let r = retry("lens.samplePrices", contract_retryable, || async {
            c.samplePrices(feed, U40::from(start), U40::from(end), interval)
                .call()
                .await
        })
        .await
        .map_err(|e| self.err("samplePrices", e))?;
        Ok((r.prices, r.roundIds))
    }

    pub async fn lvr_hedge_units(
        &self,
        id: u64,
        pool_value_quote: U256,
        horizon_seconds: u64,
    ) -> Result<U256> {
        let c = self.contract();
        retry("lens.lvrHedgeUnits", contract_retryable, || async {
            c.lvrHedgeUnits(U256::from(id), pool_value_quote, U40::from(horizon_seconds))
                .call()
                .await
        })
        .await
        .map_err(|e| self.err("lvrHedgeUnits", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_names_cover_the_five_lifecycle_states() {
        assert_eq!(status_name(0), "upcoming");
        assert_eq!(status_name(1), "live");
        assert_eq!(status_name(2), "expired_unfinalized");
        assert_eq!(status_name(3), "finalized");
        assert_eq!(status_name(4), "closed");
        assert_eq!(status_name(9), "unknown");
    }
}
