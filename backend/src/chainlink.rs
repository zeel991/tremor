//! Chainlink module: phase-aware round search (ARCHITECTURE §3.3) replicated off-chain, with a
//! SQLite + in-memory rounds cache and dense Multicall3 fetching for sampling windows.
//!
//! Proxy roundId = `(phaseId << 64) | aggregatorRoundId`. `priceAt(t)`: for phases p, p-1, ...:
//! if `getRoundData(p<<64|1).updatedAt <= t` binary-search that phase for the largest round with
//! `updatedAt <= t`; otherwise drop to the previous phase; if none matches → `WindowPredatesFeed`.
//! A reverting `getRoundData` means "round does not exist".

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU8, Ordering};

use alloy::primitives::aliases::U80;
use alloy::primitives::{Address, U256};
use alloy::providers::{CallItem, DynProvider, Provider, MULTICALL3_ADDRESS};
use alloy::sol_types::SolCall;
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::abi::AggregatorV3;
use crate::db::Db;
use crate::rpc::{anyhow_retryable, contract_retryable, is_revert, retry};

/// Rounds per Multicall3 `aggregate3` call. Public Base RPCs commonly reject larger
/// historical calls on cold fork state even though the Multicall contract itself permits them.
pub const MULTICALL_CHUNK: u64 = 100;
/// Hard cap on samples per request.
pub const MAX_SAMPLES: u64 = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Round {
    pub phase: u16,
    pub agg_round: u64,
    /// raw feed answer (8 decimals for ETH/USD)
    pub answer: i128,
    pub started_at: u64,
    pub updated_at: u64,
}

