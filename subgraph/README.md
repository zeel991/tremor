# Tremor subgraph

The composable history layer for Tremor, the covered market for capped ETH realized-variance receipts.

It indexes what actually happened: writer vaults being created, funded and drawn down; series being
created with all three of their Aqua strategies; ISSUE, EXIT and SETTLE fills; the bounded permissionless
checkpoints that walk each observation window forward; finalizations; and per-wallet receipt balances
including the mints and burns.

It is deliberately not an authority for anything executable. Locked collateral, the current bid and ask,
outstanding units and the final payout all come from `TremorLens`, which calls the same engine the router
calls. A subgraph is minutes behind by construction, and a price a user can act on cannot be minutes
behind. No mapping here is allowed to become a second implementation of the settlement math.

## What is indexed

| Entity | Source | What it is for |
| --- | --- | --- |
| `Vault` | controller `VaultCreated` + the vault's own events | the writer's protected maker: who created it, what has been deposited and withdrawn |
| `VaultAction` | vault template | the writer-side audit trail: deposits, free withdrawals, every lock movement, every strategy shipped or docked |
| `Series` | controller `SeriesCreated` and the lifecycle events | immutable terms, plus cumulative units and quote flows per leg |
| `Order` | controller `SeriesCreated` | Aqua strategy hash → `(series, leg)`, which is how a `Swapped` is attributed |
| `Fill` | router `Swapped` | one fill, with `units` always the receipt side and `quoteAmount` always the quote side |
| `Checkpoint` | accumulator `Checkpointed` | one bounded step of the window, with the Chainlink round it landed on and the address that paid for it |
| `Finalization` | controller `Finalized` | the moment variance stopped being a projection, and the collateral the cap surplus released |
| `ReceiptBalance` | receipt template `Transfer` | receipt units per account, including mints to the vault and the burns that consume a claim |

The `caller` on `Checkpoint` and `Finalization` is recorded on purpose: both are permissionless, and the
history of who moved the window forward is the evidence that nobody had to be trusted to.

## Configure and build

The checked-in manifest carries zero addresses. That is deliberate — a subgraph shipping with somebody's
old testnet addresses baked in is worse than one that obviously needs configuring.

```bash
make subgraph-install
make subgraph-codegen
make subgraph-build
```

After a Base Sepolia deployment exists:

```bash
make subgraph-configure   # node scripts/configure.mjs 84532
make subgraph-codegen
make subgraph-build
```

`configure.mjs` reads `contracts/deployments/84532.json`, refuses anything but manifest schema v2, and
writes both `subgraph.yaml` and `networks.json` with the deployed controller, accumulator and router
addresses. It matches each data source by name, so the three can never be crossed over, and it is
repeatable.

The local Anvil fork is intentionally not a subgraph target: the fork workflow recreates the same
deterministic addresses on every run, and the web app's local path reads the chain and the Rust API
directly.

## ABIs

`abis/*.json` are copies of the exports `contracts/script/export-abi.sh` writes. After any contract
event changes shape, re-export, copy them in, and re-run codegen — the generated types are what would
otherwise decode a live event into the wrong fields silently.

## Generated output

`node_modules/`, `generated/` and `build/` are all produced by `graph-cli` and none of them belong in
git; the repository's `.gitignore` excludes all three.
