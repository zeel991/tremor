# Portfolio feasibility gate — result (2026-09-10)

Gate defined in `1inch-strategy-research.md` and the pivot brief. **Result: PASSED**, with real
end-to-end execution, in `contracts/test/PortfolioGate.t.sol` (17 tests, all passing) against the
isolated implementation in `contracts/src/portfolio/`.

## What was demonstrated (observed, `forge test --match-contract PortfolioGate`)

| # | Gate criterion | Evidence |
|---|---|---|
| 1 | HIGH issuance through actual Aqua/SwapVM | `test_gate1`: `router.swap` on a shipped Aqua strategy, unmodified official `AquaSwapVMRouter`; 100 HIGH minted to buyer, $30 premium, $100 reserved |
| 2 | CALM issuance through actual Aqua/SwapVM | `test_gate2`: +100 CALM; reserve **stays $100**, standalone caps would be $200; the CALM sale consumed zero additional collateral |
| 3 | Correct aggregate reservation changes | `test_gate3`, `test_gate3b`, fuzz `testFuzz_reserveBoundsWorstCase` (reserve == hand-derived model and ≥ 101-point grid worst-case payout, ≤ standalone caps) |
| 4 | Quote == fill at identical state | `test_gate4`: `router.quote` and `router.swap` byte-identical on ISSUE and EXIT |
| 5 | Underfunded exit rejected | `test_gate5`: cash $100, 100 HIGH + 100 CALM, buy back 20 HIGH for $5 reverts `ExitUnderfunded(gid, 5e6, 0)`; state untouched. `test_gate5b`: exiting the *larger* side succeeds with no buffer because it releases real reserve |
| 6 | Legitimate funded exit | `test_gate6`: writer locks a $5 exit buffer, the same exit executes, buffer fully consumed, invariant `balance ≥ locked ≥ worst-case payout` holds after |
| 7 | Credible finalization/redemption | `test_gate7`, `test_gate7b`: real `VarianceAccumulator` (bounded permissionless checkpoints over a mock Chainlink path), one finalization fixes both payouts (`highPpu + calmPpu == S` exactly), both sides redeem through the router in any order and fragmentation, total payout ≤ shared reserve, vault ends solvent and fully withdrawable |

Not counted as passing evidence: compilation, mocked arithmetic, UI.

## Mechanism

- `x = min(finalVariance/capVariance, 1)`; HIGH pays `floor(S·x)`, CALM pays `S − floor(S·x)` per
  1e18 units — exact integer complements, so per-unit payouts sum to exactly `S`.
- Pre-finalization reserve: `ceil(max(h,c)·S/1e18)`. Solvency vs integer payouts is proved in
  `PortfolioMath.sol` NatSpec (sum-of-floors ≤ floor-of-sum; affine-in-x maximum at an endpoint).
- Exits pay only from (reserve released by the burn) + an explicitly locked per-group **exit buffer**,
  never from free vault balance read mid-fill. Rationale: SwapVM's program runs before transfers and a
  taker callback can interleave a second fill, so free-balance headroom could be double-spent; the
  buffer is storage debited and re-checked inside the burn hook, so a raced exit fails closed.
- All mutation is mandatory-path: issuance ledger updates inside the Extruction call (which now
  requires `msg.sender == ROUTER`), exit/settle updates only inside the receipt's router-only
  `postTransferIn` hook, which is part of the hash-pinned shipped order and cannot be omitted.

## Three-way comparison (gate requirement)

| Option | Assessment |
|---|---|
| Current v2 (separate full-cap series) | 100 HIGH + 100 CALM as two series locks $200. No shared-outcome netting exists. Kept intact as fallback; all 167 tests still pass. |
| **Stock-Extruction portfolio implementation (built)** | Locks $100 for the same book. ~600 lines of new project-owned code, zero upstream changes, runs on the unmodified official router — preserving `RouterCompat` evidence. This is what passed the gate. |
| Custom SwapVM instruction/opcode | Assessed architecturally, NOT built or benchmarked. A modified SwapVM redeployment is permitted by the track rules and would still satisfy the official-contract requirement; the reason to reject it is narrower: it would express the *same* external call to the same portfolio ledger as an opcode instead of an Extruction target, offering no concrete incremental execution semantics, reuse or measurable benefit that justifies a second router implementation and its review cost. Per the brief ("must not merely rename an external call"): **rejected for this release**. |

The mechanism is also not claimed to be impossible outside Aqua; Aqua supplies shared strategy
allocation over one real balance and settlement, SwapVM supplies the authenticated executable fill
path, the vault supplies custody, and `PortfolioMath` supplies required backing.

## Evidence taxonomy

