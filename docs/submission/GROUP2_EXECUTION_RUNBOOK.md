# Group 2 execution runbook — bounded public two-sided evidence

**Status: PREPARED, NOT EXECUTED. No transaction in this document has been broadcast.**

Purpose: close the one evidence gap that Group 1 cannot close. Group 1 is finalized and fully settled,
so it can never host an EXIT, and it never had CALM outstanding, so it never demonstrated the shared
reserve. This runbook creates exactly one new group whose lifecycle produces every missing artefact and
then closes cleanly.

Everything below was derived from the deployed bytecode and the current chain state. Re-run the
"pre-flight" reads immediately before execution — balances and timestamps go stale.

---

## 1. Verified deployed addresses

Read from `contracts/deployments/84532.json` and confirmed against the chain (`cast code` non-empty at
every address; immutables read back from the portfolio market itself).

| Role | Address | Confirmed by |
|---|---|---|
| Chain | Base Sepolia, chainId **84532** | `cast chain-id` |
| RPC | `https://sepolia.base.org` | — |
| TremorPortfolioMarket | `0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb` | 20,943 bytes runtime |
| AquaSwapVMRouter | `0xb8dcED3Cf6266Dd8fEc05849fce3734B79A7e722` | `portfolioMarket.ROUTER()` |
| Aqua | `0x3B568C149DDf92Bd1f7deF40bDD8930503e70B31` | `portfolioMarket.AQUA()` |
| Chainlink ETH/USD | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` | `portfolioMarket.FEED()` |
| MockUSDC (quote) | `0x13a058bE25Da579e0858d689F5982eDaCE8356B7` | `portfolioMarket.QUOTE_TOKEN()` |
| Portfolio VarianceAccumulator | `0xea5A9Cfb462509f51420E10f5732891481fE634F` | `portfolioMarket.ACCUMULATOR()` |
| Writer maker vault | `0x9C9341d0E752a97BD1c7c47FB1579866daBCc47C` | `portfolioMarket.vaultOf(writer)` |
| Writer / deployer | `0x975D862A1f01a292EDf11b12cC809dffaC35997A` | vault `OWNER()` |
| Buyer | `0xbaAe28c72177Bc3814dd0961b9aA09fddB56B752` | — |

> The quote token is **Tremor MockUSDC**, a freely mintable test token deployed by this project. Its
> ERC-20 `symbol()` returns the string `"USDC"`, which is a deliberate-looking but misleading label.
> It is **not** Circle USDC and has no relationship to it. Never describe it as real USDC.

All eight functions this runbook calls were confirmed present in the deployed runtime bytecode by
selector search:

| Selector | Function |
|---|---|
| `0x5d12928b` | `createVault()` |
| `0xc4ca30d3` | `createGroup(address,(address,address,uint40,uint40,uint40,uint32,uint64,uint128,uint128,uint128,uint128,uint128,uint128))` |
| `0x6eb2d8b9` | `allocateExitBuffer(uint256,uint256)` |
| `0x96db93ef` | `fundExitBuffer(uint256,uint256)` |
| `0x093b3400` | `withdrawExitBuffer(uint256,uint256)` |
| `0xfdfcb532` | `burnWorthless(uint256,bool,uint256)` |
| `0xb4a72944` | `groupView(uint256)` |
| `0x8f23b326` | `groupCount()` |

---

## 2. Pre-flight reads (run immediately before execution)

```bash
export RPC=https://sepolia.base.org
export MKT=0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb
export ACC=0xea5A9Cfb462509f51420E10f5732891481fE634F
export VAULT=0x9C9341d0E752a97BD1c7c47FB1579866daBCc47C
export USDC=0x13a058bE25Da579e0858d689F5982eDaCE8356B7
export ROUTER=0xb8dcED3Cf6266Dd8fEc05849fce3734B79A7e722
export WRITER=0x975D862A1f01a292EDf11b12cC809dffaC35997A
export BUYER=0xbaAe28c72177Bc3814dd0961b9aA09fddB56B752

cast chain-id -r $RPC                                        # must be 84532

