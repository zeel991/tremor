# Submission checklist and verification log

Deadline: Sunday 2026-09-13 (day confirmed; the 12:00 EDT hour recorded in AGENTS.md is NOT yet
independently confirmed — verify on the ETHGlobal event page before scheduling the cutoff). At least
the final 12 hours are reserved for release verification and packaging.

Legend: [x] observed with command output on the date noted · [ ] pending · (H) needs the human
(credentials, broadcast, or presentation choice).

## Verification log (updated as observed)

| Date | Check | Result |
|---|---|---|
| 2026-09-10 | `forge test` (non-fork, v2 baseline before pivot) | 167/167 pass |
| 2026-09-10 | `forge test` (non-fork, after v3 + engine fix) | 204/204 pass, 16 suites |
| 2026-09-10 | PortfolioVectors (225 exact-rational cases) | 5/5 pass |
| 2026-09-10 | PortfolioForkE2E on public Base fork | pass; HIGH $0.120605 + CALM $0.879395 = $1; payout == $100 reserve |
| 2026-09-11 | `forge test` (full suite incl. ForkE2E + PortfolioForkE2E) | 214/214 pass, 20 suites |
| 2026-09-11 | `forge fmt --check` | clean |
| 2026-09-11 | `forge build --sizes` | portfolio market 20,943 runtime / 40,257 initcode; factory 17,892 runtime / 46,684 initcode (2,468 initcode margin) |
| 2026-09-11 | `demo.sh` (A-F, P1-P6) on fresh Base fork | pass; DEMO COMPLETE ✓; synced manifest & ABIs |
| 2026-09-11 | Web `npm test` / `tsc --noEmit` / `eslint src` / `npm run build` | pass; 46 tests, 35 routes |
| 2026-09-11 | Backend `cargo test` / clippy / fmt / live startup | pass; 54 tests; schema v3 manifest decoded & validated; portfolio indexing live |
| 2026-09-11 | Backend portfolio event indexing & /pairs APIs | pass; indexed 9 group events & 3 checkpoints across demo groups 1 & 2; /pairs/1/events & /pairs/2 verified |
| 2026-09-11 | Backend real-chain log indexer integration test | pass (`real_chain_portfolio_indexer_integration`); queries mined logs from local chain, passes through decoder, asserts idempotence on replay, reconciles with live `groupView(1)` and `groupView(2)` |
| 2026-09-11 | Subgraph portfolio integration | pass; `PortfolioGroup` and `PortfolioEvent` entities, data source and handlers in `portfolio.ts`; `codegen` & `build` clean |
| 2026-09-11 | Web GroupDetail portfolio fills & history feed | pass; live event table replaces static placeholder, typecheck and vitest clean |
| 2026-09-11 | Sim vectors & 10 scenarios (v2 single-series pricing & vault solvency only; NOT portfolio groups) | 1,140 checks / 0 failures; 10 scenarios invariants OK (portfolio economics verified separately in `PortfolioEconomics.t.sol` & `PortfolioVectors.t.sol`) |
| 2026-09-11 | Deploy.s.sol Base Sepolia dry-run simulation | pass (39,486,999 gas, ~0.000434 ETH); simulated without broadcasting; manifest schema 3 verified |
| 2026-09-12 | **v3 deployed and live on Base Sepolia** | schema-3 manifest synced; code confirmed at all 17 addresses; `groupCount() == 1` |
| 2026-09-12 | Group 1 public lifecycle | finalized and fully settled: HIGH ISSUE + SETTLE only. See `docs/submission/ONCHAIN_EVIDENCE.md` |
| 2026-09-12 | `forge test` (full suite incl. all fork suites) | 216/216 pass, 20 suites, 0 skipped; ForkE2E 161.5 s and PortfolioForkE2E 168.3 s confirm real RPC runs |
| 2026-09-12 | `forge build --sizes` | pass; portfolio market 20,943 runtime / 40,257 initcode; factory 17,892 / 46,684 (2,468 initcode margin) |
| 2026-09-12 | `forge fmt --check` | **FAIL** — `script/SimulateBaseSepoliaDemo.s.sol`, `test/PortfolioGate.t.sol` (both under active edit; not auto-fixed) |
| 2026-09-12 | Backend `cargo fmt` / `clippy -D warnings` / `cargo test --bin tremor-api` | pass; 54 tests. `clippy --all-targets` fails on 2 test-code lints |
| 2026-09-12 | Backend live reconciliation vs Base Sepolia | pass; chain 84532, schema 3, lag 3 blocks, `indexer_error: null`; `/pairs/1` matches `groupView(1)` field for field |
| 2026-09-12 | Subgraph `codegen` / `build` / `test` | pass; 4 Matchstick tests |
| 2026-09-12 | Web tests / tsc / eslint / production build | pass; 47 tests, 35 static pages, 14 routes; built with Base Sepolia production values in an isolated tree; no production localhost leak |
| 2026-09-12 | Reproducible-build provenance | pass; 10/10 deployed contracts byte-identical to local build outside immutable slots, **including `AquaSwapVMRouter`** (`docs/submission/evidence/deployed-bytecode-provenance.txt`) |

