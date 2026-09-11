# Final release audit

Audit date: **2026-09-12**. Revision audited: `14e3c05` plus an uncommitted working tree (27 modified
files, 15 untracked). Every result below was produced by running the command shown; nothing is carried
over from a previous log.

**Verdict: not submission-ready.** Every release gate now passes and the test-token disclosure has been
added, but four P0 items remain, listed in §6: public two-sided evidence, hosting, the stale published
subgraph, and the demo video. Each is blocked on an external action that needs explicit authorization.

---

## 1. Release gate results

### Contracts — `contracts/`

| Command | Result |
|---|---|
| `forge fmt --check` | **pass (exit 0)** |
| `forge build --sizes` | **pass (exit 0)** |
| `forge test` (with `BASE_RPC_URL` set) | **pass (exit 0)** — **216 tests, 20 suites, 0 failed, 0 skipped**, 278.37 s wall / 658.35 s CPU |

`forge fmt --check` previously failed on `script/SimulateBaseSepoliaDemo.s.sol` and
`test/PortfolioGate.t.sol`. Both were formatted with `forge fmt` on exactly those two paths; the changes
are whitespace and line-breaking only, with no semantic edit, and the full suite was re-run afterwards.

Full suite breakdown (216 total, up from the 214 previously recorded — `PortfolioGate` grew):

| Suite | Tests | Suite | Tests |
|---|---|---|---|
| IssueLeg | 22 | PortfolioVectors | 5 |
| Adversarial | 22 | PortfolioEconomics | 5 |
| MarketPricing | 22 | RealizedVariance | 9 |
| MakerVault | 17 | ShipRoundTrip | 9 |
| SettlementLeg | 17 | RouterCompat | 2 |
| ExitLeg | 17 | PortfolioInvariants | 2 |
| PortfolioGate | 19 | Invariants | 2 |
| VarianceAccumulator | 16 | ForkE2E | 2 |
| SeriesCreation | 13 | PortfolioForkE2E | 1 |
| PortfolioAdversarial | 13 | Lifecycle | 1 |

**Fork tests genuinely ran** — not skipped, not mocked. Their wall-clock times prove real RPC work:

```
Ran 2 tests for test/ForkE2E.t.sol:ForkE2ETest
[PASS] test_fork_backdatedSeries_finalizesFromRealChainlinkHistory()
[PASS] test_fork_forwardSeries_issueExitAndFailedWriterAttacks()
Suite result: ok. 2 passed; finished in 161.52s

Ran 1 test for test/PortfolioForkE2E.t.sol:PortfolioForkE2ETest
[PASS] test_fork_portfolioLifecycle_realUsdcRealChainlinkHistory()
Suite result: ok. 1 passed; finished in 168.27s
```

**Invariants — 12 passed**, across two stateful campaigns (`fuzz.runs = 128`):

`invariant_outstandingMatchesSupply` · `invariant_reserveMatchesReferenceModel` ·
`invariant_vaultSolventAndLockMatchesLedgers` · `invariant_aquaAllowanceStaysMaximal` ·
`invariant_bidNeverExceedsAskOrTheMaximumPayout` · `invariant_finalizedLiabilityUsesTheFinalPayout` ·
`invariant_liveLiabilityIsTheCappedLiability` · `invariant_outstandingMatchesTheIndependentTally` ·
`invariant_receiptSupplyMatchesTheTally` · `invariant_supplyOutsideTheVaultIsOutstanding` ·
`invariant_vaultIsAlwaysSolvent` · `invariant_vaultLockIsTheSumOfSeriesLocks`

Both campaigns also carry a non-vacuity test (`test_handlerCanReachEveryState`, gas 424,405,073) proving
the handler actually reaches every state rather than passing trivially.

**Router compatibility gate — 2 passed**, which is what backs the no-custom-opcodes claim:
`test_gate_pinnedOfficialRouterSource_runsExtructionAndMakerHooks` and
`test_gate_canonicalDeployedRouter_isSwapVmButExposesADifferentSwapAbi`.

**Contract sizes** — every contract inside EIP-170; the controller inside EIP-3860:

