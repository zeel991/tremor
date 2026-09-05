# Tremor — a two-sided variance market on 1inch Aqua

> **Trade ETH's tremor, not its direction.**

Tremor makes ETH realized variance a tradable instrument on **1inch Aqua**, priced and settled by
**SwapVM programs on the official, unmodified `AquaSwapVMRouter`**.

A writer funds a maker vault. The vault ships three strategies. Buyers pay an executable ask for
receipt tokens, holders can sell them back at an executable bid before expiry, and after expiry every
receipt redeems for USDC at the variance ETH actually realized — computed **on chain from the Chainlink
feed's own round history**.

**Every unit sold is fully collateralized.** The vault reserves that unit's capped payout, and the
writer cannot withdraw the reservation, cannot revoke the vault's Aqua allowance, cannot move unsold
inventory, and cannot dock the strategies that pay holders out. A reservation is released only when the
receipt is burned — on exit or on redemption.

The same realized-variance primitive prices a volatility-adaptive spread for an Aqua AMM. Because an
LP's loss-versus-rebalancing is proportional to variance (Milionis, Moallemi, Roughgarden, Zhang), the
instrument that pays variance is the instrument that sizes an LVR hedge. Tremor is the first place both
live on the same shared-liquidity layer.

## Why a variance receipt, not options

An option needs a strike, an exercise right, a surface and a settlement price. A capped variance receipt
needs one number. The payoff is a realized statistic of the price path, so it can be **settled from
immutable history** with no oracle write, no keeper and no dispute — `quote()` and `swap()` run identical
arithmetic and must agree. And because the payoff is capped, the writer's worst case is a known constant,
which is exactly what makes full collateralization possible:

```
payoutPerUnit = floor(unitNotional · min(realizedVariance, capVariance) / 1e18)
maxLiability  = ceil(units · unitNotional · capVariance / 1e36)      reserved the moment a unit sells
```

## Three legs, no custom opcodes

```
ISSUE   Salt(id,1) · Deadline(saleEnd) · Extruction(engine, [1,1,id])     USDC → receipts
EXIT    Salt(id,2) · Deadline(expiry)  · Extruction(engine, [1,2,id])     receipts → USDC   + burn hook
SETTLE  Salt(id,3) ·                     Extruction(engine, [1,3,id])     receipts → USDC   + burn hook
```

Three stock SwapVM instructions — `Salt` (`0x02`), `Deadline` (`0x20`), `Extruction` (`0x04`) — and all
of Tremor's pricing behind the `Extruction` target, `TremorMarketEngine`. There are no custom opcodes and
no forked router. `contracts/test/RouterCompat.t.sol` proved that before any production encoding
depended on it, and it records what the canonical SwapVM address on Base actually is rather than what we
wished it were.

EXIT and SETTLE draw on **one real balance** through two virtual Aqua allocations, which is safe because
either path burns the receipt it pays for: a unit can be exited or redeemed, never both. The engine bounds
every payout by the liability that burn releases.

| Contract | Responsibility |
|---|---|
| `VarianceSeriesFactory` | Controller: validates and creates series, ships all three strategies, owns every reservation |
| `TremorMarketEngine` | The `Extruction` target that prices ISSUE, EXIT and SETTLE |
| `TremorMakerVault` | One per writer. Deterministic address, no admin, no upgrade path, no rescue function |
| `VarianceAccumulator` | Bounded permissionless checkpointing, and permissionless finalization |
| `VarianceReceipt` | Per-series ERC-20 whose router-only maker hook burns every unit that leaves |
| `TremorLens` / `TremorPrograms` | Read models: live quotes, vault state, oracle progress, raw programs |
| `RealizedVarianceOracle` | Trailing realized variance for the LVR tools |

## How it prices

One number drives both sides: the variance the market projects for the whole window.

```
forward   = clamp(anchorVariance + skew · 2^(−dt/halfLife), 0, cap)
projected = (realizedSoFar · elapsed + forward · remaining) / duration
ask/bid   = min(projected · (1 ± halfSpread), cap)
```

Buying raises the skew, exiting lowers it, and it decays back on a half-life. Fills are priced at the
**integral** of the marginal price across the size, so splitting a fill cannot beat one fill. As the
window progresses the projection converges on what actually happened, which is what stops a late buyer
from pricing off variance that has already printed.

Nothing here is implied volatility — there is no option surface anywhere in Tremor. It is one market's
quote, and it is executable.

