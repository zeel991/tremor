# Submission copy — ETHOnline 2026, 1inch "Build an Aqua App"

Every factual claim here is traceable to [`ONCHAIN_EVIDENCE.md`](ONCHAIN_EVIDENCE.md),
[`AQUA_SWAPVM_EVIDENCE.md`](AQUA_SWAPVM_EVIDENCE.md) or [`FINAL_AUDIT.md`](FINAL_AUDIT.md).

**Placeholders marked `<…>` must be filled before submitting.** Several depend on Group 2 and on hosting,
neither of which has happened. Do not submit with a placeholder still in place.

---

## Title

> **Tremor — Capital-Efficient Realized Volatility Markets on Aqua**

## Tagline

> Trade ETH's tremor, not its direction.

## One-line pitch

Tremor turns realized volatility into fully backed HIGH/CALM claims whose issuance, exit, and settlement
execute through Aqua/SwapVM.

## Short description (~50 words)

Tremor splits ETH realized variance into complementary HIGH and CALM claims whose per-unit payouts always
sum to the cap. A shared maker vault reserves the **larger** side rather than both, roughly halving the
collateral a two-sided book needs. Issue, exit and settle all execute as stock SwapVM programs on the
unmodified official `AquaSwapVMRouter`, and settlement is computed on chain from the Chainlink ETH/USD
feed's own round history.

## Long description

**The problem.** Getting exposure to how violently ETH moves — rather than which way — means either an
options surface you have to model or a variance swap most participants can't access. And when someone
writes that exposure on chain, the backing is usually a revocable wallet allowance: the writer can pull it
exactly when it is about to cost them. That is a promise with a cancel button, not collateral.

**What Tremor does.** A writer funds a `TremorMakerVault` — one per writer, deterministic address, no
admin, no upgrade path, no rescue function. Creating a risk group mints two complementary receipt tokens
and ships **six SwapVM strategies** into canonical Aqua in a single transaction: ISSUE, EXIT and SETTLE for
each of the two sides. HIGH pays more as realized variance rises; CALM pays the complement; per unit they
sum to exactly the cap by construction, because CALM is defined as the integer complement rather than
rounded independently.

**The capital-efficiency claim, mined.** Because HIGH's worst case and CALM's worst case cannot occur at
the same outcome, the aggregate payout is affine in the outcome and therefore maximized at an endpoint.
The group reserves `ceil(max(h, c) · S / 1e18)` — the larger side — not the sum of both caps.

Group 2 demonstrates it on a public chain. With **100 HIGH and 100 CALM both outstanding**, `groupView(2)`
reports `reserveLocked = 100,000,000` against `standaloneCaps = 200,000,000`: selling the second full-cap
side added **nothing** to the vault's lock. Two independently backed series would hold 200 MockUSDC for the
same book; this one holds 100. Both figures are contract reads, not off-chain arithmetic, so the comparison
is verifiable rather than a marketing claim.

This is a reduction **for a given book at a given composition**, not a universal 50% saving.

**The answer to "what stops the writer rugging you."** The reservation is created by a sale and destroyed
only by a burn. The writer cannot withdraw reserved collateral (`withdrawFree` reverts above
`balance - locked`), cannot revoke the vault's Aqua allowance — it is granted by code the writer does not
control — cannot move unsold inventory, and cannot dock a burn leg while claims are outstanding. Every
vault mutation re-asserts solvency.

Stated honestly: **settlement backing is locked; exit liquidity is not.** Buybacks are paid from released
reserve plus an exit buffer the writer explicitly allocates, and the writer may withdraw an unspent
buffer. An exit quote can therefore disappear. A settlement claim cannot. That separation is deliberate
and disclosed on every relevant screen.

**How it executes on Aqua.** Three stock SwapVM instructions — `Salt` (`0x02`), `Deadline` (`0x20`),
`Extruction` (`0x04`) — and nothing else. All pricing sits behind the `Extruction` target,
`TremorPortfolioMarket`, which also owns every reservation. **There are no custom opcodes and no forked
router**; `TREMOR_OPCODES` in the frontend is deliberately empty and `RouterCompat.t.sol` is the gate that
keeps it true. What is custom is the *program composition and the Extruction logic*, not the instruction
set. The deployed router's runtime bytecode reproduces the vendored official 1inch source byte-for-byte
outside its immutable slots.