impl Round {
    pub fn round_id(&self) -> u128 {
        ((self.phase as u128) << 64) | self.agg_round as u128
    }
    pub fn price_f64(&self, decimals: u8) -> f64 {
        self.answer as f64 / 10f64.powi(decimals as i32)
    }
    /// Answer scaled to 18 decimals, as an exact decimal string.
    pub fn price_wad_string(&self, decimals: u8) -> String {
        let scale = 10i128.pow(18u32.saturating_sub(decimals as u32));
        (self.answer.max(0) * scale).to_string()
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Sample {
    pub t: u64,
    pub round: Round,
}

#[derive(Debug, thiserror::Error)]
pub enum FeedError {
    #[error("window predates feed: no Chainlink round at or before t={0}")]
    WindowPredatesFeed(u64),
}

/// Minimal read interface over a Chainlink proxy; implemented over RPC and by a test fake.
#[async_trait]
pub trait RoundSource: Send + Sync {
    async fn phase_id(&self, feed: Address) -> Result<u16>;
    async fn latest(&self, feed: Address) -> Result<Round>;
    /// `None` when the round does not exist (the proxy reverts).
    async fn round(&self, feed: Address, phase: u16, idx: u64) -> Result<Option<Round>>;
    /// Dense fetch of `lo..=hi` (inclusive). Default: one call per round.
    async fn rounds(
        &self,
        feed: Address,
        phase: u16,
        lo: u64,
        hi: u64,
    ) -> Result<Vec<Option<Round>>> {
        let mut out = Vec::with_capacity((hi - lo + 1) as usize);
        for idx in lo..=hi {
            out.push(self.round(feed, phase, idx).await?);
        }
        Ok(out)
    }
}

// ------------------------------------------------------------------------------------------
// RPC implementation
// ------------------------------------------------------------------------------------------

pub struct RpcRoundSource {
    provider: DynProvider,
    /// 0 = unknown, 1 = Multicall3 deployed, 2 = not deployed
    multicall: AtomicU8,
}

fn split_round_id(rid: u128) -> (u16, u64) {
    ((rid >> 64) as u16, (rid & (u64::MAX as u128)) as u64)
}

fn u256_to_u64(x: U256) -> u64 {
    u64::try_from(x).unwrap_or(u64::MAX)
}

impl RpcRoundSource {
    pub fn new(provider: DynProvider) -> Self {
        Self {
            provider,
            multicall: AtomicU8::new(0),
        }
    }

    async fn multicall_available(&self) -> bool {
        match self.multicall.load(Ordering::Relaxed) {
            1 => true,
            2 => false,
            _ => {
                let ok = match self.provider.get_code_at(MULTICALL3_ADDRESS).await {
                    Ok(code) => !code.is_empty(),
                    Err(e) => {
                        tracing::warn!(error = %e, "could not probe Multicall3; falling back to sequential getRoundData");
                        return false; // do not cache a transient failure
                    }
                };
                tracing::info!(multicall3 = ok, "Multicall3 availability probed");
                self.multicall
                    .store(if ok { 1 } else { 2 }, Ordering::Relaxed);
                ok
            }
        }
    }

    fn round_from(phase: u16, idx: u64, r: AggregatorV3::getRoundDataReturn) -> Result<Round> {
        let answer: i128 = r
            .answer
            .to_string()
            .parse()
            .context("feed answer does not fit i128")?;
        Ok(Round {
            phase,
            agg_round: idx,
            answer,
            started_at: u256_to_u64(r.startedAt),
            updated_at: u256_to_u64(r.updatedAt),
        })
    }

    fn rid(phase: u16, idx: u64) -> U80 {
        U80::from(((phase as u128) << 64) | idx as u128)
    }
}

#[async_trait]
impl RoundSource for RpcRoundSource {
    async fn phase_id(&self, feed: Address) -> Result<u16> {
        let c = AggregatorV3::new(feed, self.provider.clone());
        retry("phaseId", contract_retryable, || async {
            c.phaseId().call().await
        })
        .await
        .map_err(|e| anyhow!("feed {feed} phaseId(): {e}"))
    }

    async fn latest(&self, feed: Address) -> Result<Round> {
        let c = AggregatorV3::new(feed, self.provider.clone());
        let r = retry("latestRoundData", contract_retryable, || async {
            c.latestRoundData().call().await
        })
        .await
        .map_err(|e| anyhow!("feed {feed} latestRoundData(): {e}"))?;
        let (phase, idx) = split_round_id(r.roundId.to::<u128>());
        let answer: i128 = r
            .answer
            .to_string()
            .parse()
            .context("feed answer does not fit i128")?;
        Ok(Round {
            phase,
            agg_round: idx,
            answer,
            started_at: u256_to_u64(r.startedAt),
            updated_at: u256_to_u64(r.updatedAt),
        })
    }

    async fn round(&self, feed: Address, phase: u16, idx: u64) -> Result<Option<Round>> {
        let c = AggregatorV3::new(feed, self.provider.clone());
        let rid = Self::rid(phase, idx);
        match retry("getRoundData", contract_retryable, || async {
            c.getRoundData(rid).call().await
        })
        .await
        {
            // OCR aggregators return a zeroed transmission (updatedAt == 0) for unknown round ids
            // <= 2^32 instead of reverting; the proxy forwards it. Treat both as "does not exist".
            Ok(r) => Ok(Some(Self::round_from(phase, idx, r)?).filter(|r| r.updated_at != 0)),
            Err(e) if is_revert(&e) => Ok(None),
            Err(e) => Err(anyhow!(
                "feed {feed} getRoundData(phase {phase}, round {idx}): {e}"
            )),
        }
    }

    async fn rounds(
        &self,
        feed: Address,
        phase: u16,
        lo: u64,
        hi: u64,
    ) -> Result<Vec<Option<Round>>> {
        if hi < lo {
            return Ok(vec![]);
        }
        if !self.multicall_available().await {
            let mut out = Vec::with_capacity((hi - lo + 1) as usize);
            for idx in lo..=hi {
                out.push(self.round(feed, phase, idx).await?);
            }
            return Ok(out);
        }
        let mut out = Vec::with_capacity((hi - lo + 1) as usize);
        let mut start = lo;
        while start <= hi {
            let end = (start + MULTICALL_CHUNK - 1).min(hi);
            let res = retry("multicall getRoundData", anyhow_retryable, || async {
                let mut mc = self
                    .provider
                    .multicall()
                    .dynamic::<AggregatorV3::getRoundDataCall>();
                for idx in start..=end {
                    let call = AggregatorV3::getRoundDataCall {
                        roundId: Self::rid(phase, idx),
                    };
                    let item = CallItem::<AggregatorV3::getRoundDataCall>::new(
                        feed,
                        call.abi_encode().into(),
                    )
                    .allow_failure(true);
                    mc = mc.add_call_dynamic(item);
                }
                mc.aggregate3()
                    .await
                    .map_err(|e| anyhow!("aggregate3: {e}"))
            })
            .await
            .with_context(|| format!("dense fetch phase {phase} rounds {start}..={end}"))?;
            for (i, r) in res.into_iter().enumerate() {
                let idx = start + i as u64;
                out.push(match r {
                    Ok(ret) => {
                        Some(Self::round_from(phase, idx, ret)?).filter(|r| r.updated_at != 0)
                    }
                    Err(_) => None,
                });
            }
            tracing::debug!(phase, start, end, "dense-fetched rounds via Multicall3");
            start = end + 1;
        }
        Ok(out)
    }
}

// ------------------------------------------------------------------------------------------
// Cache + search algorithm (generic over the source so it is unit-testable)
// ------------------------------------------------------------------------------------------

#[derive(Default)]
struct PhaseMem {
    loaded: bool,
    /// cached `getRoundData(phase<<64|1)` when it exists
    first: Option<Round>,
    /// last existing round of a *closed* phase
    last_round: Option<u64>,
    rounds: BTreeMap<u64, Round>,
    /// contiguous ranges known to be fully present in `rounds`
    coverage: Vec<(u64, u64)>,
}

struct Ctx {
    phase: u16,
    latest: Round,
}

pub struct Chainlink<S: RoundSource> {
    source: S,
    db: Db,
    mem: Mutex<HashMap<(Address, u16), PhaseMem>>,
    /// One cold cache fill at a time. Without this, the dashboard's summary and chart requests
    /// can fetch the same multi-thousand-round range concurrently.
    load_lock: Mutex<()>,
}

impl<S: RoundSource> Chainlink<S> {
    pub fn new(source: S, db: Db) -> Self {
        Self {
            source,
            db,
            mem: Mutex::new(HashMap::new()),
            load_lock: Mutex::new(()),
        }
    }

    pub fn source(&self) -> &S {
        &self.source
    }

    /// Current phase + latest round. The proxy prefixes `latestRoundData().roundId` with its
    /// current `phaseId()`, so the phase is taken from there (saves one RPC per request).
    async fn ctx(&self, feed: Address) -> Result<Ctx> {
        let latest = self.source.latest(feed).await?;
        Ok(Ctx {
            phase: latest.phase,
            latest,
        })
    }

    async fn ensure_mem(&self, feed: Address, phase: u16) -> Result<()> {
        {
            let m = self.mem.lock().await;
            if m.get(&(feed, phase)).map(|p| p.loaded).unwrap_or(false) {
                return Ok(());
            }
        }
        let rounds = self.db.rounds_for_phase(feed, phase).await?;
        let last = self.db.phase_last(feed, phase).await?;
        let cov = self.db.coverage(feed, phase).await?;
        let mut m = self.mem.lock().await;
        let p = m.entry((feed, phase)).or_default();
        if !p.loaded {
            for r in rounds {
                p.rounds.insert(r.agg_round, r);
            }
            p.first = p.rounds.get(&1).copied();
            p.last_round = last;
            p.coverage = coalesce(cov);
            p.loaded = true;
            tracing::debug!(%feed, phase, cached_rounds = p.rounds.len(), "loaded phase cache from sqlite");
        }
        Ok(())
    }

    /// Cached round lookup (memory → sqlite → source).
    pub async fn get_round(&self, feed: Address, phase: u16, idx: u64) -> Result<Option<Round>> {
        self.ensure_mem(feed, phase).await?;
        if let Some(r) = self
            .mem
            .lock()
            .await
            .get(&(feed, phase))
            .and_then(|p| p.rounds.get(&idx).copied())
        {
            return Ok(Some(r));
        }
        let r = self
            .source
            .round(feed, phase, idx)
            .await?
            .filter(|r| r.updated_at != 0);
        if let Some(r) = r {
            self.db.put_rounds(feed, &[r]).await?;
            let mut m = self.mem.lock().await;
            let p = m.entry((feed, phase)).or_default();
            p.rounds.insert(idx, r);
            if idx == 1 {
                p.first = Some(r);
            }
        }
        Ok(r)
    }

    async fn first(&self, feed: Address, phase: u16) -> Result<Option<Round>> {
        self.ensure_mem(feed, phase).await?;
        if let Some(f) = self
            .mem
            .lock()
            .await
            .get(&(feed, phase))
            .and_then(|p| p.first)
        {
            return Ok(Some(f));
        }
        self.get_round(feed, phase, 1).await
    }

    /// Highest existing aggregator round of `phase`. For the current phase this is the latest
    /// round; for closed phases it is found once by exponential probing + binary search and cached.
    async fn last(&self, feed: Address, phase: u16, ctx: &Ctx) -> Result<u64> {
        if phase == ctx.latest.phase {
            return Ok(ctx.latest.agg_round);
        }
        self.ensure_mem(feed, phase).await?;
        if let Some(l) = self
            .mem
            .lock()
            .await
            .get(&(feed, phase))
            .and_then(|p| p.last_round)
        {
            return Ok(l);
        }
        if self.get_round(feed, phase, 1).await?.is_none() {
            return Ok(0);
        }
        let (mut lo, mut hi) = (1u64, 2u64);
        while self.get_round(feed, phase, hi).await?.is_some() {
            lo = hi;
            hi = hi.saturating_mul(2);
            if hi > (1u64 << 40) {
                bail!("phase {phase} round probe overflow");
            }
        }
        while hi - lo > 1 {
            let mid = lo + (hi - lo) / 2;
            if self.get_round(feed, phase, mid).await?.is_some() {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        tracing::info!(%feed, phase, last_round = lo, "resolved last round of closed phase");
        self.db.set_phase_last(feed, phase, lo).await?;
        self.mem
            .lock()
            .await
            .entry((feed, phase))
            .or_default()
            .last_round = Some(lo);
        Ok(lo)
    }

    /// Largest round index in `[1, hi]` with `updated_at <= t` (`None` if round 1 is later than t).
    async fn search(&self, feed: Address, phase: u16, hi: u64, t: u64) -> Result<Option<u64>> {
        let Some(first) = self.get_round(feed, phase, 1).await? else {
            return Ok(None);
        };
        if first.updated_at > t || hi == 0 {
            return Ok(None);
        }
        let (mut lo, mut hi) = (1u64, hi);
        while lo < hi {
            let mid = lo + (hi - lo).div_ceil(2);
            match self.get_round(feed, phase, mid).await? {
                Some(r) if r.updated_at <= t => lo = mid,
                _ => hi = mid - 1,
            }
        }
        Ok(Some(lo))
    }

    /// The phase whose history serves time `t` (§3.3 step 2): the highest phase `<= top` whose
    /// first round is at or before `t`.
    async fn phase_for(&self, feed: Address, top: u16, t: u64) -> Result<Option<u16>> {
        let mut p = top;
        while p >= 1 {
            if let Some(f) = self.first(feed, p).await? {
                if f.updated_at <= t {
                    return Ok(Some(p));
                }
            }
            if p == 1 {
                break;
            }
            p -= 1;
        }
        Ok(None)
    }

    /// `RealizedVariance.priceAt(feed, t)` replica.
    pub async fn price_at(&self, feed: Address, t: u64) -> Result<Round> {
        let ctx = self.ctx(feed).await?;
        let phase = self
            .phase_for(feed, ctx.phase, t)
            .await?
            .ok_or(FeedError::WindowPredatesFeed(t))?;
        let hi = self.last(feed, phase, &ctx).await?;
        let idx = self
            .search(feed, phase, hi, t)
            .await?
            .ok_or(FeedError::WindowPredatesFeed(t))?;
        self.get_round(feed, phase, idx)
            .await?
            .ok_or_else(|| anyhow!("round {phase}/{idx} disappeared"))
    }

    /// Makes sure every round in `lo..=hi` of `phase` is in memory (dense fetch of the gaps).
    async fn ensure_loaded(&self, feed: Address, phase: u16, lo: u64, hi: u64) -> Result<()> {
        let _load_guard = self.load_lock.lock().await;
        self.ensure_mem(feed, phase).await?;
        let missing = {
            let m = self.mem.lock().await;
            missing_ranges(
                lo,
                hi,
                &m.get(&(feed, phase))
                    .map(|p| p.coverage.clone())
                    .unwrap_or_default(),
            )
        };
        for (a, b) in missing {
            // Persist each Multicall-sized chunk independently. If the HTTP request times out,
            // the next retry resumes at the first missing chunk instead of starting over.
            let mut chunk_start = a;
            while chunk_start <= b {
                let chunk_end = (chunk_start + MULTICALL_CHUNK - 1).min(b);
                tracing::info!(%feed, phase, from = chunk_start, to = chunk_end, count = chunk_end - chunk_start + 1, "fetching rounds");
                let fetched = self
                    .source
                    .rounds(feed, phase, chunk_start, chunk_end)
                    .await?;
                let mut got = Vec::with_capacity(fetched.len());
                let mut contiguous_hi: Option<u64> = None;
                for (i, r) in fetched.into_iter().enumerate() {
                    let idx = chunk_start + i as u64;
                    match r.filter(|r| r.updated_at != 0) {
                        Some(r) => {
                            got.push(r);
                            if idx == chunk_start || contiguous_hi == Some(idx - 1) {
                                contiguous_hi = Some(idx);
                            }
                        }
                        None => tracing::warn!(phase, idx, "round missing inside dense range"),
                    }
                }
                self.db.put_rounds(feed, &got).await?;
                let cov = {
                    let mut m = self.mem.lock().await;
                    let p = m.entry((feed, phase)).or_default();
                    for r in got {
                        p.rounds.insert(r.agg_round, r);
                    }
                    if let Some(ch) = contiguous_hi {
                        p.coverage =
                            add_interval(std::mem::take(&mut p.coverage), (chunk_start, ch));
                    }
                    p.coverage.clone()
                };
                self.db.replace_coverage(feed, phase, &cov).await?;
                chunk_start = chunk_end + 1;
            }
        }
        Ok(())
    }

    /// Sample prices at `t_i = start + i·interval` for `i = 0..=n` (§1), phase-aware, using the
    /// cache. Every returned round is exactly what `priceAt(t_i)` would return.
    pub async fn sample(
        &self,
        feed: Address,
        start: u64,
        end: u64,
        interval: u64,
    ) -> Result<Vec<Sample>> {
        if interval == 0 {
            bail!("interval must be > 0");
        }
        if end < start {
            bail!("end must be >= start");
        }
        let n = (end - start) / interval;
        if n >= MAX_SAMPLES {
            bail!("too many samples ({n}); raise the interval");
        }
        let times: Vec<u64> = (0..=n).map(|i| start + i * interval).collect();
        let ctx = self.ctx(feed).await?;

        // group consecutive times by the phase that serves them (non-decreasing in t)
        let mut groups: Vec<(u16, Vec<u64>)> = Vec::new();
        for &t in &times {
            let p = self
                .phase_for(feed, ctx.phase, t)
                .await?
                .ok_or(FeedError::WindowPredatesFeed(t))?;
            match groups.last_mut() {
                Some((q, v)) if *q == p => v.push(t),
                _ => groups.push((p, vec![t])),
            }
        }

        let mut out = Vec::with_capacity(times.len());
        for (phase, ts) in groups {
            let hi = self.last(feed, phase, &ctx).await?;
            let tmin = ts[0];
            let tmax = *ts.last().unwrap();
            let idx_lo = self
                .search(feed, phase, hi, tmin)
                .await?
                .ok_or(FeedError::WindowPredatesFeed(tmin))?;
            let idx_hi = self
                .search(feed, phase, hi, tmax)
                .await?
                .ok_or(FeedError::WindowPredatesFeed(tmax))?;
            let dense_rounds = idx_hi - idx_lo + 1;
            // Long horizons with coarse observations (for example 30 daily points) should not
            // download every 5–10 minute oracle round between them. Exact binary searches touch
            // far fewer rounds and still implement the same priceAt(t) rule.
            if dense_rounds > ts.len() as u64 * 16 {
                tracing::info!(
                    phase,
                    samples = ts.len(),
                    dense_rounds,
                    "using sparse Chainlink sampling"
                );
                for t in ts {
                    let idx = self
                        .search(feed, phase, hi, t)
                        .await?
                        .ok_or(FeedError::WindowPredatesFeed(t))?;
                    let round = self
                        .get_round(feed, phase, idx)
                        .await?
                        .ok_or_else(|| anyhow!("round {phase}/{idx} disappeared"))?;
                    out.push(Sample { t, round });
                }
                continue;
            }
            self.ensure_loaded(feed, phase, idx_lo, idx_hi).await?;
            let rounds: Vec<Round> = {
                let m = self.mem.lock().await;
                m.get(&(feed, phase))
                    .map(|p| p.rounds.range(idx_lo..=idx_hi).map(|(_, r)| *r).collect())
                    .unwrap_or_default()
            };
            let contiguous = rounds.len() as u64 == idx_hi - idx_lo + 1;
            if !contiguous {
                tracing::warn!(
                    phase,
                    idx_lo,
                    idx_hi,
                    have = rounds.len(),
                    "round range not contiguous; falling back to per-sample search"
                );
            }
            for t in ts {
                let r = if contiguous {
                    let pos = rounds.partition_point(|r| r.updated_at <= t);
                    if pos == 0 {
                        bail!("no round at or before t={t} in phase {phase}");
                    }
                    rounds[pos - 1]
                } else {
                    let idx = self
                        .search(feed, phase, hi, t)
                        .await?
                        .ok_or(FeedError::WindowPredatesFeed(t))?;
                    self.get_round(feed, phase, idx)
                        .await?
                        .ok_or_else(|| anyhow!("round {phase}/{idx} disappeared"))?
                };
                out.push(Sample { t, round: r });
            }
        }
        Ok(out)
    }
}

/// Merges overlapping/adjacent inclusive intervals.
pub fn coalesce(mut v: Vec<(u64, u64)>) -> Vec<(u64, u64)> {
    v.retain(|(a, b)| a <= b);
    v.sort_unstable();
    let mut out: Vec<(u64, u64)> = Vec::with_capacity(v.len());
    for (a, b) in v {
        match out.last_mut() {
            Some((_, hi)) if a <= hi.saturating_add(1) => *hi = (*hi).max(b),
            _ => out.push((a, b)),
        }
    }
    out
}

pub fn add_interval(mut v: Vec<(u64, u64)>, iv: (u64, u64)) -> Vec<(u64, u64)> {
    v.push(iv);
    coalesce(v)
}

/// Sub-ranges of `lo..=hi` not covered by `cov` (which must be coalesced and sorted).
pub fn missing_ranges(lo: u64, hi: u64, cov: &[(u64, u64)]) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    let mut cur = lo;
    for &(a, b) in cov {
        if b < cur {
            continue;
        }
        if a > hi {
            break;
        }
        if a > cur {
            out.push((cur, a - 1));
        }
        cur = cur.max(b.saturating_add(1));
        if cur > hi {
            break;
        }
    }
    if cur <= hi {
        out.push((cur, hi));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// In-memory feed: phase -> rounds (1-based index; each (updated_at, answer)).
    struct FakeFeed {
        phases: BTreeMap<u16, Vec<(u64, i128)>>,
        round_calls: AtomicUsize,
        dense_calls: AtomicUsize,
        /// mimic OCR aggregators: unknown rounds return zeroed data instead of reverting
        zeros_for_missing: bool,
    }

    impl FakeFeed {
        fn top(&self) -> u16 {
            *self.phases.keys().max().unwrap()
        }
    }

    #[async_trait]
    impl RoundSource for FakeFeed {
        async fn phase_id(&self, _feed: Address) -> Result<u16> {
            Ok(self.top())
        }
        async fn latest(&self, _feed: Address) -> Result<Round> {
            let p = self.top();
            let v = &self.phases[&p];
            let (u, a) = *v.last().unwrap();
            Ok(Round {
                phase: p,
                agg_round: v.len() as u64,
                answer: a,
                started_at: u,
                updated_at: u,
            })
        }
        async fn round(&self, _feed: Address, phase: u16, idx: u64) -> Result<Option<Round>> {
            self.round_calls.fetch_add(1, Ordering::Relaxed);
            let missing = |phase: u16| {
                if self.zeros_for_missing {
                    Some(Round {
                        phase,
                        agg_round: idx,
                        answer: 0,
                        started_at: 0,
                        updated_at: 0,
                    })
                } else {
                    None
                }
            };
            let Some(v) = self.phases.get(&phase) else {
                return Ok(missing(phase));
            };
            if idx == 0 {
                return Ok(None);
            }
            Ok(v.get(idx as usize - 1)
                .map(|(u, a)| Round {
                    phase,
                    agg_round: idx,
                    answer: *a,
                    started_at: *u,
                    updated_at: *u,
                })
                .or_else(|| missing(phase)))
        }
        async fn rounds(
            &self,
            feed: Address,
            phase: u16,
            lo: u64,
            hi: u64,
        ) -> Result<Vec<Option<Round>>> {
            self.dense_calls.fetch_add(1, Ordering::Relaxed);
            let mut out = vec![];
            for i in lo..=hi {
                out.push(self.round(feed, phase, i).await?);
            }
            self.round_calls
                .fetch_sub((hi - lo + 1) as usize, Ordering::Relaxed);
            Ok(out)
        }
    }

    const FEED: Address = Address::ZERO;

    /// Phase 1: 1000..=1900 every 100s. Phase 2: starts 1850 (overlaps phase 1's tail), every 60s to 5000.
    /// Phase 3: starts 4990, every 30s to 7000. Irregular spacing sprinkled in.
    fn feed() -> FakeFeed {
        let mut phases = BTreeMap::new();
        let mut p1 = vec![];
        let mut t = 1000;
        let mut i = 0i128;
        while t <= 1900 {
            p1.push((t, 2000_0000_0000 + i * 1_0000_0000));
            t += 100;
            i += 1;
        }
        let mut p2 = vec![];
        let mut t = 1850;
        while t <= 5000 {
            p2.push((t, 2100_0000_0000 + (t as i128 % 7) * 1_0000_0000));
            t += if t % 180 == 0 { 45 } else { 60 };
        }
        let mut p3 = vec![];
        let mut t = 4990;
        while t <= 7000 {
            p3.push((t, 2200_0000_0000 + (t as i128 % 5) * 1_0000_0000));
            t += 30;
        }
        phases.insert(1, p1);
        phases.insert(2, p2);
        phases.insert(3, p3);
        FakeFeed {
            phases,
            round_calls: AtomicUsize::new(0),
            dense_calls: AtomicUsize::new(0),
            zeros_for_missing: false,
        }
    }

    /// Reference implementation of §3.3 directly over the fake data.
    fn reference_price_at(f: &FakeFeed, t: u64) -> Option<Round> {
        let mut p = f.top();
        loop {
            let v = &f.phases[&p];
            if v[0].0 <= t {
                let idx = v.iter().rposition(|(u, _)| *u <= t).unwrap();
                let (u, a) = v[idx];
                return Some(Round {
                    phase: p,
                    agg_round: idx as u64 + 1,
                    answer: a,
                    started_at: u,
                    updated_at: u,
                });
            }
            if p == 1 {
                return None;
            }
            p -= 1;
        }
    }

    async fn cl() -> Chainlink<FakeFeed> {
        Chainlink::new(feed(), Db::connect_memory().await.unwrap())
    }

    #[tokio::test]
    async fn price_at_inside_current_phase() {
        let c = cl().await;
        let r = c.price_at(FEED, 6000).await.unwrap();
        assert_eq!(r.phase, 3);
        assert!(r.updated_at <= 6000 && r.updated_at + 30 > 6000);
        assert_eq!(r, reference_price_at(c.source(), 6000).unwrap());
    }

    #[tokio::test]
    async fn price_at_crosses_into_previous_phase() {
        let c = cl().await;
        // just before phase 3's first round -> served by phase 2
        let r = c.price_at(FEED, 4989).await.unwrap();
        assert_eq!(r.phase, 2);
        assert_eq!(r, reference_price_at(c.source(), 4989).unwrap());
        // exactly at the phase 3 first round -> phase 3, round 1 (current phase wins in the overlap)
        let r = c.price_at(FEED, 4990).await.unwrap();
        assert_eq!((r.phase, r.agg_round), (3, 1));
        // overlap of phase 1/2 tails: t=1870 is served by phase 2 (its first round 1850 <= t)
        let r = c.price_at(FEED, 1870).await.unwrap();
        assert_eq!(r.phase, 2);
        // t=1849 -> phase 1
        let r = c.price_at(FEED, 1849).await.unwrap();
        assert_eq!(r.phase, 1);
        assert_eq!(r.updated_at, 1800);
    }

    #[tokio::test]
    async fn price_before_feed_history_is_an_error() {
        let c = cl().await;
        let e = c.price_at(FEED, 999).await.unwrap_err();
        assert!(
            matches!(
                e.downcast_ref::<FeedError>(),
                Some(FeedError::WindowPredatesFeed(999))
            ),
            "{e}"
        );
    }

    #[tokio::test]
    async fn sample_matches_reference_across_phase_boundaries_and_caches() {
        let c = cl().await;
        // hourly-ish sampling every 250s across all three phases
        let samples = c.sample(FEED, 1100, 6900, 250).await.unwrap();
        assert_eq!(samples.len(), (6900 - 1100) / 250 + 1);
        let phases: std::collections::BTreeSet<u16> =
            samples.iter().map(|s| s.round.phase).collect();
        assert_eq!(phases.into_iter().collect::<Vec<_>>(), vec![1, 2, 3]);
        for s in &samples {
            let want = reference_price_at(c.source(), s.t).unwrap();
            assert_eq!(s.round, want, "t={}", s.t);
        }
        assert!(
            c.source().dense_calls.load(Ordering::Relaxed) >= 3,
            "dense fetch used per phase"
        );

        // second call: everything is served from the cache (no per-round or dense source calls)
        let before = c.source().round_calls.load(Ordering::Relaxed);
        let dense_before = c.source().dense_calls.load(Ordering::Relaxed);
        let again = c.sample(FEED, 1100, 6900, 250).await.unwrap();
        assert_eq!(again.len(), samples.len());
        assert_eq!(
            c.source().round_calls.load(Ordering::Relaxed),
            before,
            "no round() calls on warm cache"
        );
        assert_eq!(
            c.source().dense_calls.load(Ordering::Relaxed),
            dense_before,
            "no dense calls on warm cache"
        );

        // window starting before the feed -> error
        let e = c.sample(FEED, 500, 2000, 100).await.unwrap_err();
        assert!(matches!(
            e.downcast_ref::<FeedError>(),
            Some(FeedError::WindowPredatesFeed(500))
        ));
    }

    #[tokio::test]
    async fn sparse_sampling_matches_price_at_without_dense_history() {
        let c = cl().await;
        let samples = c.sample(FEED, 4990, 6990, 1000).await.unwrap();
        assert_eq!(samples.len(), 3);
        for sample in &samples {
            assert_eq!(
                sample.round,
                reference_price_at(c.source(), sample.t).unwrap(),
                "t={}",
                sample.t
            );
        }
        assert_eq!(
            c.source().dense_calls.load(Ordering::Relaxed),
            0,
            "coarse windows should binary-search exact sample rounds instead of loading every round"
        );
    }

    #[tokio::test]
    async fn cache_survives_a_new_chainlink_instance_on_the_same_db() {
        let db = Db::connect_memory().await.unwrap();
        let c1 = Chainlink::new(feed(), db.clone());
        let first = c1.sample(FEED, 2000, 4800, 200).await.unwrap();
        let c2 = Chainlink::new(feed(), db);
        let second = c2.sample(FEED, 2000, 4800, 200).await.unwrap();
        assert_eq!(first.len(), second.len());
        assert!(first.iter().zip(&second).all(|(a, b)| a.round == b.round));
        assert_eq!(
            c2.source().dense_calls.load(Ordering::Relaxed),
            0,
            "sqlite coverage reused"
        );
    }

    #[tokio::test]
    async fn aggregators_returning_zeroed_rounds_are_handled_like_reverts() {
        // Real Base ETH/USD phases 1-3 answer getRoundData for unknown ids <= 2^32 with zeros.
        let mut f = feed();
        f.zeros_for_missing = true;
        let c = Chainlink::new(f, Db::connect_memory().await.unwrap());
        let samples = c.sample(FEED, 1100, 6900, 250).await.unwrap();
        for s in &samples {
            assert_eq!(
                s.round,
                reference_price_at(c.source(), s.t).unwrap(),
                "t={}",
                s.t
            );
        }
        // closed-phase probing terminates and finds the true last round of phase 2
        let ctx = c.ctx(FEED).await.unwrap();
        let last2 = c.last(FEED, 2, &ctx).await.unwrap();
        assert_eq!(last2, c.source().phases[&2].len() as u64);
        let r = c.price_at(FEED, 4989).await.unwrap();
        assert_eq!((r.phase, r.agg_round), (2, last2));
        let e = c.price_at(FEED, 999).await.unwrap_err();
        assert!(matches!(
            e.downcast_ref::<FeedError>(),
            Some(FeedError::WindowPredatesFeed(999))
        ));
    }

    #[test]
    fn interval_helpers() {
        assert_eq!(
            coalesce(vec![(5, 7), (1, 3), (4, 4), (10, 12)]),
            vec![(1, 7), (10, 12)]
        );
        assert_eq!(add_interval(vec![(1, 3)], (5, 6)), vec![(1, 3), (5, 6)]);
        assert_eq!(add_interval(vec![(1, 3)], (4, 6)), vec![(1, 6)]);
        assert_eq!(missing_ranges(1, 10, &[]), vec![(1, 10)]);
        assert_eq!(
            missing_ranges(1, 10, &[(3, 4), (8, 8)]),
            vec![(1, 2), (5, 7), (9, 10)]
        );
        assert_eq!(missing_ranges(4, 6, &[(1, 10)]), Vec::<(u64, u64)>::new());
        assert_eq!(missing_ranges(4, 12, &[(1, 5), (20, 30)]), vec![(6, 12)]);
    }
}
