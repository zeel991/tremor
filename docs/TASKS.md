# Submission readiness

## What v2 changed, and why

v1 sold receipts against a wallet the seller could empty at will and called the measurement "coverage".
Every other problem followed from that one: the only exit was expiry, the first redeemer paid for the
whole observation window, and a private opcode bank meant Tremor had to fork the 1inch router. v2
replaces all four.

| Problem in v1 | What replaced it |
|---|---|
| Collateral observable, not locked | A per-writer `TremorMakerVault` with no admin, no upgrade path, no rescue; sold units reserve their capped payout and only a burn releases it |
| No way out before expiry | An EXIT leg quoting an executable bid, sharing one real balance with SETTLE because both burn the receipt |
| One-sided quote (`K(t)` bumped by demand) | A two-sided market: projected variance, a bid/ask band clamped to the cap, integral fill pricing |
| First settlement walked the entire window | Bounded permissionless checkpoints (≤32 samples) plus permissionless finalization, which also reprices the liability from the cap |
| Four custom opcodes, so a forked router | Stock `Salt` / `Deadline` / `Extruction` programs on the **unmodified official `AquaSwapVMRouter`** |

## Verification (observed 2026-09-08)

| Gate | Result |
|---|---|
| `forge fmt --check` | clean |
| `forge build --sizes` | every contract inside EIP-170; controller 46,484 initcode, 2,668 under EIP-3860 |
| `forge test` | 171 passed, 0 failed, 14 suites, fuzz 128 runs |
| Stateful invariants | 9 invariants pass, plus a scripted test proving the handler reaches every state (non-vacuity) |
| Base-fork E2E | pass; 61-sample window in 8 bounded calls, finalized, redeemed, closed |
| Router compatibility gate | pass; records that the canonical SwapVM address exposes a different swap ABI, and drives the pinned official source instead |
| `cargo fmt --check`, strict clippy, `cargo test`, release build | clean; 46 tests pass |
| Subgraph install / codegen / build | pass |
| Web `npm test`, `tsc --noEmit`, `eslint src`, `npm run build` | pass; 25 tests, 33 routes |
| `sim`: reference-vector gate and ten scenarios | 1,140 checks / 0 failures; no invariant failures |
| Live fork smoke: buy, exit, permissionless checkpoint, writer attacks | buy 234,481 gas, exit 241,866 gas, reservations exact, every attack reverted |

## Human/external submission actions

These require credentials or presentation choices that are intentionally not stored in the repository:

1. Fund a deployment account and broadcast `Deploy.s.sol` to the selected public hackathon chain.
2. Verify the deployed source, sync the resulting manifest, and run the public-chain smoke checklist.
3. Record the demo video using `docs/DEMO_SCRIPT.md` and add the final submission/deployment links.

## Honest trust boundary

**A sold receipt is fully collateralized and the writer cannot take that collateral back.** That is
enforced by the vault and the controller, not asserted: the reservation is created by the sale, released
only by the burn, and the vault reverts a withdrawal that would touch it, a revocation of its Aqua
allowance, a transfer of unsold inventory, and any docking of a burn leg while claims are live.

What remains outside that guarantee, and is stated on the relevant screens:

- **The cap truncates.** A window can realize far above the cap; holders get the cap.
- **Checkpointing and finalization are permissionless but unpaid.** They are cheap and bounded, and
  everyone who wants anything from a series needs them done — but nobody is obliged to do them.
- **Exit depth is finite.** A large exit partially fills at a worse average than the top-of-book bid.
- **Feed gaps bias realized variance downward**, which is why the sampling grid has a 30-minute floor.
- **This is not a fair-value oracle and not a perfect LVR hedge.** The bid and ask are one market's
  executable quote; the LVR page sizes a position and prices it, and says what it cannot promise.
