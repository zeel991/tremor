# Final submission checklist

Deadline: **Sunday 2026-09-13**. The 12:00 EDT hour recorded in `AGENTS.md` is still not independently
confirmed — verify on the ETHGlobal event page before scheduling the cutoff.

Legend: `[x]` verified by running the check on 2026-09-12 · `[ ]` outstanding · **(H)** needs the human
(authorization, credentials, or a recording).

---

## Gate A — code and tests

- [x] `forge build --sizes` — pass; every contract inside EIP-170, controller 2,468 bytes under EIP-3860
- [x] `forge test` — **216 passed, 20 suites, 0 failed, 0 skipped**
- [x] Base-fork suites genuinely ran (`ForkE2E` 240.6 s, `PortfolioForkE2E` 278.4 s on the final run)
- [x] 12 stateful invariants pass, both campaigns non-vacuous
- [x] `RouterCompat` gate passes — backs the no-custom-opcodes claim
- [x] `forge fmt --check` — pass (both files formatted; whitespace only, suite re-run after)
- [x] `cargo fmt --check` — pass (was **failing** on pre-existing `db.rs`/`indexer.rs` formatting and was
      mis-reported as passing in an earlier revision of this checklist; now fixed and verified)
- [x] `cargo clippy -- -D warnings` — pass
- [x] `cargo clippy --all-targets -- -D warnings` — pass (both lints fixed, no behaviour change)
- [x] `cargo test --bin tremor-api` — 54 passed
- [x] `graph codegen` / `graph build` / `graph test` — pass, 4 Matchstick tests
- [x] Web `npm test` (52) / `tsc --noEmit` / `eslint src` — pass (5 unused-var warnings)
- [x] Web production build with Base Sepolia values — 35 pages, 14 routes, no production localhost leak
- [ ] Re-run the whole gate at the freeze revision

## Gate B — deployment integrity

- [x] Chain ID 84532 confirmed live
- [x] Code present at all 17 manifest addresses
- [x] Manifest schema 3; `contracts/` and both `web/` copies byte-identical
- [x] Market immutables (`ROUTER`, `AQUA`, `FEED`, `QUOTE_TOKEN`, `ACCUMULATOR`, `vaultOf`) match the manifest
- [x] Router runtime keccak matches the manifest's `routerBytecodeHash`
- [x] 10/10 deployed contracts reproduce the local build outside immutables, **including the router**
- [ ] **(H)** Basescan source verification — absent
- [ ] `routerSourceCommit` is `"unknown"` — unrecoverable; documented rather than guessed

## Gate C — public on-chain evidence

- [x] HIGH issuance through the router — `0x117d2fdb…`
- [x] Finalization from Chainlink round history — `0xf883cc89…`
- [x] HIGH settlement through the router — `0xbb315073…`
- [x] Six `StrategyShipped` in one transaction — `0xe5859545…`
- [x] `locked <= balance` at every observed stage; liabilities returned to zero
- [x] **CALM issuance** — `0x36d20156…` (block 46696287)
- [x] **Shared `max(h,c)` reserve demonstrated publicly** — `reserveLocked` 100,000,000 vs
      `standaloneCaps` 200,000,000 with both sides at 100e18, read off `groupView(2)`
- [x] **Exit-buffer allocation** — `0xdf4f5b90…` (block 46696359), zero token transfers
- [x] **Underfunded EXIT rejection**, captured as a labelled simulation — `ExitUnderfunded(2, 5000000, 0)`
- [x] **Successful EXIT through the router** — `0x322802e8…` (block 46696441), `released=0, draw=5000000`
- [x] **Settlement** — SETTLE_HIGH `0xe3845a36…` at the full cap, and **`burnWorthless`** `0xac4ac42f…`
      for the exactly-zero CALM side (plus `ZeroPayout(2,6)` as a labelled simulation)
- [x] Liabilities returned to **0**; `lockedQuote <= balance` at all 8 observed states
- [ ] **(H)** Permissionless checkpoint/finalize from a third account (P1 — both groups' were
      writer-sent; permissionless in code, never publicly exercised by a third party)

Executed as [`GROUP2_EXECUTION_RUNBOOK.md`](GROUP2_EXECUTION_RUNBOOK.md) specified — 9 mined transactions
and 2 labelled simulations. Full decoded detail:
[`evidence/group2-transactions.md`](evidence/group2-transactions.md).

