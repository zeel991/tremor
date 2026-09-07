Tremor is a two-sided market in **capped ETH realized-variance receipts**, built on the **official 1inch Aqua and SwapVM contracts**. A writer funds a maker vault; the vault ships three SwapVM strategies; buyers pay an executable ask for receipt tokens, holders can sell them back at an executable bid before expiry, and after expiry every receipt redeems for USDC at the realized variance **computed on-chain from the Chainlink feed's own round history**.

Every unit sold is **fully collateralized**: the vault reserves that unit's capped payout, and the writer cannot withdraw the reservation, cannot revoke the vault's Aqua allowance, cannot move unsold inventory, and cannot dock the strategies that pay holders out.

The same realized-variance primitive prices a vol-adaptive spread for an Aqua AMM, so an LP can measure and hedge loss-versus-rebalancing (LVR ∝ σ²) with the instrument that pays σ².

## Aqua and SwapVM in one paragraph

Aqua is 1inch's shared-liquidity layer: a maker *ships* a strategy (a SwapVM program plus the tokens it may draw on) and Aqua records **virtual balances**. Nothing is deposited into Aqua — when a taker swaps, Aqua pulls from the maker with `transferFrom` and pushes the taker's tokens back. A SwapVM program is a flat list of instructions `[opcode:1][argsLength:1][args]`; the router runs them in order and the last *terminal* instruction fixes the price.

Tremor runs on the **unmodified official `AquaSwapVMRouter`**. Every Tremor program is built from three stock instructions — `Salt` (`0x02`), `Deadline` (`0x20`) and `Extruction` (`0x04`) — and all of Tremor's pricing lives behind the `Extruction` target. There are no custom opcodes and no forked router. See [Running on the official router](/docs/programs/official-router).

## The three legs

A series is three Aqua strategies, all shipped from the writer's vault by `VarianceSeriesFactory.createSeries`:

```text
ISSUE   Salt(id,1) · Deadline(saleEnd) · Extruction(engine, [1,1,id])     USDC → receipts
EXIT    Salt(id,2) · Deadline(expiry)  · Extruction(engine, [1,2,id])     receipts → USDC   + burn hook
SETTLE  Salt(id,3) ·                     Extruction(engine, [1,3,id])     receipts → USDC   + burn hook
```

Each of EXIT and SETTLE is shipped with a virtual USDC balance covering the whole capped liability, but both draw on **one real balance** — the writer's vault. That is safe because either path burns the receipt it is paid for: a unit can be exited or redeemed, never both. The engine bounds every payout by the liability that burn releases, so the two virtual allocations can never both be spent on the same unit.

## What is deployed

| Contract | Responsibility |
|---|---|
| `AquaSwapVMRouter` | The official router, deployed unmodified from the upstream source |
| `VarianceSeriesFactory` | Controller: validates and creates series, ships all three strategies, owns every reservation |
| `TremorMarketEngine` | The `Extruction` target that prices ISSUE, EXIT and SETTLE |
| `TremorMakerVault` | One per writer. Deterministic address, no admin, no upgrade path, no rescue function |
| `VarianceAccumulator` | Bounded permissionless checkpointing of the observation window, and permissionless finalization |
| `VarianceReceipt` | Per-series ERC-20. Its router-only maker hook burns every unit that leaves through EXIT or SETTLE |
| `TremorSeriesDeployer` | `CREATE2` deployer for vaults and receipts, so a vault address is a pure function of its writer |
| `TremorLens` | Batched read model: live quotes, vault state, oracle progress, leg status |
| `TremorPrograms` | Stateless read model for the raw orders, programs and ship plans |
| `RealizedVarianceOracle` | Trailing realized variance for the LVR tools and `VarianceSpread` |

Every constructor dependency must contain code, and the Lens verifies at construction that the controller, engine, accumulator, deployer and router all agree about each other. Contracts are immutable and non-upgradeable.

## Components

| Component | What it does |
|---|---|
| `contracts/` (Foundry) | The contracts above, the pricing library and its 60-digit reference vectors, unit and invariant suites, and a Base-fork adversarial demo |
| `backend/` (Rust, axum, `:8787`) | Indexes controller / router / Aqua / vault events, caches Chainlink rounds, replicates realized variance and the market quote off-chain for charts, serves the JSON read model. Holds no keys and sends no transactions. |
| `subgraph/` (The Graph) | Indexed historical entities—fills, checkpoints, finalization, vault activity and receipt balances; never the authority for live executable quotes or balances |
| `web/` (Next.js 16, `:3000`) | Markets, the series terminal, the write flow, portfolio, the LVR calculator and these docs. Live quotes and wallet actions go straight to the Lens and the router through viem/wagmi; history comes from the backend. |

The Lens and the on-chain quotes are **authoritative**. The backend is a replica: when the two disagree, the chain is right and the backend is stale.

## Deployer metadata

Values below are read from `web/src/config/deployment.json` for the chain this build targets.

| Deployer Metadata | Value |
|---|---|
| Name | Tremor |
| Chain | {{chainName}} (`{{chainId}}`) — {{deployed}} |
| Aqua | `{{aqua}}` |
| AquaSwapVMRouter | `{{router}}` |
| VarianceSeriesFactory | `{{seriesFactory}}` |
| TremorMarketEngine | `{{marketEngine}}` |
| VarianceAccumulator | `{{accumulator}}` |
| TremorSeriesDeployer | `{{seriesDeployer}}` |
| TremorPrograms | `{{programs}}` |
| TremorLens | `{{lens}}` |
| RealizedVarianceOracle | `{{oracle}}` |
| USDC (quote token) | `{{usdc}}` |
| Chainlink ETH/USD feed | `{{feed}}` |
| WETH | `{{weth}}` |
| Deployment block | `{{deploymentBlock}}` |

```cards
[{"href":"/markets","title":"Open the app","subtitle":"Every market on this chain with realized vol, bid, ask and locked backing","icon":"σ²"},
 {"href":"/docs/mechanics/series-parameters","title":"Market mechanics","subtitle":"Parameters, the two-sided quote, collateral, settlement","icon":"01"},
 {"href":"/docs/programs/market-engine","title":"SwapVM programs","subtitle":"The three programs and the engine behind them, byte for byte","icon":"0x"}]
```