# HARD GATE. The sequence below hard-codes group id 2 in every call, every expected event and every
# assertion. createGroup assigns ++groupCount, so it yields group 2 ONLY while this reads exactly 1.
# If it reads anything else, somebody created a group in the meantime: STOP, do not send createGroup,
# and re-derive the whole runbook against the real id before asking for authorization again.
cast call $MKT "groupCount()(uint256)" -r $RPC                # MUST be exactly 1
cast call $VAULT "freeQuote()(uint256)" -r $RPC               # must be >= 105000000
cast call $USDC "balanceOf(address)(uint256)" $BUYER -r $RPC  # must be >= 105000000
cast balance $WRITER -r $RPC                                  # gas
cast balance $BUYER  -r $RPC                                  # gas
cast gas-price -r $RPC
curl -s http://localhost:8789/health                          # indexer_error must be null
```

Baseline captured 2026-09-12 (re-verify, do not reuse):

| Read | Value |
|---|---|
| `groupCount()` | 1 |
| vault MockUSDC balance | 129,957,300 (129.957300) |
| vault `lockedQuote()` | 0 |
| vault `freeQuote()` | 129,957,300 |
| writer ETH | 0.109569498841096988 |
| writer MockUSDC | 10,205,000,000 |
| buyer ETH | 0.114980071317735058 |
| buyer MockUSDC | 970,042,700 |
| gas price | 6,000,000 wei (0.006 gwei) |
| buyer→router MockUSDC allowance (residual) | 75,750,000 |
| buyer→router HIGH/CALM receipt allowance | 0 |

---

## 3. Group parameters

Derive `START` from the chain, never from the local clock:

```bash
export START=$(cast block latest -f timestamp -r $RPC)
export EXPIRY=$((START + 1800))
echo "start=$START expiry=saleEnd=$EXPIRY"
```

| Field | Value | Constraint satisfied |
|---|---|---|
| `feed` | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` | `== FEED` |
| `quoteToken` | `0x13a058bE25Da579e0858d689F5982eDaCE8356B7` | `== QUOTE_TOKEN` |
| `start` | fresh block timestamp `T` | `saleEnd >= block.timestamp`, `start <= saleEnd` |
| `expiry` | `T + 1800` | `expiry > start` |
| `saleEnd` | `T + 1800` | `saleEnd <= expiry` |
| `sampleInterval` | **600** | `>= MIN_INTERVAL (300)`; `1800 % 600 == 0` |
| samples | `1800 / 600 = 3` | `2 <= 3 <= 256` |
| `capVariance` | **4e15** = `4000000000000000` | `0 < cap <= MAX_CAP_VARIANCE (4e18)` |
| `capPayoutPerUnit` (`S`) | **1000000** (1.000000 MockUSDC) | `> 0` |
| `maxUnitsPerSide` | **1000e18** | `> 0`; max liability 1,000,000,000 fits `uint248` |
| `askHigh` | 300000 | `0 < askHigh <= S`, `bidHigh <= askHigh` |
| `bidHigh` | 250000 | |
| `askCalm` | 750000 | `0 < askCalm <= S`, `bidCalm <= askCalm` |
| `bidCalm` | 700000 | |

### Why `sampleInterval = 600` and not 300

Realized variance is **annualized**, not accumulated:
`rv = Σ ln(P_i/P_{i-1})² · 31,536,000 / (end − start)` (`contracts/src/libs/RealizedVariance.sol:52`).
A longer window therefore does *not* raise `rv` proportionally — it only adds samples.

Measured Chainlink ETH/USD cadence on Base Sepolia over the hour before writing (round ids
`1<<64 | 279775..279785`): gaps of 88, 78, 230, 406, 562, 792, 132, 200, 856, 254 seconds — mean ≈ 360 s,
max 856 s. On a 300 s grid many samples would resolve to the *same* round, contributing zero returns and
biasing `rv` downward. A 600 s grid exceeds the mean gap, so most samples resolve to distinct rounds
while still yielding 3 returns (Group 1 had 1 usable return).

### Why `capVariance = 4e15`

Group 1 realized `rv = 427,669,801,868,880` (≈ 4.28e14) against `cap = 1e18`, giving
`x = 0.000428` and therefore `highPpu = 427` out of 1,000,000 — HIGH was technically positive but
visually invisible. Expected `rv` for Group 2 is the same order of magnitude (`rv` is a rate, and the
feed is the same). With `cap = 4e15`, an `rv` near 5–9e14 puts `x` around **0.12–0.22**, i.e.
`highPpu ≈ 120,000–220,000` and `calmPpu ≈ 780,000–880,000`. Both sides then settle for visibly
non-trivial amounts.

**This is an expectation, not a guarantee.** The outcome is whatever the feed prints:

- `rv ≥ 4e15` (≈ 9× the Group 1 rate) clips `x = 1` → `calmPpu = 0` → CALM settles worthless.
- `rv < 4e9` (essentially a frozen feed) → `highPpu = 0` → HIGH settles worthless.