| Contract | Runtime | Initcode | Initcode margin |
|---|---|---|---|
| TremorPortfolioMarket | 20,943 | 40,257 | 8,895 |
| VarianceSeriesFactory | 17,892 | 46,684 | **2,468** (the binding constraint) |
| TremorLens | 15,184 | 16,364 | 32,788 |
| TremorSeriesDeployer | 11,236 | 11,574 | 37,578 |
| TremorMarketEngine | 8,760 | 9,065 | 40,087 |
| TremorPrograms | 7,607 | 8,057 | 41,095 |
| VarianceAccumulator | 6,858 | 7,163 | 41,989 |
| RealizedVarianceOracle | 5,562 | 5,781 | 43,371 |
| TremorMakerVault | 3,652 | 4,408 | 44,744 |
| VarianceReceipt | 2,981 | 5,218 | 43,934 |

### Backend — `backend/`

| Command | Result |
|---|---|
| `cargo fmt --check` | **pass (exit 0)** |
| `cargo clippy -- -D warnings` | **pass (exit 0)** |
| `cargo clippy --all-targets -- -D warnings` | **pass (exit 0)** |
| `cargo clippy --all-targets --all-features -- -D warnings` | **pass (exit 0)** |
| `cargo test --bin tremor-api` | **pass (exit 0)** — **54 passed, 0 failed** |
| Live reconciliation vs Base Sepolia | **pass** (§2) |

**Correction to an earlier version of this audit.** It recorded `cargo fmt --check` as passing. That was a
reporting error on my part, not a real result: the command was run inside a pipeline and the captured exit
code was `tail`'s, not `cargo fmt`'s. `cargo fmt --check` was in fact **failing**, on pre-existing
formatting in `src/db.rs` and `src/indexer.rs` that predates any edit made during this audit. It has since
been fixed with `cargo fmt` and now genuinely passes, with the exit code captured directly.

Two clippy lints under `--all-targets` were also fixed, without behaviour change:

- `src/abi.rs:529` — `assert_eq!(decoded_pi.high, true)` → `assert!(decoded_pi.high)`.
- `src/indexer.rs:1543` — `contains_key` followed by `insert` → the `Entry::Vacant` arm. The fetch is
  awaited, so the closure-taking `or_insert_with` helpers do not apply; the Vacant arm is the
  behaviour-identical rewrite (fetch and insert only when the key is absent).

### Subgraph — `subgraph/`

| Command | Result |
|---|---|
| `npx graph codegen` | **pass (exit 0)** — types generated |
| `npx graph build` | **pass (exit 0)** — `build/subgraph.yaml` written |
| `npx graph test` | **pass (exit 0)** — **4 Matchstick tests passed** |

The four tests cover balanced finalization, asymmetric positions with a funded buffer and rounding,
redemption plus worthless-burn decrements, and fractional-unit flooring.

> `package.json` has **no `test` script**; `graph test` must be invoked directly. Worth adding
> `"test": "graph test"` so the gate is discoverable — a one-line change, not made here.

### Web — `web/`

| Command | Result |
|---|---|
| `npm test -- --run` | **pass** — **52 tests, 3 files** (`portfolio` 22, `series` 25, `test-token` 5) |
| `npx tsc --noEmit` | **pass (exit 0)** |
| `npx eslint src` | **pass (exit 0)** — 0 errors, **5 warnings** |
| `next build` with production Base Sepolia values | **pass (exit 0)** — 35 static pages, 14 routes |

The five warnings are all unused-variable in in-flight files: `GroupDetail.tsx:15`,
`PairMarketChart.tsx:31`, `PortfolioView.tsx:30,41,692`.

**Build isolation note.** `AGENTS.md` warns that `npm run build` corrupts `.next` while `next dev` runs,
and dev servers are live on ports 3001/3002. The production build was therefore run from an isolated
copy in the scratchpad (sources copied, `node_modules` hard-linked, `distDir: .next-prodcheck`). **The
running dev servers were not touched and the repo's `.next` was not written.**