## Gate D — public availability

- [ ] **(H)** Public frontend URL live
- [ ] **(H)** Public API URL live, persistent volume, `BIND_ADDRESS=0.0.0.0`, `CORS_ORIGIN` = frontend origin
- [ ] `/health` green: `ok`, chain 84532, schema 3, `indexer_error: null`, low lag
- [ ] Clean-browser smoke test, desktop + mobile, all 9 routes, hard refresh on each
- [ ] Wallet connect and Base Sepolia network switching
- [ ] Degraded states honest when the API is down
- [x] Stale Graph endpoint neutralized locally: `web/.env.sepolia.example` no longer points at the stale
      v2 URL, and `web/.env.production.example` ships it empty with the reason stated
- [ ] **(H)** Subgraph republished at v3 (optional — shipping it empty is a valid final state)
- [ ] No Graph-sourced claim anywhere while the URL is empty

Plan and full configuration: [`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md).

## Gate E — honesty

- [x] **Test token labelled in the UI** — a persistent disclosure now renders on every money-bearing
      surface, gated to chain 84532, with 5 unit tests pinning the wording and the gating, and verified
      rendered at desktop and mobile widths
- [x] README caveats updated: MockUSDC, backend-only checkpoints, stale subgraph, one-sided evidence,
      unverified sources
- [x] `SUBMISSION_CHECKLIST.md` corrected — it described the deployment as unbroadcast v2/schema-2
- [x] No claim of custom SwapVM opcodes anywhere
- [x] No claim that The Graph indexes portfolio checkpoints
- [x] Simulations separated from mined transactions in every document
- [x] Complementarity (`hp + cp = S`) never presented as proof of full solvency
- [ ] Demo narration observes the same boundaries — see [`DEMO_SCRIPT_3_MIN.md`](DEMO_SCRIPT_3_MIN.md)

## Gate F — submission package

- [ ] **(H)** Three-minute video recorded — Group 2 is mined, so this is now unblocked
- [ ] Placeholders in [`SUBMISSION_COPY.md`](SUBMISSION_COPY.md) filled (app URL, API URL, video, repo, Group 2 hashes)
- [x] Address table and explorer links prepared
- [x] Test totals accurate (216 / 20 suites — the previously recorded 214 is superseded)
- [ ] Final `git diff` reviewed before committing
- [x] Secret scan clean — no key, mnemonic, keystore, or populated `.env` in the tree
- [ ] Decide what to do with the untracked artifacts below

### Files to resolve before the final commit (reported, not deleted)

| File | Why it matters |
|---|---|
| `contracts/deployments/84532.simulation.json` | three 84532 manifests coexist; a judge can't tell which is live |
| `contracts/deployments/84532.simulation2.json` | same |
| `contracts/deployments/84532.v2.bak.json` | superseded v2 manifest |
| `contracts/test/execution_summary.txt` | scratch output |
| `contracts/test/inventory.json` | scratch output |
| `out_pairs*.png` (5 files) | screenshots at the repo root |

---

## The order things must happen

1. ~~Authorize and execute Group 2~~ — **done**; 9 transactions mined, evidence captured, docs updated.
2. **Name hosting accounts** → deploy API → deploy frontend → set CORS → smoke test.
3. ~~Fix the MockUSDC labelling~~ — **done**; the disclosure is in place and renders on every money surface.
4. Republish the subgraph, **or** confirm it ships disabled (shipping it empty is already configured and is
   a perfectly good final state).
5. **Record the video** against the public URL with Group 2 evidence live.
6. Re-run the full gate at the freeze revision (it is green now; re-run after any further edit).
7. Fill every placeholder; final diff review; submit.

Steps 1, 2 and 4 are external actions. Each needs its own explicit go-ahead.

---

## Do not say "submission ready" while any of these is true

- No public app URL · broken public API · stale manifest · missing critical transaction evidence ·
  a failed release gate · unresolved wallet/network flow · no demo video · any claim not supported by
  evidence in this directory.

**As of 2026-09-12, three of those eight are true**: no public app URL, no demo video, and submission
copy still carrying URL placeholders. Critical transaction evidence is now **complete** — Group 2 proves
the full two-sided lifecycle on Base Sepolia. Every release gate passes and the test-token disclosure is
in place. The project is **not yet** submission-ready, and the remaining three are all external actions.