Either branch is *still valid evidence*: a zero-payout side is exactly what `burnWorthless` exists for,
and it is on the required-evidence list. Do not re-roll the group to chase a preferred number. Record
what happened.

---

## 4. Answers to the three open design questions

**Q1 — does the writer need another vault deposit?** **No.** Peak `lockedQuote` across the whole
sequence is **105,000,000** (100,000,000 reserve + 5,000,000 exit buffer) against a current free balance
of **129,957,300**, a margin of 24,957,300. Both taker premiums (30,000,000 + 75,000,000) pay *into* the
vault and raise the balance further. The 100 MockUSDC top-up floated in the Phase 1 message is
**withdrawn as unnecessary**.

**Q2 — `allocateExitBuffer` or `fundExitBuffer`?** **`allocateExitBuffer(2, 5000000)`, called by the
writer.** It earmarks the vault's *existing free collateral* and moves no tokens, which is both
sufficient here and the more honest demonstration: it shows the writer electing to convert withdrawable
cash into buyback liquidity. `fundExitBuffer` is the permissionless path that transfers the *caller's own*
tokens into the vault and would require a MockUSDC approval to the market; it is not needed and must not
be used, because using it would obscure the distinction the demo is making.

**Q3 — spenders and bounded allowances.** SwapVM pulls the taker's `tokenIn` with
`safeTransferFrom(taker, router, …)` executed by the router, so **the taker always approves the ROUTER,
never Aqua** (`web/src/lib/contracts.ts:151-157`). This is confirmed by Group 1's mined history: the buyer
approved the router 30,300,000 MockUSDC at block 46686368 before the ISSUE, and approved the router
exactly 100e18 HIGH receipts at block 46686756 before the SETTLE. Aqua's allowance belongs to the
*maker's vault*, granted once in the vault constructor and unrevokable.

| Leg | Token to approve | Spender | Exact amount | Notes |
|---|---|---|---|---|
| ISSUE_HIGH | MockUSDC | router | **30,000,000** | premium is exact; add headroom only if using exact-out |
| ISSUE_CALM | MockUSDC | router | **75,000,000** | |
| EXIT_HIGH | HIGH receipt | router | **20e18** | |
| SETTLE_HIGH | HIGH receipt | router | **80e18** | only if `highPpu > 0` |
| SETTLE_CALM | CALM receipt | router | **100e18** | only if `calmPpu > 0` |

No unlimited approvals. Note the **pre-existing residual allowance of 75,750,000 MockUSDC from buyer to
router** left over from Group 1; it is large enough to silently fund the ISSUE_HIGH leg. Set each
approval explicitly to the exact figure above rather than relying on the residue, and check the residue
afterwards.

---

## 5. Exact expected state after every step

Starting point: vault balance 129,957,300, locked 0, reserve 0, buffer 0, H 0, C 0.
All figures are MockUSDC base units (6 decimals) and 1e18-scaled receipt units.

| # | Action | Vault balance | `lockedQuote` | `reserveLocked` | `exitBuffer` | `freeQuote` | H out | C out |
|---|---|---|---|---|---|---|---|---|
| S0 | start | 129,957,300 | 0 | 0 | 0 | 129,957,300 | 0 | 0 |
| S1 | `createGroup` | 129,957,300 | 0 | 0 | 0 | 129,957,300 | 0 | 0 |
| S2 | ISSUE_HIGH 100 (pays 30,000,000) | 159,957,300 | 100,000,000 | 100,000,000 | 0 | 59,957,300 | 100 | 0 |
| S3 | ISSUE_CALM 100 (pays 75,000,000) | 234,957,300 | 100,000,000 | **100,000,000** | 0 | 134,957,300 | 100 | 100 |
| S4 | EXIT_HIGH 20, buffer 0 | — **reverts** — | | | | | | |
| S5 | `allocateExitBuffer(2, 5000000)` | 234,957,300 | 105,000,000 | 100,000,000 | 5,000,000 | 129,957,300 | 100 | 100 |
| S6 | EXIT_HIGH 20 (receives 5,000,000) | 229,957,300 | 100,000,000 | 100,000,000 | 0 | 129,957,300 | 80 | 100 |
| S7 | checkpoints + `finalize` | 229,957,300 | `L` | `L` | 0 | 229,957,300 − `L` | 80 | 100 |
| S8 | SETTLE both sides | 229,957,300 − `L` | 0 | 0 | 0 | 229,957,300 − `L` | 0 | 0 |