Environment used, matching the intended production values:
```
NEXT_PUBLIC_CHAIN_ID=84532
NEXT_PUBLIC_RPC_URL=https://sepolia.base.org
NEXT_PUBLIC_API_URL=https://api.example-placeholder.invalid   (placeholder — no real host exists yet)
NEXT_PUBLIC_TREMOR_SUBGRAPH_URL=                              (empty, deliberately)
```

**No production localhost leak.** The only `localhost` / `127.0.0.1` strings in the emitted bundle are
(a) the chain-31337 anvil fallback inside the wagmi chain definition, dead code when `chainId = 84532`,
and (b) documentation pages that legitimately document the local defaults. Both were inspected directly,
not inferred.

---

## 2. Live reconciliation — backend vs Base Sepolia

`GET http://localhost:8789/health`:

```json
{"ok":true,"chain_id":84532,"schema_version":3,"manifest_schema_version":3,
 "head_block":46694228,"indexed_block":46694225,"lag_blocks":3,
 "indexer_error":null,"resets":0,"series_indexed":0,"vaults_indexed":1}
```

`GET /pairs/1` reconciles **field for field** against `groupView(1)` read directly from the chain:
`high_outstanding` 0, `calm_outstanding` 0, `reserve_locked` 0, `exit_buffer` 0, `finalized` 1,
`final_variance` 427669801868880, `high_ppu` 427, `calm_ppu` 999573, `created_block` 46686188,
`created_tx` `0xe5859545…`. Both checkpoints and all lifecycle events are present on
`/pairs/1/checkpoints` and `/pairs/1/events`.

`series_indexed: 0` is correct, not a fault: the v2 `seriesFactory` at `0xC86Cf4AD…` has **zero logs** on
Base Sepolia — no v2 series was ever created there.

### Local browser smoke test (desktop 1440×900 and mobile 375×812)

