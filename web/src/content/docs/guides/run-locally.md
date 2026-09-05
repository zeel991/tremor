The whole stack runs against an **anvil fork of Base mainnet**: canonical Aqua, the official SwapVM router source, real USDC and the real Chainlink ETH/USD feed, with Tremor's contracts deployed on top.

## Prerequisites

Foundry (`anvil`, `forge`, `cast`), Rust stable, Node 20+, Python 3 (reference vectors), and a Base RPC URL (`BASE_RPC_URL`, default `https://mainnet.base.org`).

Clone with submodules and install the SwapVM library's Node dependencies once — the Foundry remappings point at them:

```bash
git clone --recurse-submodules <repo> tremor && cd tremor
cd contracts/lib/swap-vm && yarn install --frozen-lockfile && cd ../../..
```

## One command

```bash
make dev
```

`scripts/dev.sh` brings up the chain, deploys, seeds the demo lifecycle, starts the API and starts the web app, in that order, skipping any step already satisfied. It stays in the foreground and stops what it started.

```bash
scripts/dev.sh --fresh     # re-fork the chain and redeploy + reseed from scratch
scripts/dev.sh --no-seed   # deploy the contracts but skip the demo lifecycle
```

## Or four terminals

```bash
make anvil                     # 1: fork Base mainnet
make test && make demo         # 2: the Foundry suite, then deploy + every demo stage with balance asserts
make backend                   # 3: the Rust API on :8787
make web                       # 4: the web app on :3000
```

| Target | Command |
|---|---|
| `make anvil` | `anvil --fork-url $BASE_RPC_URL --chain-id 31337 --auto-impersonate --port 8545` |
| `make test` | `cd contracts && BASE_RPC_URL=… forge test -vv` |
| `make demo` | `cd contracts && ./script/demo.sh && ./script/sync-deployment.sh 31337 && ./script/export-abi.sh` |
| `make backend` | `cd backend && RPC_URL=… DEPLOYMENT_JSON=../contracts/deployments/31337.json cargo run --release` |
| `make web` | `cd web && npm run dev -- --port 3000` |

## What `demo.sh` does

1. **Fund** — impersonates an aUSDC holder and sends 1,000,000 USDC to anvil accounts 0/1/2.
2. **Deploy** — deploys the **unmodified official `AquaSwapVMRouter`** from the pinned submodule, then `RealizedVarianceOracle`, `VarianceSeriesFactory` (which itself deploys the accumulator, the engine and the series deployer), `TremorPrograms` and `TremorLens`, and writes `deployments/31337.json`.
3. **Stage A** — a protected writer vault and a forward series: all three Aqua strategies shipped, nothing reserved yet.
4. **Stage B** — issuance: buyer 1 takes 20 units, buyer 2 takes 10 at a higher ask, and the sold-unit liability locks in the vault.
5. **Stage C** — **writer attacks, all of which revert**: withdrawing reserved collateral, revoking the Aqua allowance, moving unsold inventory, docking a burn leg. Simulated rather than broadcast, because a reverting transaction cannot be broadcast.
6. **Stage C+** — what the writer legitimately can do: take the premiums, and nothing else.
7. **Stage D** — buyer 1 exits 8 units before expiry at the executable bid; receipts burn and the liability releases.
8. **Stage E** — a back-dated series: bounded permissionless checkpoints of **real** Chainlink history, then finalize, redeem and close, with USDC deltas asserted at every step.
9. **Stage F** — warms the trailing realized-variance cache the LVR page reads.
10. **Sync + ABI** — copies the manifest to `web/src/config/deployment.json` and exports ABI arrays to `web/src/abi/` and `backend/abi/`.

Every stage asserts balances and aborts loudly.

> The exported ABIs are how the web app and the backend decode the Lens. If you redeploy without re-running `export-abi.sh`, a stale ABI will decode the live struct into the wrong fields and every number on the page will be quietly wrong. `make demo` always does both.

## Backend

```bash
cd backend
cargo build --release
RPC_URL=http://127.0.0.1:8545 DEPLOYMENT_JSON=../contracts/deployments/31337.json cargo run --release
```

| Var | Default | Meaning |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8545` | JSON-RPC endpoint |
| `DEPLOYMENT_JSON` | `../contracts/deployments/31337.json` | Manifest written by `Deploy.s.sol` (schema version 2) |
| `DATABASE_URL` | `sqlite://tremor.db` | SQLite file, created if missing (WAL mode) |
| `PORT` | `8787` | Listen port |
| `POLL_MS` | `3000` | Indexer poll interval |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed origin(s), comma-separated, or `*` |
| `RUST_LOG` | `tremor_api=info,tower_http=info` | Log filter |

`--reset-db` drops and recreates the schema, which is what a redeploy needs. The backend holds no keys and sends no transactions: setting `CHECKPOINT_PRIVATE_KEY` is a deliberate startup error rather than an opt-in.

## Web

```bash
cd web
npm install
cp .env.example .env.local
npm run dev -- --port 3000
```

| Var | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8787` | Rust backend |
| `NEXT_PUBLIC_RPC_URL` | `http://127.0.0.1:8545` | JSON-RPC of the active chain |
| `NEXT_PUBLIC_CHAIN_ID` | `31337` | `31337` Tremor Fork, `84532` Base Sepolia, `8453` Base |
| `NEXT_PUBLIC_TREMOR_SUBGRAPH_URL` | unset | Optional Base Sepolia Graph endpoint for historical fills, checkpoints and finalization; local Anvil uses the backend fallback |

The app degrades gracefully: with no deployment it shows a "not deployed" banner; with the backend down it shows quiet "API offline" states and still renders everything the RPC can answer, because every executable number comes from the chain anyway. This build points at `{{rpcUrl}}` and `{{apiUrl}}`.

## Subgraph

```bash
make subgraph-install
make subgraph-codegen
make subgraph-build
make subgraph-configure    # from a Base Sepolia manifest
```

## Public testnet

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --account <keystore>
./script/sync-deployment.sh 84532
```

With `AQUA` unset the script deploys its own Aqua and a `MockUSDC`. Chainlink ETH/USD on Base Sepolia is `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1`.