where `L = floor(80e18·highPpu/1e18) + floor(100e18·calmPpu/1e18) = 80·hp + 100·cp`, and since
`hp + cp = 1,000,000`, `L = 100,000,000 − 20·hp`. Collateral released at finalization is exactly `20·hp`.

**The headline number, step S3:** `groupView(2).reserveLocked` reads **100,000,000** while
`groupView(2).standaloneCaps` reads **200,000,000**. Two independently backed single-sided series
would lock 200 MockUSDC for this same book; the shared reserve locks 100. That is a **50% reduction
for this book at this composition** — not a universal claim.

**Why step S4 must revert, in one line:** exiting HIGH when CALM is the larger-or-equal side releases
*zero* reserve (`max(80,100) = max(100,100) = 100`), so the 5,000,000 payout has nothing to draw on,
and paying it out of the reserve would strand CALM holders. `ExitUnderfunded(2, 5000000, 0)`.

Buyer token deltas across the whole sequence (excluding gas): −30,000,000 −75,000,000 +5,000,000
= **−100,000,000**, then `+80·hp` and `+100·cp` = `+L` at settlement. Net
`L − 100,000,000 = −20·hp`. Receipt balances end at 0 on both sides.

Worked example at `hp = 210,000` / `cp = 790,000` (mid of the expected band): `L = 95,800,000`;
finalization releases 4,200,000; SETTLE_HIGH pays 16,800,000; SETTLE_CALM pays 79,000,000; vault ends at
134,157,300; buyer nets −4,200,000 on premiums against payouts.

---

## 6. Transaction sequence

Signing: **writer** steps run from the writer keystore with `--account <name>`, unlocked interactively —
no key material is read, printed, or passed on a command line. **Buyer** steps run through the browser
wallet at `http://localhost:3002` connected as `0xbaAe28c72177Bc3814dd0961b9aA09fddB56B752`, which
already implements every leg (`web/src/lib/tx.ts`: approve → `router.swap`). Substituting another signing
method requires explicit authorization.

The whole trading phase (S1–S6) must complete **inside the 1800-second window**, because issuance requires
`block.timestamp <= saleEnd` and exits require `block.timestamp < expiry`. Budget: ~10 minutes of work in
a 30-minute window.

### S1 — create the group (writer)

```bash
export START=$(cast block latest -f timestamp -r $RPC)
export EXPIRY=$((START + 1800))
cast send $MKT \
  "createGroup(address,(address,address,uint40,uint40,uint40,uint32,uint64,uint128,uint128,uint128,uint128,uint128,uint128))" \
  $VAULT \
  "(0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1,0x13a058bE25Da579e0858d689F5982eDaCE8356B7,$START,$EXPIRY,$EXPIRY,600,4000000000000000,1000000,1000000000000000000000,300000,250000,750000,700000)" \
  --account <writer-keystore> -r $RPC
```

Expect: `GroupCreated(2, writer, vault, highReceipt, calmReceipt, params)`, six `StrategyShipped` on the
vault, and one seeding `Checkpointed` (the window opens immediately, so `_create` seeds sample 0).
Gas reference: Group 1's creation used 3,001,009.

Capture the two new receipt addresses:
```bash
cast call $MKT "groupView(uint256)((address,address,address,address,uint256,uint256,uint256,uint256,uint256,bool,uint256,uint256,uint256,uint256))" 2 -r $RPC
```

### Building a router call — the shared recipe for S2, S3, S4, S6 and S8

Every ISSUE, EXIT and SETTLE is the same three-argument call on the **router**:

```solidity
ISwapVM.swap(Order order, uint256 amount, bytes takerTraitsAndData)
  returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)
```

`cast` signature (the `Order` struct is `(address maker, uint256 traits, bytes data)`):

```
swap((address,uint256,bytes),uint256,bytes)
```

Do **not** hand-encode the `Order`. Read it from the market, which is the single encoding path and
guarantees the hash matches the strategy Aqua holds:

```bash
# PMode: 1=ISSUE_HIGH 2=ISSUE_CALM 3=EXIT_HIGH 4=EXIT_CALM 5=SETTLE_HIGH 6=SETTLE_CALM
export ORDER=$(cast call $MKT "orderFor(uint256,uint8)((address,uint256,bytes))" 2 <mode> -r $RPC)
# Cross-check it resolves back to (group 2, that mode):
cast call $MKT "orderHashFor(uint256,uint8)(bytes32)" 2 <mode> -r $RPC
cast call $MKT "orderRef(bytes32)(uint256,uint8)" <thatHash> -r $RPC      # must print 2, <mode>
cast call $ROUTER "hash((address,uint256,bytes))(bytes32)" "$ORDER" -r $RPC   # must equal orderHashFor
```

