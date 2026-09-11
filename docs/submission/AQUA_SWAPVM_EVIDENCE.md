# Aqua / SwapVM integration evidence

What this document establishes, and the level of proof behind each claim:

| Claim | Proof level |
|---|---|
| Tremor's deployed router **is** the official 1inch `AquaSwapVMRouter`, unmodified | Bytecode reproduction (§1) |
| Tremor ships **six** SwapVM strategies into Aqua per risk group | Mined `StrategyShipped` ×6 (§2) |
| ISSUE and SETTLE executed **through that router** on Base Sepolia | Mined router `Swapped` (§4) |
| Tremor uses **stock instructions only, no custom opcodes** | Source + bytecode + gate test (§3) |
| EXIT executed through the router on a public chain | **Not yet proven** (§4) |

---

## 1. The router is the official one, and that is proven at the bytecode level

Deployed router: [`0xb8dcED3Cf6266Dd8fEc05849fce3734B79A7e722`](https://sepolia.basescan.org/address/0xb8dcED3Cf6266Dd8fEc05849fce3734B79A7e722), 20,052 bytes of runtime code.

**Runtime bytecode hash** (matches the value pinned in `contracts/deployments/84532.json`):

```bash
cast code 0xb8dcED3Cf6266Dd8fEc05849fce3734B79A7e722 -r https://sepolia.base.org | cast keccak
# 0x1b037303e1ff4f935eb5548ee6ac1ecdde7626d0a043c10731d7bc1e44a8c8bf
```

**Reproduction from the official source.** `contracts/lib/swap-vm` is the 1inch SwapVM repository, vendored
unmodified; the router source is `lib/swap-vm/src/routers/AquaSwapVMRouter.sol`. Building it with this
repository's own compiler settings (solc 0.8.30, via-IR, `optimizer_runs = 200`) produces runtime bytecode
that is **byte-for-byte identical to the deployed code**, with all 282 differing bytes confined to the 21
immutable slots solc recorded in `immutableReferences`:

```bash
cd contracts && forge build
python3 ../docs/submission/evidence/verify-deployed-bytecode.py
# AquaSwapVMRouter   20052   20052   282 diffs   21 imm refs   identical outside immutables
```

Saved output: `docs/submission/evidence/deployed-bytecode-provenance.txt`.

This is the strongest available form of the "unmodified official router" claim — stronger than a source
commit string, which is why `routerSourceCommit` in the manifest honestly reads `"unknown"`: the vendored
directory carries no `.git`, so the upstream commit cannot be recovered from the working tree.

**Custom-opcode claim: there is none, and the repo enforces it.** `web/src/lib/program.ts` exports
`TREMOR_OPCODES` as a deliberately empty set. `contracts/test/RouterCompat.t.sol` is the gate:

```
[PASS] test_gate_pinnedOfficialRouterSource_runsExtructionAndMakerHooks()
[PASS] test_gate_canonicalDeployedRouter_isSwapVmButExposesADifferentSwapAbi()
```

Both passed in the release run recorded in [`FINAL_AUDIT.md`](FINAL_AUDIT.md). The second is notable for
its honesty: it records what the canonical SwapVM address on Base *actually* exposes rather than what
would be convenient.

---

## 2. Six strategies shipped into Aqua, in one transaction

Creating a risk group ships **six** SwapVM programs — one per `(side, leg)` pair — from the writer's
`TremorMakerVault` into canonical Aqua.

**MINED.** Group 1's creation transaction
[`0xe5859545…b858a`](https://sepolia.basescan.org/tx/0xe5859545450e98c509fe610c280f61223fc7e697d2bfe78f5df57586406b858a)
(block 46686188, gas 3,001,009) emitted exactly six `StrategyShipped(bytes32)` events on the vault
`0x9C9341d0E752a97BD1c7c47FB1579866daBCc47C`, alongside two `ReceiptRegistered` and the `GroupCreated`.

```bash
cast logs --from-block 46686188 --to-block 46686188 \
  --address 0x9C9341d0E752a97BD1c7c47FB1579866daBCc47C -r $RPC
# 2 × ReceiptRegistered, 6 × StrategyShipped
```

Each shipped hash is checked against the locally computed order hash at creation time and the transaction
reverts on mismatch (`ShippedHashMismatch`), so the six hashes on chain are the six programs Tremor
intended, not merely six programs.

---

## 3. The exact programs and order modes

Source of truth: `contracts/src/portfolio/PortfolioOrderBuilder.sol`, which is **the single encoding path** —
nothing else builds a portfolio order.

```
ISSUE_HIGH    Salt(g,1) · Deadline(saleEnd) · Extruction(market, [2,1,g])
ISSUE_CALM    Salt(g,2) · Deadline(saleEnd) · Extruction(market, [2,2,g])
EXIT_HIGH     Salt(g,3) · Deadline(expiry)  · Extruction(market, [2,3,g])   + postTransferIn → HIGH receipt
EXIT_CALM     Salt(g,4) · Deadline(expiry)  · Extruction(market, [2,4,g])   + postTransferIn → CALM receipt
SETTLE_HIGH   Salt(g,5) ·                     Extruction(market, [2,5,g])   + postTransferIn → HIGH receipt
SETTLE_CALM   Salt(g,6) ·                     Extruction(market, [2,6,g])   + postTransferIn → CALM receipt
```

Three stock SwapVM instructions and nothing else:

| Instruction | Opcode | Origin | Role in Tremor |
|---|---|---|---|
| `Salt` | `0x02` | `swap-vm/instructions/Controls.sol` | Makes each `(group, mode)` order hash unique |
| `Deadline` | `0x20` | `swap-vm/instructions/Controls.sol` | ISSUE expires at `saleEnd`, EXIT at `expiry` |
| `Extruction` | `0x04` | `swap-vm/instructions/Extruction.sol` | Calls out to `TremorPortfolioMarket` for all pricing |

Program arguments are `[uint8 version, uint8 mode, uint64 groupId]`, with `ARGS_VERSION = 2` for portfolio
groups (v1 is the single-claim series engine). The version byte means a v1 series program can never be
reinterpreted as a portfolio program or vice versa.

**SETTLE deliberately carries no `Deadline`** — a holder who redeems years late still redeems. That is a
design decision, visible in the program layout, not an omission.

Read the live programs back from the chain:
```bash
cast call 0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb "orderFor(uint256,uint8)((...))" 1 1 -r $RPC   # ISSUE_HIGH
cast call 0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb "orderHashFor(uint256,uint8)(bytes32)" 1 1 -r $RPC
cast call 0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb "orderRef(bytes32)(uint256,uint8)" <hash> -r $RPC
```

### What is 1inch's, and what is Tremor's

This distinction matters and is easy to overstate, so it is drawn precisely:

**Official 1inch, unmodified:** the `AquaSwapVMRouter` itself; the SwapVM interpreter and its instruction
set; `Salt`, `Deadline` and `Extruction`; the maker-hook mechanism (`postTransferIn`); Aqua's shared
strategy allocation and settlement; the `safeTransferFrom(taker, router, …)` token-pull path that makes the
router the taker's spender.

**Tremor's own, composed on top:** the *choice and sequencing* of instructions into six programs per group;
the `Extruction` target `TremorPortfolioMarket`, which contains 100% of the pricing and all reserve
accounting; the `postTransferIn` hook wired to the receipt token, which is what makes a burn the only way a
reservation is released; the shared `max(h,c)` reserve and exit-buffer logic; and the receipt ERC-20 with a
router-only maker hook.

**Tremor therefore uses custom *program composition and Extruction logic*, not custom opcodes.** Any claim
of custom SwapVM opcodes would be false, and the repository is structured to keep it false.

---

## 4. Legs proven to execute through the router

**MINED — ISSUE.** [`0x117d2fdb…7b58a`](https://sepolia.basescan.org/tx/0x117d2fdb2e203ac5e5f62963163d2c914cc454c132c084f6d1b266c7a057b58a), block 46686374, gas 235,141.

- `from` buyer `0xbaAe28c7…`, **`to` the router `0xb8dcED3C…`** — the transaction target *is* the router.
- Emitted one router `Swapped` event plus `PortfolioIssued(1, buyer, high=true, 100e18, 30000000, …)`.
- Token flow: 30,000,000 MockUSDC buyer → vault; 100e18 HIGH receipts vault → buyer.

**MINED — SETTLE.** [`0xbb315073…5f488`](https://sepolia.basescan.org/tx/0xbb315073250d0a352639ea2977ce6ad85688522d31a07b3e49ff6dce0885f488), block 46686760, gas 171,919.

- `from` buyer, **`to` the router**; one router `Swapped`; `PortfolioSettled(1, buyer, high=true, 100e18, 42700, 0)`.
- The receipt-token trail in this single transaction shows the whole maker-hook mechanism working:
  `buyer → router` (100e18), `router → vault` (100e18), then `vault → 0x0` (100e18, the burn). The burn is
  what releases the reservation.

**The router is the taker's spender, confirmed by mined approvals:**

| Block | Tx | Approval |
|---|---|---|
| 46686368 | `0x89d94e21…` | buyer approves **router** 30,300,000 MockUSDC (premium + 1% headroom) |
| 46686756 | — | buyer approves **router** exactly 100e18 HIGH receipts |

Aqua is never the taker's spender. Aqua's allowance belongs to the *maker's vault*, granted once in the
vault constructor and unrevokable by the writer — visible on chain as the vault's `type(uint256).max`
receipt approval to Aqua at block 46686188.

Verify any of these:
```bash
cast logs --from-block 46685189 --to-block latest \
  --address 0xb8dcED3Cf6266Dd8fEc05849fce3734B79A7e722 -r $RPC   # exactly 2 Swapped events
```

**NOT PROVEN — EXIT.** No EXIT leg has executed on a public chain. Group 1 is finalized, so it can never
host one. EXIT is exercised only in local fork tests (`PortfolioForkE2E.t.sol`, `ExitLeg.t.sol`,
`demo.sh` stages P4–P5). Closing this is the entire purpose of
[`GROUP2_EXECUTION_RUNBOOK.md`](GROUP2_EXECUTION_RUNBOOK.md), which is prepared and awaiting authorization.

Until that runs, the honest statement is: **two of the three legs are proven on a public chain; EXIT is
proven locally only.**

---

## 5. Quote equals swap

The engine writes storage only when `!isStaticContext`; the arithmetic on both paths is identical
(`TremorPortfolioMarket.extruction`). The frontend never shows a client-side estimate next to a signable
button — every ticket re-quotes through `router.quote` against the group's own order, which is the exact
code path the swap runs (`web/src/lib/portfolio-chain.ts:135-163`).

Verify a live quote against the deployed router:
```bash
cast call 0xb8dcED3Cf6266Dd8fEc05849fce3734B79A7e722 "quote(...)" <order> <amount> <takerData> -r $RPC
```

Covered locally by `MarketPricing.t.sol` (22 tests) and `ShipRoundTrip.t.sol` (9 tests), which also assert
`router.hash(order) == keccak256(abi.encode(order)) ==` the Aqua strategy hash for every leg.

---

## 6. Router-only authorization

`extruction` requires `msg.sender == ROUTER` in both the v2 engine and the v3 portfolio market:

```solidity
require(msg.sender == ROUTER, NotRouter(msg.sender));
```

The comment in `TremorPortfolioMarket.sol:296-299` states why this is load-bearing: only the router
guarantees the `query` describes an order that is genuinely executing. Without it, anyone could hand the
function a fabricated query naming a real order hash and the real vault, and mutate the ledger with no
tokens moving.

**QUERY** confirms the deployed market's `ROUTER()` immutable is the deployed router:
```bash
cast call 0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb "ROUTER()(address)" -r $RPC
# 0xb8dcED3Cf6266Dd8fEc05849fce3734B79A7e722
```

Direct-call rejection is covered by `PortfolioAdversarial.t.sol` (13 tests) and `PortfolioGate.t.sol`
(19 tests), both passing in the recorded release run.
