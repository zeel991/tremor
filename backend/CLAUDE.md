# backend/ — agent notes
Read `README.md` (env, endpoint table, indexer, ABI refresh) and the repo root `AGENTS.md`.
- `source $HOME/.cargo/env`; `cargo build --release`, `cargo test`, `cargo clippy --all-targets --all-features -- -D warnings`.
- Lens bindings come from `abi/TremorLens.json` via `build.rs`; run `contracts/script/export-abi.sh` after any contract ABI change,
  then rebuild. A stale ABI decodes a live contract into the wrong fields silently — that is the failure mode to watch for.
- `src/rv.rs` and `src/chainlink.rs` replicate `contracts/src/libs/RealizedVariance.sol`; `src/market.rs` replicates
  `contracts/src/libs/VariancePricing.sol`. If an on-chain formula changes, change the replica the same way and re-check parity
  against the Lens (`/series/:id/market` serves both side by side for exactly this reason).
- Never add signing or transaction sending. The API is read-only by design; checkpointing and finalization are permissionless and
  are submitted from the web app with the user's own wallet. `CHECKPOINT_WORKER` is a deliberate startup error.
- Schema and manifest are versioned. Bump `SCHEMA_VERSION` in `src/db.rs` and `MANIFEST_SCHEMA_VERSION` in `src/config.rs` together
  with the shape they describe, and never make startup destroy an indexed history without `--reset-db`.