`takerTraitsAndData` is built by the Lens — never by hand:

```bash
# buildTakerData(taker, isExactIn, isAToB, thresholdAmount, deadline, allowPartialFill)
export LENS=0x016CEde278FFB5B2B79E9d7afe11E4d17Bb9B059
cast call $LENS "buildTakerData(address,bool,bool,uint256,uint40,bool)(bytes)" \
  $BUYER <isExactIn> <isAToB> <threshold> <deadline> false -r $RPC
```

`isAToB` is fixed by token-address ordering, the same rule the order builder uses:

- **ISSUE** takes MockUSDC in → `isAToB = (usdc < receipt)`
- **EXIT** and **SETTLE** take the receipt in → `isAToB = (receipt < usdc)`

Compare the two addresses as lowercase hex. With
`usdc = 0x13a058bE…` (leading byte `0x13`), `isAToB` for ISSUE is true whenever the receipt address sorts
above it. Derive it per-leg from the actual receipt addresses S1 produced; do not assume.

`allowPartialFill = false` throughout. A partial fill would silently change the amounts this runbook
asserts, and an unexpected clamp is an abort condition, not something to absorb.

**Always dry-run the identical arguments through `quote` first** — the engine runs the same arithmetic on
both paths, so a matching quote is a genuine pre-check, not a formality:

```bash
cast call $ROUTER "quote((address,uint256,bytes),uint256,bytes)(uint256,uint256,bytes32)" \
  "$ORDER" <amount> "$TAKERDATA" -r $RPC
```

Then send:

```bash
cast send $ROUTER "swap((address,uint256,bytes),uint256,bytes)" \
  "$ORDER" <amount> "$TAKERDATA" --account <keystore> -r $RPC
```

The app at `/pairs/2` does all of the above internally and re-quotes immediately before signing
(`web/src/lib/tx.ts`), so driving the buyer legs through the browser wallet is the preferred path; the
`cast` form is the fallback and the verification tool.

### S2 — ISSUE_HIGH 100 units (buyer)

Approve **exactly**, then swap. Set the approval explicitly rather than relying on the residual
75,750,000 allowance left over from Group 1 — that residue is large enough to fund this leg silently:

```bash
cast send $USDC "approve(address,uint256)" $ROUTER 30000000 --account <buyer> -r $RPC
cast call  $USDC "allowance(address,address)(uint256)" $BUYER $ROUTER -r $RPC   # must read 30000000
```

Then swap ISSUE_HIGH (mode 1) **exact-out** for 100e18 units:

- `amount = 100000000000000000000` (100e18)
- `isExactIn = false`, so `amount` is the units OUT and the premium is computed
- `threshold` = max the taker will pay = `30000000`; `deadline` = now + 900

Expect `PortfolioIssued(2, buyer, high=true, units=100e18, premium=30000000, h=100e18, c=0, reserve=100000000)`
and one router `Swapped`. Verify `lockedQuote() == 100000000`.

### S3 — ISSUE_CALM 100 units (buyer) — the shared-reserve moment

```bash
cast send $USDC "approve(address,uint256)" $ROUTER 75000000 --account <buyer> -r $RPC
cast call  $USDC "allowance(address,address)(uint256)" $BUYER $ROUTER -r $RPC   # must read 75000000
```

Swap ISSUE_CALM (mode 2) exact-out 100e18, `threshold = 75000000`.

Expect `PortfolioIssued(2, buyer, high=false, units=100e18, premium=75000000, h=100e18, c=100e18, reserve=100000000)`.

**Capture this immediately — it is the single most important read in the submission:**
```bash
cast call $MKT "groupView(uint256)((address,address,address,address,uint256,uint256,uint256,uint256,uint256,bool,uint256,uint256,uint256,uint256))" 2 -r $RPC
# reserveLocked 100000000, standaloneCaps 200000000
cast call $VAULT "lockedQuote()(uint256)" -r $RPC      # 100000000, UNCHANGED from S2
```

### S4 — underfunded EXIT, **simulation only, never broadcast**