## Contracts

- [x] Feasibility gate (7 criteria) — `PortfolioGate.t.sol`
- [x] Buffer authorization split + regression tests — `PortfolioAdversarial.t.sol`
- [x] Callback interleaving proven by execution (both transfer orders, cross-group, nested issue,
      writer withdrawal mid-swap, same-order lock, over-draw rollback, fuzz)
- [x] Stateful invariants + non-vacuity — `PortfolioInvariants.t.sol`
- [x] Independent math vectors (exact rational) — `portfolio_reference.py` → `PortfolioVectors.t.sol`
- [x] Economics: round trips, complete-set pricing, mispriced-writer case, exit-liquidity disclosure
- [x] Base-fork lifecycle with real Chainlink history — `PortfolioForkE2E.t.sol`
- [x] v2 engine router-caller fix + strengthened adversarial tests
- [ ] Optional (after everything else): RANGE interior-knot generalization test
- [x] `forge fmt --check` clean at freeze
- [x] Final full-suite run (incl. `ForkE2E`, `RouterCompat`, `PortfolioForkE2E`) at freeze (214/214 pass across 20 suites)

## Demo

- [x] `demo.sh` extended with portfolio stages P1–P6 (P4A simulated revert, labeled)
- [x] `demo.sh` end-to-end run observed 2026-09-11 ending `DEMO COMPLETE ✓` incl. stages P1–P6 (fork state verified: group 1 at 80H/100C, $100 reserve, buffer spent; group 2 finalized at $0.105488/$0.894512 and fully redeemed)
- [x] Trace one real local transaction receipt → event → (indexer) → UI: verified with demo tx `0x44462c78...` (exit) indexed and served on `/pairs/1/events`
- [x] Fresh-browser walkthrough of the web app against demo state (verified with headless Chrome: /pairs, /pairs/1, /pairs/2, /pairs/new, /portfolio rendering live contract data, charts, tickets, and indexed event feed)
- [ ] (H) Record the three-minute video (`docs/DEMO_SCRIPT_PORTFOLIO.md`)
- CLI fallback: `forge test --match-contract PortfolioForkE2E -vv` and `script/demo.sh`

## Integration

- [x] Web: pairs routes (/pairs, /pairs/new, /pairs/[id]), tickets, portfolio summary card, exit-buffer disclosures
- [x] Web: `npm test` / `tsc` / `eslint` / `npm run build` clean (46 tests, 35 routes)
- [x] Web: GroupDetail live event feed connected to `/pairs/:id/events`
- [x] Backend: manifest schema v3 decoding (`portfolioMarket`, `portfolioAccumulator`) + readiness validation, startup verified on 31337
- [x] Backend: full portfolio event and checkpoint indexing (`GroupCreated`, `PortfolioIssued`, `PortfolioExited`, `PortfolioSettled`, `GroupFinalized`, `ExitBufferFunded`, `ExitBufferWithdrawn`, `WorthlessBurned`, `Checkpointed`)
- [x] Backend: `/pairs`, `/pairs/:id`, `/pairs/:id/events`, `/pairs/:id/checkpoints` endpoints implemented and responding
- [x] Subgraph: portfolio entities (`PortfolioGroup`, `PortfolioEvent`), data source, and mapping handlers implemented in `subgraph/src/portfolio.ts`; `codegen` and `build` clean (publishing to Subgraph Studio deferred awaiting human authorization)
- [x] ABIs exported (TremorPortfolioMarket, 91 entries) to web + backend
- [x] Manifest schema 3 (`portfolioMarket`, `portfolioAccumulator`); all four gates moved together

## Public testnet

- [x] (H) `Deploy.s.sol` authorized and broadcast — **v3 is live on Base Sepolia at schema 3**
      (deployment block 46685189). The earlier v2/schema-2 deployment is superseded; its factory
      `0xc207A9dc…` is abandoned and the current manifest no longer references it.
- [x] Manifest synced; `contracts/deployments/84532.json` and both web copies are byte-identical at schema 3
- [x] Writer ≠ buyer accounts, forward window, holder redemption without the writer — all exercised by
      Group 1 on chain
- [ ] **Permissionless finalization by a third account** — NOT demonstrated publicly. Group 1's
      `checkpoint` and `finalize` were both sent by the writer. Permissionless in code, unexercised in public.
- [ ] (H) **Verify sources on Basescan** — still unverified. Partially mitigated by the reproducible-build
      check (10/10 contracts byte-identical to local build outside immutables), which is re-runnable but is
      not explorer verification.
- [ ] **Test tokens clearly labeled in the UI** — NOT done, and now a P0. The quote asset is Tremor
      MockUSDC (`0x13a058bE…`), freely mintable, whose ERC-20 `symbol()` returns the string `"USDC"`. Every
      UI surface renders plain "USDC" and no screen discloses it is a test token. On a public deployment
      this reads as Circle USDC.