| Layer | Status |
|---|---|
| Official Aqua + official `AquaSwapVMRouter`, executed locally | Yes — deployed from the pinned submodule source in every portfolio suite; every trade goes through `router.swap`/`router.quote` |
| Collateral token and price feed in the gate/adversarial/invariant suites | **Mocks** — `MockUSDC` (6dp) and `MockAggregator` (8dp, deterministic path) |
| Real-history Base-fork execution | **Executed and passing** (2026-09-10, public `mainnet.base.org` fork): `test/PortfolioForkE2E.t.sol` — canonical Aqua, real Circle USDC, real Chainlink ETH/USD rounds. Forward group traded (issue both sides, $5 exit rejected then buffer-funded); back-dated group finalized from real rounds (HIGH $0.120605 + CALM $0.879395 = $1 exactly) and redeemed for precisely the $100 shared reserve |
| Public-testnet execution | Not performed. Requires explicit authorization to broadcast |

### Test-count reconciliation

Earlier documentation's "171 tests, 14 suites" is the FULL v2 suite including the two suites that need
`BASE_RPC_URL`: `ForkE2E` (2 tests) and `RouterCompat` (2 tests). The gate report's "167 baseline" was
the same suite run with `--no-match-contract 'ForkE2E|RouterCompat'` — 167 + 2 + 2 = 171. Nothing was
renamed, removed or excluded beyond that filter; three existing tests (`test_engineCannotBeDrivenDirectly`,
`test_engineRejectsAnUnsupportedArgsVersion`, `test_engineRejectsMalformedArgs`) had their expectations
updated for the new router-caller check, strengthening — not weakening — what they assert.

## Security fix found during inspection (baseline v2)

`TremorMarketEngine.extruction` was callable directly by anyone. The adversarial suite only proved a
*forged maker* is rejected; a direct call naming the **real** vault as maker with a real order hash
passed every check and fired `onIssue`, inflating `outstandingUnits`/`lockedLiability` with no tokens
moving — phantom units that can never be burned, permanently freezing writer collateral and making
`closeSeries` unreachable. Fixed: the engine now stores `ROUTER` and requires `msg.sender == ROUTER`;
`test_engineCannotBeDrivenDirectly` upgraded to the real-vault variant. The portfolio market shipped
with this check from the start (`test_adv_directExtructionCallRejected`). Legitimate entry paths still
work after the fix: every quote and swap in all suites goes through `router.quote` (static, via
`asView`) and `router.swap`, both of which call the engine with `msg.sender == ROUTER`.

### Impact on the already-deployed v2 stack (nothing broadcast)

The local patch does NOT fix deployed immutable contracts. Affected: the Base Sepolia (chain 84532)
deployment in `contracts/deployments/84532.json`, whose `marketEngine`
`0x0edCAB6421eE01F27688D1556343e6aC0b13388A` is the unpatched engine. Exposure there is griefing, not
theft: anyone can call its `extruction` directly with a fabricated query naming a series' real vault,
inflating `outstandingUnits`/`lockedLiability` with no sale — freezing that vault's collateral for
phantom units and making `closeSeries` unreachable. Only test tokens are at stake on 84532.

Replacement plan (awaiting authorization, nothing broadcast):
1. Redeploy the whole v2 stack with `Deploy.s.sol` — the engine is created by the factory constructor,
   so the fix ships as a fresh factory+engine+accumulator+deployer set at new addresses.
2. Sync the manifest (`sync-deployment.sh`) and re-export ABIs; the versioned manifest makes the old
   addresses fail loudly in the app rather than being reused.
3. Mark the old 84532 deployment deprecated in the manifest history; do not dock or migrate anything —
   existing receipts/vaults stay associated with their original controller, per the versioning rule.
4. The local 31337 manifest is regenerated on every `make demo`; no action needed.

## Status of claims

- Verified by executed tests: everything in the table above (local foundry, mock USDC/feed, pinned
  swap-vm `bd2194a`).
- Structural only, not yet verified: behavior on a Base fork with real Chainlink history; frontend,
  backend, subgraph integration (not started for v3); public-testnet flow.
- Deliberately out of scope, unchanged: leverage, cross-expiry netting, statistical margining,
  arbitrary payoffs. The RANGE interior-knot generalization is a test-only follow-up.

## Remaining work toward submission

1. Adversarial/stateful depth for v3 (reentrancy campaigns, forged-order matrix at PortfolioGate
   breadth of the v2 suites; interior-knot RANGE reference test).
2. Base-fork E2E for a group; deterministic demo script (fund → sell HIGH → sell CALM → baseline
   comparison → rejected exit (simulated, labeled) → buffer-funded exit → finalize → redeem both).
3. Frontend/lens/backend integration with a portfolio summary card; versioned manifests/ABIs.
4. Docs: ARCHITECTURE/CONTRACTS portfolio section, trust boundary, demo script, submission checklist,
   prior-work disclosure.