**How it settles.** Realized variance is computed on chain from the Chainlink ETH/USD proxy's own round
history: `RV = Σ ln(Pᵢ/Pᵢ₋₁)² · 31,536,000 / (end − start)`. The window is walked forward in bounded,
permissionless checkpoints and finalized permissionlessly. No oracle write, no keeper, no price submitted
by Tremor, no dispute window. `quote()` and `swap()` run identical arithmetic — the engine writes storage
only when `!isStaticContext` — so a displayed price and an executed fill cannot disagree.

---

## Deployed addresses — Base Sepolia (chainId 84532)

Manifest schema 3, deployment block 46685189. Full table and re-runnable queries:
[`ONCHAIN_EVIDENCE.md`](ONCHAIN_EVIDENCE.md).

| Contract | Address |
|---|---|
| `TremorPortfolioMarket` | `0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb` |
| `AquaSwapVMRouter` (official, unmodified) | `0xb8dcED3Cf6266Dd8fEc05849fce3734B79A7e722` |
| Aqua | `0x3B568C149DDf92Bd1f7deF40bDD8930503e70B31` |
| Portfolio `VarianceAccumulator` | `0xea5A9Cfb462509f51420E10f5732891481fE634F` |
| Writer maker vault | `0x9C9341d0E752a97BD1c7c47FB1579866daBCc47C` |
| MockUSDC (**test token**) | `0x13a058bE25Da579e0858d689F5982eDaCE8356B7` |
| Chainlink ETH/USD | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` |

## Key transactions

| What | Hash |
|---|---|
| Group 1 created — 6 strategies shipped to Aqua | [`0xe5859545…b858a`](https://sepolia.basescan.org/tx/0xe5859545450e98c509fe610c280f61223fc7e697d2bfe78f5df57586406b858a) |
| ISSUE 100 HIGH through the router | [`0x117d2fdb…7b58a`](https://sepolia.basescan.org/tx/0x117d2fdb2e203ac5e5f62963163d2c914cc454c132c084f6d1b266c7a057b58a) |
| Finalized from Chainlink history | [`0xf883cc89…3d4f3`](https://sepolia.basescan.org/tx/0xf883cc89b80ec92f7861430cabbef1e72959c9588f3bb5e972cc8c80b843d4c3) |
| SETTLE 100 HIGH through the router | [`0xbb315073…5f488`](https://sepolia.basescan.org/tx/0xbb315073250d0a352639ea2977ce6ad85688522d31a07b3e49ff6dce0885f488) |
| **Group 2** created — 6 strategies shipped | [`0xacafa07c…`](https://sepolia.basescan.org/tx/0xacafa07c2bf194d03635db529873b47b46828dd44a49caa00f0fc04661f6592e) |
| ISSUE_HIGH 100 through the router | [`0xa52ff9eb…`](https://sepolia.basescan.org/tx/0xa52ff9eb71434b3e5b2500fc4c2f05ee8de07eaabda6f4d8560fbd4c88c36912) |
| **ISSUE_CALM 100 — reserve unchanged at 100, standalone 200** | [`0x36d20156…`](https://sepolia.basescan.org/tx/0x36d201560c8db096c42feea38f9612bcb53bb855131e42c79c4321b5ea78ae17) |
| Underfunded EXIT — **simulation, no hash, never mined** | `ExitUnderfunded(2, 5000000, 0)` |
| Exit-buffer allocation (zero token transfers) | [`0xdf4f5b90…`](https://sepolia.basescan.org/tx/0xdf4f5b90f945595ac2dc2ceea134f2a59322efa1e251927218bccf77b5b960a4) |
| Funded EXIT 20 HIGH — `released=0, draw=5000000` | [`0x322802e8…`](https://sepolia.basescan.org/tx/0x322802e8c5a18468c9a82aa1895d1c0090c0a28cbc404506bbac095bac591d89) |
| Group 2 checkpoint (3 samples from Chainlink history) | [`0xf107df40…`](https://sepolia.basescan.org/tx/0xf107df40f790c9b45b94fa54b72ad0e5a867692b7e07ce55f43a9c1e08a0f293) |
| Group 2 finalized — x = 1.0, HIGH 1,000,000 / CALM 0 | [`0xed2ac4d8…`](https://sepolia.basescan.org/tx/0xed2ac4d86f73d1f3875c0623235e9d6e7be785a080988d2904faa1b648477bf6) |
| SETTLE_HIGH 80 at the full cap, through the router | [`0xe3845a36…`](https://sepolia.basescan.org/tx/0xe3845a368cb73d7535d6b6ea30bd37ff91db1f2f47c8d08d8e5280758e8141c4) |
| CALM cannot settle — **simulation**, `ZeroPayout(2, 6)` | no hash, `eth_call` only |
| **`burnWorthless`** the zero-payout CALM side | [`0xac4ac42f…`](https://sepolia.basescan.org/tx/0xac4ac42f47846666a0030c42fb9bd17820b5d8ec374913dd8d83f80dc2d33a1c) |

## Links

| | |
|---|---|
| Live app | `<pending — no public URL yet>` |
| API | `<pending — no public URL yet>` |
| Demo video | `<pending — record after Group 2>` |
| Repository | `<repo URL>` |
| Evidence | `docs/submission/` |
| Subgraph | `<pending — current published version is stale; do not link it>` |

## Test credibility

216 tests across 20 suites, 0 failed, 0 skipped. 12 stateful invariants across two campaigns, each with a
non-vacuity test proving the handler reaches every state. Two Base-fork lifecycle suites running against
the real canonical Aqua and the real Chainlink feed (161.5 s and 168.3 s of genuine RPC work). 60-digit
pricing reference vectors pinning three independent replicas. Backend 54 tests; web 47; subgraph 4
Matchstick tests. Every deployed contract's runtime bytecode reproduces the local build exactly outside
its immutable slots.

---

## Must say

- Stock `Extruction` on the **unmodified official router**; custom program composition, **not** custom opcodes.
- The vault enforces custody; `PortfolioMath` determines required backing; Aqua supplies shared strategy
  allocation and settlement; SwapVM executes the fill logic.
- Settlement backing is locked and unwithdrawable; **exit liquidity is separately allocated and
  withdrawable**.
- The quote token on Base Sepolia is **Tremor MockUSDC**, freely mintable, not Circle USDC. Its ERC-20
  `symbol()` returns `"USDC"`, which is misleading — say so.
- Portfolio checkpoints are indexed by the **Rust backend, not The Graph**.
- Quotes are the writer's fixed executable prices, **not** a fair-value model.
- The v1 prototype was built 2026-09-02, before the hackathon.
- Public evidence is currently **one-sided** until Group 2 runs.

## Must not say

- "Guaranteed", "risk-free", "perfect hedge".
- "Custom SwapVM opcodes" — there are none.
- "The Graph indexes our checkpoints" — it does not.
- "USDC" unqualified, or anything implying Circle.
- "50% capital savings" as a universal claim — always "for this book at this composition".
- "Order book", "conventional variance swap", "fair-value oracle", "implied volatility".
- That Tremor invented complementary claims.
- Any security claim beyond the tested cases.
- That the shared reserve generalizes beyond the tested two-claim composition. It is mined and real for
  Group 2's book; it is not a universal 50% saving.

## Honest limitations (include these; judges reward them)

- **The cap truncates, and Group 2 shows it happening.** Realized variance came in at ≈22× that group's
  cap (29.9% annualized vs a 6.3% cap), so `x` clamped to 1: HIGH received the entire cap and **CALM
  settled worthless at exactly zero**, removed with `burnWorthless` rather than a payout. A holder of the
  capped-out side gets the cap and no more; the complementary side can get nothing. This is the
  instrument behaving as specified, and it is disclosed on every screen that states the cap.
- **Somebody has to press a button.** Checkpointing and finalization are permissionless and bounded, but
  nobody is paid for them.
- **Exit depth is finite**, and an exit quote can vanish if the writer withdraws unspent buffer.
- **Feed gaps bias variance downward** — a repeated Chainlink round contributes a zero return.
- **Test token**, freely mintable, on a testnet.
- **Sources are not verified on Basescan**; the reproducible-build check is a substitute, not an equal.
- **Two-claim groups only.** No generality is claimed beyond what is tested.
- **Group 1 proves only the HIGH side.** The two-sided evidence — CALM issuance, the shared reserve, the
  blocked exit, the funded exit — comes from **Group 2**, mined separately. Group 1 remains the reference
  for a complete finalize-and-settle lifecycle.