## Public two-sided evidence (P0, prepared, awaiting authorization)

Group 1 is finalized and fully settled and therefore **cannot** produce the missing evidence. What it
proves: HIGH issuance and HIGH settlement through the router, finalization from Chainlink history, and
liabilities returning to zero. What it does **not** prove:

- [ ] CALM issuance via Aqua/SwapVM — **no CALM was ever issued**; 1000e18 CALM sits unsold in the vault
- [ ] The shared `max(h,c)` reserve — with CALM outstanding always 0, `max(h,c)` never differed from `h+c`,
      so the headline capital-efficiency claim has **no public evidence yet**
- [ ] Exit-buffer allocation
- [ ] Underfunded EXIT rejection (simulation, must be labelled unmined)
- [ ] Successful EXIT via Aqua/SwapVM
- [ ] `burnWorthless` (did not apply — both Group 1 payouts were positive)

Bounded closing sequence fully specified in `docs/submission/GROUP2_EXECUTION_RUNBOOK.md`. Validated
against deployed bytecode: no extra vault deposit is needed (peak lock 105,000,000 vs 129,957,300 free),
and `allocateExitBuffer` is the correct call, not `fundExitBuffer`. **Nothing broadcast.**

## Public hosting (P0)

- [ ] Public frontend URL — none exists; app runs only on `localhost:3002`
- [ ] Public API URL — none exists; API runs only on `localhost:8789`
- [ ] Republish the subgraph at v3 — the currently published endpoint
      `api.studio.thegraph.com/query/1758209/tremor/v2` is **live, synced, and stale**: it indexes an
      abandoned deployment (vault `0x5276bcc6…`, not `0x9C9341d0…`) and has no portfolio entities, yet
      `web/.env.local` points at it. Ship with the subgraph URL empty until republished.

Configuration, providers, env vars, persistence, CORS and rollback: `docs/submission/PRODUCTION_DEPLOYMENT.md`.

## Submission wording (must / must-not)

Must distinguish: vault enforces custody; PortfolioMath determines required backing; Aqua supplies
shared strategy allocation and settlement; SwapVM executes the portfolio-aware fill logic (stock
Extruction on the unmodified official router).
Must disclose: v1 prototype built 2026-09-02 (pre-hackathon); fixed writer bid/ask quotes, not a
fair-value model; exit liquidity is withdrawable, settlement backing is not; mocks vs fork vs testnet
evidence per the taxonomy in `docs/research/portfolio-gate-report.md`.
Must not claim: guaranteed wins, risk-free returns, perfect hedge, invention of complementary claims,
universal 50% savings, generality beyond two-claim groups (+ tested RANGE if added), security beyond
the tested cases.

## Known remaining blockers / unverified claims

Ranked. Full detail and evidence: `docs/submission/FINAL_AUDIT.md`.

**P0 — submission-blocking**

1. No public frontend or API URL; the submission would depend on localhost.
2. Two-sided public evidence missing (CALM issuance, exit buffer, EXIT). Runbook prepared, unauthorized.
3. Published subgraph is stale and is the endpoint the frontend env currently names.
4. Tremor MockUSDC is not labelled as a test token anywhere in the UI.
5. No demo video. Should be recorded *after* Group 2 so the two-sided story is real, not narrated.

**P1**

6. `forge fmt --check` fails on `script/SimulateBaseSepoliaDemo.s.sol` and `test/PortfolioGate.t.sol`
   (both under active edit; left untouched to preserve in-flight work).
7. `cargo clippy --all-targets -- -D warnings` fails on 2 test-code lints (`src/abi.rs:529`,
   `src/indexer.rs:1543`). The specified gate `cargo clippy -- -D warnings` passes.
8. Basescan source verification absent.
9. `routerSourceCommit: "unknown"` — genuinely unrecoverable; the vendored `lib/swap-vm` has no `.git`.
   The bytecode reproduction is the stronger substitute.
10. Permissionless finalization never exercised publicly by a third party.
11. Three 84532 manifests coexist in `contracts/deployments/` (`.simulation.json`, `.simulation2.json`,
    `.v2.bak.json`) plus five `out_pairs*.png` at the repo root. **Reported, not deleted** — user files.
12. `subgraph/package.json` has no `test` script; `graph test` must be run directly.

**Resolved since the last revision of this file**

- The 84532 deployment is no longer v2/schema-2 and is no longer unbroadcast: **v3 at schema 3 is live**,
  with a complete Group 1 lifecycle mined. The claim that it carries an unpatched `marketEngine` lacking
  the router-only check no longer describes the live deployment — `TremorPortfolioMarket.extruction`
  requires `msg.sender == ROUTER`, and the deployed bytecode reproduces the audited source exactly.
- Awaiting human confirmation on exact submission cutoff hour and timezone (date confirmed: Sunday
  Sept 13, 2026) — still open.