A reverting transaction cannot be mined, so this is an `eth_call` and must be labelled an unmined
simulation everywhere it appears. **Do not `cast send` this step under any circumstance.**

Build EXIT_HIGH (mode 3), exact-in 20e18, `threshold = 0`:

```bash
export ORDER_EXIT=$(cast call $MKT "orderFor(uint256,uint8)((address,uint256,bytes))" 2 3 -r $RPC)
export TD_EXIT=$(cast call $LENS "buildTakerData(address,bool,bool,uint256,uint40,bool)(bytes)" \
  $BUYER true <isAToB=(high<usdc)> 0 $((START+900)) false -r $RPC)

cast call $ROUTER "swap((address,uint256,bytes),uint256,bytes)(uint256,uint256,bytes32)" \
  "$ORDER_EXIT" 20000000000000000000 "$TD_EXIT" --from $BUYER -r $RPC
# expected: execution reverted, custom error ExitUnderfunded(2, 5000000, 0)
```

Decode the selector to prove which error it is:
```bash
cast sig "ExitUnderfunded(uint256,uint256,uint256)"
```

Save the raw output plus the block number it was simulated against to
`docs/submission/evidence/s4-exit-underfunded-simulation.txt`. **Do not write a transaction hash beside
it — there isn't one.**

### S5 — allocate the exit buffer (writer)

```bash
cast call $MKT "allocateExitBuffer(uint256,uint256)" 2 5000000 --from $WRITER -r $RPC   # must not revert
cast send $MKT "allocateExitBuffer(uint256,uint256)" 2 5000000 --account <writer> -r $RPC
```

Expect `ExitBufferFunded(2, writer, 5000000, 5000000)`; `lockedQuote()` rises to 105,000,000; **no token
transfer occurs** — that absence is the tell that it came from free collateral, not a wallet. Use
`allocateExitBuffer`, never `fundExitBuffer`: the latter pulls the caller's own tokens and would need a
MockUSDC approval, obscuring exactly the distinction this step demonstrates.

### S6 — successful EXIT_HIGH 20 units (buyer)

```bash
cast send <HIGH_RECEIPT> "approve(address,uint256)" $ROUTER 20000000000000000000 --account <buyer> -r $RPC
cast call  <HIGH_RECEIPT> "allowance(address,address)(uint256)" $BUYER $ROUTER -r $RPC  # must read 20e18
```

Re-run the S4 `quote` — it must now return `amountOut = 5000000` instead of reverting — then send the
identical `swap`.

Expect `PortfolioExited(2, buyer, high=true, units=20e18, amountOut=5000000, released=0, draw=5000000, newReserve=100000000)`
and a router `Swapped`. **`released=0` and `draw=5000000` are the point**: the payout came entirely from
the buffer. Buffer returns to 0; `lockedQuote()` back to 100,000,000.

### S7 — checkpoint and finalize (permissionless — prefer a third account)

Only after `block.timestamp > expiry`. Walk the window, then finalize:
```bash
cast call $ACC "progress(uint256)(uint256,uint256,uint256)" 2 -r $RPC   # stored, available, total
cast send $ACC "checkpoint(uint256,uint16)" 2 8 --account <keystore> -r $RPC   # repeat until stored == total
cast send $ACC "finalize(uint256)(uint256)" 2 --account <keystore> -r $RPC
```
Expect `GroupFinalized(2, finalVariance, xWad, highPpu, calmPpu, released)`.

Group 1's checkpoint and finalize were both sent by the writer. Sending these from a **third account**
would materially strengthen the permissionlessness claim. If no third funded account exists, say so in
the evidence document rather than implying one was used.

Read the actual payouts before deciding step S8:
```bash
cast call $MKT "groupView(uint256)(...)" 2 -r $RPC   # finalVariance, xWad, highPpu, calmPpu
```

### S8 — settle, and burn only an exactly-zero side

**Read the actual PPUs first and branch on them. Do not decide this step in advance, and never state an
expected payout before `GroupFinalized` has been read.**

SETTLE is **exact-in only** (`_priceSettle` reverts `ExactOutUnsupported` otherwise), so
`isExactIn = true`, `amount` is the receipt units, `threshold = 0`, and `isAToB = (receipt < usdc)`.
SETTLE programs carry **no `Deadline`** by design — a holder who redeems late still redeems — so the
`deadline` argument to `buildTakerData` is the taker's own limit, not the order's.