Run against the running Base Sepolia frontend on `localhost:3002`. This is a **local** check; it does not
substitute for the public smoke test in [`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md) §8.

- `/pairs` renders Group 1 as **Settled** with correct live figures (`$0.000427` / `$0.999573`, 0/1,000
  outstanding both sides) — reconciles with `groupView(1)`.
- `/pairs/1` renders the full group terminal: final payouts, the reserve card, the exit-buffer card, the
  payout-invariant panel and the trajectory chart. **No console errors on any route tested.**
- `/portfolio` and `/docs/reference/deployments` render clean.
- Mobile at 375 px: no horizontal overflow; bottom tab bar renders correctly.
- The exit-buffer disclosure copy is accurate and unusually good — it already states plainly that
  settlement backing is locked, that early-exit liquidity is separate and writer-managed, and that an exit
  quote can therefore become unavailable.

**What the smoke test exposed:** the UI denominates everything as **"USDC" with a `$` prefix** —
`$1.00 USDC`, `129.96 USDC`, `Cap payout: $1.00 USDC`. On a public deployment backed by a freely mintable
test token this reads as US dollars and Circle USDC. This is the concrete form of P0 item 4 below.

---

## 3. Reproducible-build provenance (P1 resolved as far as possible without redeployment)

Sources are not verified on Basescan. In place of that, every deployed contract's runtime bytecode was
reproduced locally and compared byte-for-byte:

```bash
cd contracts && forge build
python3 ../docs/submission/evidence/verify-deployed-bytecode.py
```

**Ten of ten contracts identical outside their immutable slots**, including `AquaSwapVMRouter` — which is
the bytecode-level proof that the deployed router is the official 1inch source vendored at
`contracts/lib/swap-vm`, unmodified. Output: `docs/submission/evidence/deployed-bytecode-provenance.txt`.

This is a genuine strengthening of the provenance story, but it is **not** explorer verification: a reader
must run the script rather than clicking a green check. `routerSourceCommit` remains `"unknown"` because
the vendored `lib/swap-vm` has no `.git` directory, so the upstream commit is genuinely unrecoverable.

---

## 4. Public-chain evidence coverage

Detail in [`ONCHAIN_EVIDENCE.md`](ONCHAIN_EVIDENCE.md). Summary:

| Required evidence | Status |
|---|---|
| HIGH issuance via Aqua/SwapVM | **MINED** — `0x117d2fdb…` |
| CALM issuance via Aqua/SwapVM | **MISSING** |
| Underfunded EXIT rejection (simulation, labelled) | **MISSING** |
| Exit-buffer allocation | **MISSING** |
| Successful EXIT via Aqua/SwapVM | **MISSING** |
| Finalization through the accumulator | **MINED** — `0xf883cc89…` |
| SETTLE via router for a positive side | **MINED** — `0xbb315073…` (HIGH only) |
| `burnWorthless` for a zero-payout side | **MISSING** (did not apply — both Group 1 PPUs positive) |
| Final reserve / buffer / outstanding at zero | **MINED** — `groupView(1)` all zero |

Group 1 is finalized and settled, so it can never produce the missing rows. The bounded sequence that
closes them is fully specified in [`GROUP2_EXECUTION_RUNBOOK.md`](GROUP2_EXECUTION_RUNBOOK.md) and is
**awaiting authorization** — no transaction has been sent.

**Consequence for submission copy:** the shared `max(h,c)` reserve — Tremor's headline capital-efficiency
claim — currently has **no public-chain evidence**. It is proven in local fork tests only. Until Group 2
runs, every written claim about it must say so.

---

## 5. Repository hygiene

`git status`: 27 modified, 15 untracked. **Nothing was committed, staged, pushed, or reverted.**

**Secret scan — clean.** No private key, mnemonic, keystore, or `.env` with real values in the working
tree. The root `.env` does not exist (only `.env.example`); `web/.env.local` contains only local URLs and
a public subgraph endpoint. `backend/` holds no key material by design.

**Manifests agree.** `contracts/deployments/84532.json`, `web/src/config/deployment.json` and
`web/src/config/deployment-84532.json` are byte-identical at schema 3.

**Files that should not ship — reported, not deleted:**

| File | Concern |
|---|---|
| `contracts/deployments/84532.simulation.json` | untracked simulation manifest; three near-identical 84532 manifests invite confusion about which is live |
| `contracts/deployments/84532.simulation2.json` | same |
| `contracts/deployments/84532.v2.bak.json` | backup of the superseded v2 manifest |
| `contracts/test/execution_summary.txt` | untracked scratch output |
| `contracts/test/inventory.json` | untracked scratch output |
| `out_pairs.png`, `out_pairs_1.png`, `out_pairs_1_redeemed.png`, `out_pairs_finalized.png`, `out_pairs_new.png` | screenshots at the repo root |

None were removed — they are user files. Recommend moving the screenshots into `docs/` and either
`.gitignore`-ing or deleting the simulation manifests before the final commit, so a judge reading
`contracts/deployments/` sees exactly one 84532 manifest.

**Documentation accuracy.** Four documents carried materially stale claims; all corrected as part of this
audit:

| File | Was | Now |
|---|---|---|
| `docs/SUBMISSION_CHECKLIST.md` | 84532 described as unbroadcast v2/schema-2 with an unpatched engine | v3/schema-3 live, Group 1 lifecycle mined, blockers re-ranked |
| `README.md` | status table from 2026-09-08, 171 tests / 14 suites, "manifest schema version 2" | 2026-09-12 results, 216/20, schema 3, address table, five new caveats |
| `contracts/CONTRACTS.md` | "214 tests" header with per-suite counts summing wrong (`PortfolioGate` 7, `PortfolioAdversarial` 12, `PortfolioForkE2E` 12) | 216/20 with per-suite counts taken from the run; now sums to exactly 216 (19, 13, 1) |
| `web/src/content/docs/reference/deployments.md` | **user-facing in-app page** claiming `schemaVersion: 2` and "backend rejects anything other than 2"; no portfolio contracts; quote token listed as plain `MockUSDC` with no warning | schema 3 with `portfolioMarket`/`portfolioAccumulator`, both addresses rendered, explicit "not USDC / freely mintable" callout, and the `routerSourceCommit: unknown` explanation |

The in-app docs page required a two-line change to `web/src/lib/docs.ts` (adding `portfolioMarket` and
`portfolioAccumulator` to the templater's allowed-key list) or the new placeholders would have rendered
literally. Verified by rebuilding in the isolated sandbox: the page renders both addresses, `schemaVersion: 3`,
and the test-token warning, with no unsubstituted `{{…}}`.

**Note on port 3002.** It runs `next start` against a prebuilt `.next`, not `next dev` (port 3001 is the
dev server). Source edits therefore do not appear on 3002 until someone rebuilds. Nothing was rebuilt in
the repo, and neither server was touched.

---

## 6. Blockers

### P0 — submission-blocking

1. **No public app URL.** Frontend and API exist only on localhost. Plan and full configuration ready in
   [`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md); blocked on the user naming hosting accounts.