## Repository

```
contracts/   Foundry: the contracts above, the pricing library and its 60-digit reference vectors,
             171 tests including stateful invariants and a Base-fork adversarial demo
backend/     Rust (axum): event indexer, Chainlink round cache, off-chain replicas, read API on :8787
subgraph/    The Graph: the same event history as entities
web/         Next.js 16: markets, the series terminal, the write flow, portfolio, LVR calculator, docs
sim/         Ten-scenario economic simulation against an integer replica of the deployed pricing
ARCHITECTURE.md  the binding spec shared by all of them   ·   DESIGN.md  the visual system
```

## Run it

Clone with submodules and install the SwapVM library's Node dependencies once — the Foundry remappings
point at them:

```bash
git clone --recurse-submodules <repo> tremor && cd tremor
cd contracts/lib/swap-vm && yarn install --frozen-lockfile && cd ../../..
```

Then bring the whole stack up with one command. It forks Base, deploys, seeds the demo lifecycle,
starts the indexer and serves the app, skipping any step already satisfied:

```bash
make dev                    # chain :8545 + API :8787 + web :3000
scripts/dev.sh --fresh      # re-fork and redeploy from scratch
scripts/dev.sh --no-seed    # deploy the contracts but skip the demo lifecycle
WEB_PORT=3100 scripts/dev.sh
```

Ctrl-C stops everything it started; logs land in `.dev-logs/`. The individual targets still work if you
would rather run one piece at a time:

```bash
make anvil                     # terminal 1: fork Base mainnet (canonical Aqua, real USDC, real ETH/USD feed)
make test && make demo         # terminal 2: 171 tests, then deploy + every demo stage with balance asserts
make backend                   # terminal 3
make web                       # terminal 4 → http://localhost:3000
```

`demo.sh` stage C is the interesting one: it attempts every attack a writer might try — withdrawing
reserved collateral, revoking the Aqua allowance, moving unsold inventory, docking a burn leg — and
shows all of them reverting. Stage E creates a **chain-31337-only back-dated 5-day series**, walks real
Chainlink history in bounded permissionless checkpoints, finalizes, redeems and closes, asserting USDC
deltas at every step.

## Status (verified 2026-09-08)

| Check | Result |
|---|---|
| Foundry suite, 14 suites, fuzz 128 runs | **171 passed, 0 failed** |
| Stateful invariants | 9 invariants pass, with a scripted test proving the handler can reach every state (non-vacuity) |
| Base-fork E2E vs canonical Aqua + real ETH/USD | pass; 61-sample window walked in 8 bounded calls, finalized, redeemed |
| Measured gas, Base fork | checkpoint 513,002 (8 samples) · finalize 159,192 · redeem 296,021 · buy 234,481 · exit 241,866 |
| Pricing reference vectors | 60 cases at 60 digits; Solidity and the TypeScript replicas agree exactly |
| Contract sizes | controller 17,892 runtime / 46,484 initcode (2,668 under EIP-3860); every contract inside EIP-170 |
| Backend | `cargo fmt`, strict clippy, 46 tests, release build — all pass |
| Subgraph | install, codegen, build — pass |
| Web | 25 unit tests, typecheck, ESLint, 33-route production build — all pass |
| Simulation | ten scenarios, no invariant failures (`sim/out/report.md`) |

## Honest caveats

- **The cap truncates.** A violent window can realize far above the cap; holders get the cap. Every
  screen states the cap in volatility terms and the payoff chart flattens where it flattens.
- **Somebody has to press a button.** Checkpointing and finalization are permissionless and bounded, but
  nobody is paid for them. They happen because everyone who wants anything from a series — a quote, a
  redemption, the cap surplus — needs them done.
- **Exit depth is finite.** A large exit fills up to the zero-bid point and is additionally clamped by the
  collateral the burn releases, so it partially fills at a worse average than the top-of-book bid.
- **Feed gaps bias variance downward.** A repeated Chainlink round contributes a zero return; the
  30-minute floor on the sampling grid exists because a finer grid made this common on Base.
- **Not an order book, not a conventional variance swap, not a fair-value oracle, not a perfect LVR
  hedge.** See [trust surface](web/src/content/docs/about/trust-surface.md).

## Deployments

See `contracts/deployments/<chainId>.json` (manifest schema version 2, which pins the router's source
commit and bytecode hash). Local fork `31337`; public Base Sepolia `84532`. Canonical Aqua on Base:
`0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`.