**If `highPpu > 0`** — settle 80e18 HIGH (mode 5):
```bash
cast send <HIGH_RECEIPT> "approve(address,uint256)" $ROUTER 80000000000000000000 --account <buyer> -r $RPC
export ORDER_SH=$(cast call $MKT "orderFor(uint256,uint8)((address,uint256,bytes))" 2 5 -r $RPC)
export TD_SH=$(cast call $LENS "buildTakerData(address,bool,bool,uint256,uint40,bool)(bytes)" \
  $BUYER true <isAToB=(high<usdc)> 0 <now+900> false -r $RPC)
cast call $ROUTER "quote((address,uint256,bytes),uint256,bytes)(uint256,uint256,bytes32)" \
  "$ORDER_SH" 80000000000000000000 "$TD_SH" -r $RPC        # amountOut must equal 80·highPpu
cast send $ROUTER "swap((address,uint256,bytes),uint256,bytes)" \
  "$ORDER_SH" 80000000000000000000 "$TD_SH" --account <buyer> -r $RPC
```

**If `calmPpu > 0`** — settle 100e18 CALM (mode 6), identically with
`approve … 100000000000000000000`, `orderFor(2, 6)`, `isAToB = (calm < usdc)`, amount `100e18`; the quote's
`amountOut` must equal `100·calmPpu`.

**If a PPU is exactly 0** — that side cannot settle at all (`_priceSettle` reverts `ZeroPayout(2, mode)`).
Remove it from the holder's wallet instead, with no router involvement:
```bash
cast send $MKT "burnWorthless(uint256,bool,uint256)" 2 <true|false> <units> --account <buyer> -r $RPC
```
Call `burnWorthless` **only** for a side whose PPU is exactly zero — it reverts `PayoutNotZero(ppu)`
otherwise, by design. Never call it on a side that can settle, and never call it to tidy up.

End state to verify: `highOutstanding == 0`, `calmOutstanding == 0`, `reserveLocked == 0`,
`exitBuffer == 0`, `lockedQuote() == 0`, both receipt `totalSupply()` back to the unsold inventory held by
the vault.

End state to verify: `highOutstanding == 0`, `calmOutstanding == 0`, `reserveLocked == 0`,
`exitBuffer == 0`, `lockedQuote() == 0`, both receipt `totalSupply()` back to the unsold inventory held by
the vault.

---

## 7. Calldata validation before sending

For every `cast send`, first build and inspect the calldata, and dry-run it:

```bash
cast calldata "allocateExitBuffer(uint256,uint256)" 2 5000000
cast call $MKT "allocateExitBuffer(uint256,uint256)" 2 5000000 --from $WRITER -r $RPC   # must not revert
cast estimate $MKT "allocateExitBuffer(uint256,uint256)" 2 5000000 --from $WRITER -r $RPC
```

Checks before each send:
- target address matches the table in §1 exactly (compare full 20 bytes, not a prefix);
- `--from` is the intended signer for that step (writer vs buyer);
- the spender in any `approve` is the **router**, never Aqua, never the market;
- the amount matches §4 exactly;
- `cast call` of the same arguments does not revert;
- for buyer legs, the UI's re-quote matches the expected premium/proceeds in §5.

---

## 8. Receipt and event verification after each send

```bash
cast receipt <txhash> -r $RPC                       # status must be 0x1
cast receipt <txhash> --json -r $RPC | python3 -c "import json,sys; r=json.load(sys.stdin); print(r['status'], int(r['blockNumber'],16), r['from'], r['to'], int(r['gasUsed'],16))"
cast logs --from-block <blk> --to-block <blk> --address $MKT -r $RPC
cast logs --from-block <blk> --to-block <blk> --address $ROUTER -r $RPC   # confirms the router leg
cast call $MKT "groupView(uint256)(...)" 2 -r $RPC
cast call $VAULT "lockedQuote()(uint256)" -r $RPC
cast call $VAULT "freeQuote()(uint256)"  -r $RPC
cast call $USDC  "balanceOf(address)(uint256)" $VAULT -r $RPC
```

Assert after every mined step: **`lockedQuote() <= balanceOf(vault)`**, and that `reserveLocked +
exitBuffer == lockedQuote()` for the single-group case.

## 9. Backend reconciliation

```bash
curl -s http://localhost:8789/health            | python3 -m json.tool
curl -s http://localhost:8789/pairs             | python3 -m json.tool
curl -s http://localhost:8789/pairs/2           | python3 -m json.tool
curl -s http://localhost:8789/pairs/2/events    | python3 -m json.tool
curl -s http://localhost:8789/pairs/2/checkpoints | python3 -m json.tool
```