2. **Two-sided public evidence missing.** No CALM issuance, no EXIT, no exit buffer on a public chain.
   Runbook ready; blocked on authorization to execute.
3. **Published subgraph is stale and is wired into the frontend env.**
   `api.studio.thegraph.com/query/1758209/tremor/v2` is live and synced but indexes an *abandoned*
   deployment (vault `0x5276bcc6…`, not the current `0x9C9341d0…`) and has no portfolio entities. Mitigation
   pending: ship with `NEXT_PUBLIC_TREMOR_SUBGRAPH_URL` empty; republish v3 under separate approval.
4. ~~**Test token is not labelled in the app UI.**~~ **RESOLVED.** A persistent disclosure now renders on
   every money-bearing surface — `/markets`, `/pairs`, `/pairs/[id]`, `/pairs/new`, `/portfolio`,
   `/series/[id]`, `/write` — reading *"MockUSDC — freely mintable Base Sepolia test token; no real-world
   value."* plus the contract address and the note that the token's own `symbol()` returns `"USDC"`. The
   in-app docs deployment page carries the same callout.

   The disclosure is gated on `chainId === 84532` by a pure predicate in `web/src/lib/test-token.ts`, so
   it does not appear on the 31337 fork or Base mainnet, where the quote token really is USDC and the
   warning would assert a falsehood in the other direction. Five focused unit tests
   (`web/src/lib/test-token.test.ts`) pin the wording, the chain gating, and the rule that the string
   never presents the mock as Circle USDC. Verified rendered in an isolated production build at 1440×900
   and 375×812, with `document.body.scrollWidth === clientWidth` at mobile width (no overflow).

   Monetary values themselves are unchanged and remain readable; nothing on chain was renamed.

5. **No demo video.** Script ready at [`DEMO_SCRIPT_3_MIN.md`](DEMO_SCRIPT_3_MIN.md); requires a human to
   record, and should be recorded *after* Group 2 so the two-sided story is real rather than narrated.

### P1 — important

6. ~~`forge fmt --check` failures~~ — **resolved**, both files formatted, suite re-run.
7. ~~`cargo clippy --all-targets` lints~~ — **resolved**, both fixed without behaviour change. (`cargo fmt --check` was also failing and is now fixed; see the correction in §1.)
8. Source verification on Basescan is absent; mitigated but not replaced by §3.
9. `routerSourceCommit: "unknown"` — unrecoverable from the working tree; §3 is the stronger substitute.
10. Group 1's checkpoint and finalize were sent by the **writer**. Permissionlessness holds in code but has
    never been publicly exercised by a third party. Group 2 is the chance to fix this cheaply.
11. Untracked simulation manifests and root-level screenshots (§5).
12. `subgraph/package.json` has no `test` script.

### P2 — optional

13. 5 eslint unused-variable warnings.
14. `RANGE` interior-knot generalization test, already marked optional in the checklist.

---

## 7. What must be true before anyone says "submission ready"

Not yet true, in this order:

- [ ] Group 2 mined; two-sided evidence captured with real hashes
- [ ] Public frontend URL live and smoke-tested from a clean browser
- [ ] Public API URL live, CORS correct, persistent storage, `/health` green
- [ ] Graph either republished at v3 and queryable, or honestly disabled everywhere
- [ ] Test token labelled in the UI
- [ ] Demo video recorded
- [ ] `forge fmt --check` clean
- [ ] Final full gate re-run at the freeze revision
- [ ] Submission copy and links final, every claim traceable to evidence in this directory
