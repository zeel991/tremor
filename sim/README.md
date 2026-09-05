# `sim/` — Tremor v2 economic simulation

Ten scenarios against an integer replica of the deployed pricing library and the deployed vault
accounting. It answers one question: **is the accounting solvent, and is the writer's loss exactly
the short-variance exposure they sold?**

It is not a load test and it does not touch a chain. The previous version of this directory drove a
thousand wallets against a live anvil fork to stress the indexer; that harness was built around v1's
custom opcodes and a seller-as-maker design that no longer exists. What replaced it is the thing the
implementation plan actually asks for: vault solvency, mutually exclusive exit and settlement,
pricing behaviour, and writer P&L across the scenarios where everyone behaves.

```bash
npm install
npm run check      # pin the pricing replica against the Solidity reference vectors
npm run sim        # run all ten scenarios and write out/report.md + out/findings.md
npm run typecheck
```

```bash
npm run sim -- --seed 7                      # a different set of price paths
npm run sim -- --only at-cap,late-spike      # one or two scenarios
```

A run is reproducible from its seed alone: the PRNG is seeded, the epoch is fixed, and nothing reads
the clock or the network.

## Why the arithmetic can be trusted

`src/pricing.ts` is a line-by-line integer replica of `contracts/src/libs/VariancePricing.sol` —
the same formulas, the same rounding directions, the same clamps. `npm run check` runs it against
`contracts/test/vectors/pricing_vectors.json`, the same 60 cases generated at 60 decimal digits that
the Solidity library is tested with:

```
60 vector cases · 1140 checks · 0 failures · worst decaySkew relative error 2.32e-16
```

Every formula matches exactly except `decaySkew`, which the contract computes with Solady's `expWad`
and the replica with `Math.exp`. That divergence is measured rather than assumed away, and at 2.32e-16
relative it cannot move a quote by a base unit.

`src/market.ts` is the same kind of replica of the vault and the controller: reservations computed
from the aggregate outstanding position, payouts bounded by the liability a burn releases, solvency
asserted after every mutation. A scenario that broke the accounting would throw, not return a
plausible number.

## Layout

| File | What it is |
|---|---|
| `src/pricing.ts` | Integer replica of `VariancePricing.sol` |
| `src/market.ts` | The vault and one series as a state machine — reservations, the three legs, the accumulator |
| `src/paths.ts` | Seeded GBM price paths, specified by target volatility per segment |
| `src/scenarios.ts` | The ten scenarios and the driver that runs them |
| `src/report.ts` | Renders `out/report.md`, `out/findings.md` and a JSON artefact |
| `src/check.ts` | The reference-vector gate |
| `src/run.ts` | CLI |

## The scenarios

| Key | What it exercises |
|---|---|
| `low-realized` | Variance well below the quote — the writer's best case |
| `near-quote` | The break-even neighbourhood |
| `at-cap` | Variance at the cap — the writer's worst case, and its bound |
| `early-spike` | A spike then calm; the projection converging downward |
| `late-spike` | Calm then a spike, after issuance has closed |
| `heavy-issuance` | Demand large enough to hit the inventory and collateral clamps |
| `heavy-early-exits` | Everything bought on day one sold back on day two |
| `alternating-flow` | Repeated round trips against the market |
| `issuance-stopped` | The writer stops sales mid-window; exit and redemption unaffected |
| `shared-vault` | Three series competing for one vault's free collateral |

## What it deliberately does not do

- **It cannot prove a revert.** Every claim about what a writer *cannot* do belongs to the contracts
  and is tested there: `contracts/test/Adversarial.t.sol`, `contracts/test/Invariants.t.sol`, and
  stage C of `contracts/script/demo.sh` on a Base fork.
- **It does not measure gas.** Checkpoint calls and batch sizes are counted, but their cost is
  measured against the real Chainlink proxy in `contracts/test/ForkE2E.t.sol`, which is the only
  place the round search can honestly be timed.
- **It does not model feed pathology.** Paths are generated on the series' own sampling grid, so a
  sample never lands on a missing round. Real feeds repeat rounds, which biases realized variance
  downward — the reason the sampling grid has a 30-minute floor.

## Output

`out/report.md` — solvency, writer and buyer P&L, settlement, capital, the bid/ask path and the
projection, the LVR residual, and per-scenario notes.

`out/findings.md` — seven findings and what each one implies for the design.

`out/run-<timestamp>.json` — every snapshot and fill, for anyone who wants to plot it.

A non-zero exit code means an invariant failed. That is a blocker, not a note.