Reconcile field-for-field against `groupView(2)`: `high_outstanding`, `calm_outstanding`,
`reserve_locked`, `exit_buffer`, `finalized`, `final_variance`, `high_ppu`, `calm_ppu`. `indexer_error`
must be `null` and `lag_blocks` small at each checkpoint. Any mismatch is an abort condition.

## 10. Checkpoint and finalization schedule

Window `[T, T+1800]`, interval 600 → sample times `T`, `T+600`, `T+1200`, `T+1800` (3 returns).

| When | Action |
|---|---|
| `T` | `createGroup` seeds sample 0 automatically |
| `T+1800` onwards | `checkpoint(2, 8)` repeatedly until `progress()` shows `stored == total` |
| after that | `finalize(2)` |

Finalization cannot run before the window closes. Allow a few minutes past `T+1800` for the feed's last
round to land.

## 11. Abort conditions — stop and report, do not improvise

Stop immediately and do not send the next transaction if any of these occur:

1. Any send reverts unexpectedly, or a receipt returns `status: 0x0`.
2. `groupCount()` is not 1 at pre-flight (someone else created a group; re-derive ids).
3. `START` is more than ~60 seconds stale when `createGroup` lands.
4. An approval's spender is anything other than the router.
5. Vault balance, `lockedQuote`, `reserveLocked`, `exitBuffer`, or either outstanding figure deviates
   from §5 by any amount.
6. `lockedQuote() > balanceOf(vault)` at any point — this would be a solvency violation and must be
   reported immediately.
7. `/health` reports a non-null `indexer_error`, or the backend stops advancing.
8. `block.timestamp` passes `saleEnd` before S3 completes, or `expiry` before S6 completes.
9. The exit at S6 pays anything other than 5,000,000, or reports `released != 0`.
10. `highPpu + calmPpu != 1,000,000` after finalization.

**Do not create a Group 3 to retry a timed-out flow.** A missed window is reported as a missed window
and re-authorized separately.

## 12. Evidence capture template

One row per mined step, filled from the receipt — never from expectation. Save as
`docs/submission/evidence/group2-transactions.md`.

```
| Step | Tx hash | Block | From | To | Event (decoded) | Gas | Post-state assertion |
|------|---------|-------|------|----|-----------------|-----|----------------------|
| S1 createGroup      |  |  |  |  | GroupCreated(2,…)      |  | groupCount 2 |
| S2 ISSUE_HIGH       |  |  |  |  | PortfolioIssued(…)     |  | reserve 100000000 |
| S3 ISSUE_CALM       |  |  |  |  | PortfolioIssued(…)     |  | reserve 100000000, standalone 200000000 |
| S4 EXIT underfunded | (none — eth_call simulation, unmined) | simulated at block … | | | revert ExitUnderfunded(2,5000000,0) | — | — |
| S5 allocateBuffer   |  |  |  |  | ExitBufferFunded(…)    |  | locked 105000000 |
| S6 EXIT_HIGH        |  |  |  |  | PortfolioExited(…)     |  | buffer 0, H 80 |
| S7 checkpoint(s)    |  |  |  |  | Checkpointed(…)        |  | stored == total |
| S7 finalize         |  |  |  |  | GroupFinalized(…)      |  | hp + cp == 1000000 |
| S8 SETTLE_HIGH      |  |  |  |  | PortfolioSettled(…)    |  | H 0 |
| S8 SETTLE_CALM      |  |  |  |  | PortfolioSettled(…)    |  | C 0, locked 0 |
```

Also capture, once at the end: final `groupView(2)`, final vault balance / `lockedQuote` / `freeQuote`,
both receipt `totalSupply()`, buyer MockUSDC balance, and the matching `/pairs/2` API response.

Explorer link form: `https://sepolia.basescan.org/tx/<hash>`.

---

## 13. What this sequence does and does not prove

Proves (once mined): CALM issuance through Aqua/SwapVM; the shared `max(h,c)` reserve with a concrete
100 vs 200 comparison; exit-buffer allocation from free collateral; a successful EXIT through the router
funded entirely from the buffer; permissionless checkpointing and finalization from Chainlink round
history; complementary settlement of both sides through the router; and liabilities returning to zero.

Does not prove: anything about a group with a different composition; that the 50% saving generalizes;
solvency beyond the observed states; or any security property not covered by the test suite. The
underfunded exit is a **simulation**, never a mined transaction, and must always be presented as such.
