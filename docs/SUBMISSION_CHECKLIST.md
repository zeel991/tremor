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
| 2026-09-11 | Backend `cargo test` / clippy / fmt / live startup | pass; 46 tests, schema v3 manifest decoded & validated |
| 2026-09-11 | Sim vectors & 10 scenarios | 1,140 checks / 0 failures; 10 scenarios invariants OK |

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
- [x] Final full-suite run (incl. `ForkE2E`, `RouterCompat`, `PortfolioForkE2E`) at freeze (214/214 pass)

## Demo

- [x] `demo.sh` extended with portfolio stages P1–P6 (P4A simulated revert, labeled)
- [x] `demo.sh` end-to-end run observed 2026-09-11 ending `DEMO COMPLETE ✓` incl. stages P1–P6 (fork state verified: group 1 at 80H/100C, $100 reserve, buffer spent; group 2 finalized at $0.105488/$0.894512 and fully redeemed)
- [ ] Fresh-browser walkthrough of the web app against the demo state
- [ ] (H) Record the three-minute video (`docs/DEMO_SCRIPT_PORTFOLIO.md`)
- CLI fallback: `forge test --match-contract PortfolioForkE2E -vv` and `script/demo.sh`

## Integration

- [x] Web: pairs routes (/pairs, /pairs/new, /pairs/[id]), tickets, portfolio summary card, exit-buffer disclosures
- [x] Web: `npm test` / `tsc` / `eslint` / `npm run build` clean (46 tests, 35 routes)
- [x] Backend: manifest schema v3 decoding (`portfolioMarket`, `portfolioAccumulator`) + readiness validation, startup verified on 31337; chain-direct reads labeled in the UI
- [ ] Subgraph: group entities — or explicitly deferred (84532-only feature)
- [ ] Trace one real local transaction receipt → event → (indexer) → UI
- [x] ABIs exported (TremorPortfolioMarket, 91 entries) to web + backend
- [x] Manifest schema 3 (`portfolioMarket`, `portfolioAccumulator`); all four gates moved together

## Public testnet (nothing broadcast without authorization)

- [ ] (H) Authorize + broadcast `Deploy.s.sol` (fixes the vulnerable 84532 engine as a side effect;
      old deployment marked deprecated, never migrated)
- [ ] (H) Verify sources; sync manifest; smoke checklist (writer ≠ buyer accounts, forward window,
      permissionless finalization by a third account, holder redemption without writer)
- [ ] Test tokens clearly labeled in the UI

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

- Web integration lane in flight; nothing UI-side is verified yet.
- Backend/subgraph group support not started (decision: chain-direct UI first, honest degradation).
- The deployed 84532 v2 engine remains vulnerable until redeployment is authorized.
- Submission hour unconfirmed.
