//! Tremor backend (`tremor-api`): indexes the controller, the accumulator, the writer vaults, the
//! official router and Aqua; caches Chainlink rounds; reproduces the on-chain variance and pricing
//! math off-chain for charts; and serves read models.
//!
//! It never holds keys and never sends transactions. Executable numbers come from `TremorLens`, which
//! calls the same engine the router does. Checkpointing and finalization are permissionless and are
//! driven from the web app with the user's own wallet, which is why there is no keeper here.
//!
//! `--reset-db` drops the indexed history and rebuilds it from the chain. It is the only way past a
//! schema change, and it is deliberately an explicit operator action.

mod abi;
mod api;
mod chainlink;
mod config;
mod db;
mod error;
mod indexer;
mod lens;
mod market;
mod rpc;
mod rv;
mod util;

use std::sync::Arc;

use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use anyhow::Context;
use tracing_subscriber::EnvFilter;

/// Shared application state handed to every handler and the indexer task.
pub struct AppState {
    pub cfg: config::Config,
    pub manifest: config::Manifest,
    pub provider: DynProvider,
    pub db: db::Db,
    pub chainlink: chainlink::Chainlink<chainlink::RpcRoundSource>,
    pub lens: lens::LensClient,
    pub indexer: indexer::IndexerHandle,
    pub feed_decimals: u8,
    /// The accumulator's own per-call sample ceiling, read at startup so the UI can size its
    /// checkpoint transactions without hardcoding a number that could drift.
    pub max_samples_per_checkpoint: u16,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("tremor_api=info,tower_http=info")),
        )
        .with_target(false)
        .init();

    let reset_db = std::env::args().any(|a| a == "--reset-db");

    let cfg = config::Config::from_env()?;
    let manifest = config::Manifest::load(&cfg.deployment_json)
        .with_context(|| format!("loading DEPLOYMENT_JSON={}", cfg.deployment_json.display()))?;
    tracing::info!(
        manifest = %cfg.deployment_json.display(), chain_id = manifest.chain_id,
        controller = %manifest.series_factory, engine = %manifest.market_engine,
        accumulator = %manifest.accumulator, router = %manifest.router, lens = %manifest.lens,
        feed = %manifest.feed, deployment_block = manifest.deployment_block, "tremor-api starting"
    );

    let url = cfg.rpc_url.parse().context("RPC_URL is not a valid URL")?;
    let provider: DynProvider = ProviderBuilder::new().connect_http(url).erased();

    let chain_id = provider
        .get_chain_id()
        .await
        .context("RPC not reachable at startup")?;
    anyhow::ensure!(
        chain_id == manifest.chain_id,
        "RPC chain id {chain_id} does not match manifest chain id {}",
        manifest.chain_id
    );

    // Readiness, not optimism: a manifest that names contracts with no code on this chain is a
    // misconfiguration, and finding out per request would be worse than finding out now.
    for (what, address) in [
        ("seriesFactory", manifest.series_factory),
        ("marketEngine", manifest.market_engine),
        ("accumulator", manifest.accumulator),
        ("lens", manifest.lens),
        ("router", manifest.router),
        ("aqua", manifest.aqua),
        ("usdc", manifest.usdc),
        ("feed", manifest.feed),
        ("portfolioMarket", manifest.portfolio_market),
        ("portfolioAccumulator", manifest.portfolio_accumulator),
    ] {
        let code = provider
            .get_code_at(address)
            .await
            .with_context(|| format!("reading code at {what} {address}"))?;
        anyhow::ensure!(
            !code.is_empty(),
            "manifest {what} {address} has no code on chain {chain_id}"
        );
    }

    // And the stack must be wired to itself, exactly as the deployment script asserted.
    {
        let controller = abi::VarianceSeriesFactory::new(manifest.series_factory, provider.clone());
        let engine = controller
            .ENGINE()
            .call()
            .await
            .context("controller.ENGINE()")?;
        let accumulator = controller
            .ACCUMULATOR()
            .call()
            .await
            .context("controller.ACCUMULATOR()")?;
        let router = controller
            .ROUTER()
            .call()
            .await
            .context("controller.ROUTER()")?;
        anyhow::ensure!(
            engine == manifest.market_engine,
            "manifest marketEngine {} is not the controller's engine {engine}",
            manifest.market_engine
        );
        anyhow::ensure!(
            accumulator == manifest.accumulator,
            "manifest accumulator {} is not the controller's accumulator {accumulator}",
            manifest.accumulator
        );
        anyhow::ensure!(
            router == manifest.router,
            "manifest router {} is not the controller's router {router}",
            manifest.router
        );
    }

    let db = db::Db::connect(&cfg.database_url).await?;
    db.migrate(reset_db).await?;

    let feed_decimals = {
        let feed = abi::AggregatorV3::new(manifest.feed, provider.clone());
        feed.decimals()
            .call()
            .await
            .context("could not read configured feed decimals")?
    };
    let max_samples_per_checkpoint = {
        let acc = abi::VarianceAccumulator::new(manifest.accumulator, provider.clone());
        acc.MAX_SAMPLES_PER_CALL()
            .call()
            .await
            .context("could not read the accumulator's per-call sample ceiling")?
    };

    let chainlink =
        chainlink::Chainlink::new(chainlink::RpcRoundSource::new(provider.clone()), db.clone());
    let lens = lens::LensClient::new(manifest.lens, provider.clone());
    let indexer_handle = indexer::IndexerHandle::new(Some(chain_id));

    let state = Arc::new(AppState {
        cfg: cfg.clone(),
        manifest,
        provider,
        db,
        chainlink,
        lens,
        indexer: indexer_handle,
        feed_decimals,
        max_samples_per_checkpoint,
    });

    tokio::spawn(indexer::run(state.clone()));

    let app = api::router(state.clone());
    let addr = std::net::SocketAddr::from((cfg.bind_address, cfg.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding {addr}"))?;
    tracing::info!(%addr, "listening");
    axum::serve(listener, app).await?;
    Ok(())
}
