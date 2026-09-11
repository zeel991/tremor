# On-chain evidence — Base Sepolia (chainId 84532)

Every claim below is one of four kinds, and the kind is always stated:

| Tag | Meaning |
|---|---|
| **MINED** | A transaction that exists on Base Sepolia. Hash given. |
| **QUERY** | Current contract state, read live. The exact `cast` command is given so anyone can re-run it. |
| **SIM** | A read-only `eth_call`. Never broadcast, never mined. |
| **LOCAL** | A result from the test suite or a local fork. Not public-chain evidence. |

RPC used throughout: `https://sepolia.base.org`. Explorer: `https://sepolia.basescan.org`.

> **Quote token warning.** The quote asset is **Tremor MockUSDC** at
> `0x13a058bE25Da579e0858d689F5982eDaCE8356B7` — a freely mintable test token this project deployed.
> Its ERC-20 `symbol()` returns `"USDC"`, which reads misleadingly in wallets and explorers. It is not
> Circle USDC and carries no value. All figures below denominated "USDC" mean MockUSDC base units
> (6 decimals).

---

## 1. Deployment

**QUERY** — chain identity and code presence, verified for every manifest address:

```bash
cast chain-id -r https://sepolia.base.org          # 84532
cast code <address> -r https://sepolia.base.org    # non-empty for all of the below
```

| Contract | Address | Runtime bytes |
|---|---|---|
| TremorPortfolioMarket | [`0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb`](https://sepolia.basescan.org/address/0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb) | 20,943 |
| AquaSwapVMRouter (official, unmodified) | [`0xb8dcED3Cf6266Dd8fEc05849fce3734B79A7e722`](https://sepolia.basescan.org/address/0xb8dcED3Cf6266Dd8fEc05849fce3734B79A7e722) | 20,052 |
| Aqua | [`0x3B568C149DDf92Bd1f7deF40bDD8930503e70B31`](https://sepolia.basescan.org/address/0x3B568C149DDf92Bd1f7deF40bDD8930503e70B31) | 2,508 |
| Portfolio VarianceAccumulator | [`0xea5A9Cfb462509f51420E10f5732891481fE634F`](https://sepolia.basescan.org/address/0xea5A9Cfb462509f51420E10f5732891481fE634F) | 6,858 |
| Writer maker vault | [`0x9C9341d0E752a97BD1c7c47FB1579866daBCc47C`](https://sepolia.basescan.org/address/0x9C9341d0E752a97BD1c7c47FB1579866daBCc47C) | 3,652 |
| MockUSDC (test quote token) | [`0x13a058bE25Da579e0858d689F5982eDaCE8356B7`](https://sepolia.basescan.org/address/0x13a058bE25Da579e0858d689F5982eDaCE8356B7) | 1,697 |
| Chainlink ETH/USD | [`0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1`](https://sepolia.basescan.org/address/0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1) | 9,571 |
| VarianceSeriesFactory (v2 controller) | `0xC86Cf4AD22ABD7169458cCDc58c51e71f23586f2` | 17,892 |
| TremorMarketEngine (v2) | `0x44a76D0Df659708a5b8170c0eE1C600C8bc3Eba0` | 8,760 |
| TremorLens | `0x016CEde278FFB5B2B79E9d7afe11E4d17Bb9B059` | 15,184 |
| TremorPrograms | `0x169b52DFa0aFcbCB83A442EfBDBB21cd35209bD0` | 7,607 |
| TremorSeriesDeployer | `0x1E9117E447e4C2C14B8be4eE59877d66bE8B6893` | 11,236 |
| RealizedVarianceOracle | `0x7c40518dA5C3dEa9E5F74d12093bbd53d9FC1124` | 5,562 |
| Series VarianceAccumulator (v2) | `0xcdd795440679d4F33bf410879e62B5A4015b4Dc9` | 6,858 |

Indexing start block: **46685189**. Manifest: `contracts/deployments/84532.json`, **schema version 3**.

**QUERY** — the market's own immutables confirm the wiring rather than the manifest asserting it:

```bash
cast call 0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb "ROUTER()(address)"      -r $RPC  # 0xb8dcED3C…
cast call 0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb "AQUA()(address)"        -r $RPC  # 0x3B568C14…
cast call 0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb "FEED()(address)"        -r $RPC  # 0x4aDC6769…
cast call 0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb "QUOTE_TOKEN()(address)" -r $RPC  # 0x13a058bE…
cast call 0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb "ACCUMULATOR()(address)" -r $RPC  # 0xea5A9Cfb…
cast call 0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb "vaultOf(address)(address)" \
     0x975D862A1f01a292EDf11b12cC809dffaC35997A -r $RPC                                # 0x9C9341d0…
```

All five returned the manifest values.

### 1.1 Reproducible-build provenance

Sources are **not** verified on Basescan (see §6). What exists instead is a byte-level reproduction:
every deployed contract's runtime bytecode is identical to the locally built artifact except at the
immutable slots solc itself recorded in `immutableReferences`.

```bash
cd contracts && forge build
python3 ../docs/submission/evidence/verify-deployed-bytecode.py
```

Output saved at `docs/submission/evidence/deployed-bytecode-provenance.txt`. Ten contracts checked,
ten identical outside immutables — **including `AquaSwapVMRouter`**, which is the bytecode-level proof
that the deployed router is the official 1inch source vendored at `contracts/lib/swap-vm`, unmodified.

The manifest also pins `routerBytecodeHash: 0x1b037303e1ff4f935eb5548ee6ac1ecdde7626d0a043c10731d7bc1e44a8c8bf`.
**QUERY** confirms it: `cast code 0xb8dcED3C… -r $RPC | cast keccak` returns exactly that value.

`routerSourceCommit` is recorded as `"unknown"` and that is honest — the vendored `lib/swap-vm` directory
has no `.git`, so the upstream commit cannot be recovered from the working tree. The bytecode match is
the stronger claim anyway; the commit string is not.

---

## 2. Group 1 — the complete mined lifecycle

Group 1 is **finalized and fully settled**. This is its entire public history — seven transactions, no
more. It proves the HIGH side end to end and nothing about the CALM side.

| # | Block | Tx | From → To | Event | Gas |
|---|---|---|---|---|---|
| 1 | 46685855 | [`0xe2cae4cc…9762d`](https://sepolia.basescan.org/tx/0xe2cae4cc05260049ab01ae37a1789bf9c797411160128f143930d3eaf719762d) | writer → market | `VaultCreated(writer, 0x9C9341d0…)` | — |
| 2 | 46685883 | [`0x2bd9a0ae…c698d`](https://sepolia.basescan.org/tx/0x2bd9a0aebad81f7e9ff0be61d81c7433227337074487e714bb4256a049c698c4) | writer → vault | `Deposited(100000000)` | — |
| 3 | 46686188 | [`0xe5859545…b858a`](https://sepolia.basescan.org/tx/0xe5859545450e98c509fe610c280f61223fc7e697d2bfe78f5df57586406b858a) | writer → market | `GroupCreated(1)` + **6× `StrategyShipped`** + seed `Checkpointed` | 3,001,009 |
| 4 | 46686374 | [`0x117d2fdb…7b58a`](https://sepolia.basescan.org/tx/0x117d2fdb2e203ac5e5f62963163d2c914cc454c132c084f6d1b266c7a057b58a) | buyer → **router** | `PortfolioIssued(1, buyer, high=true, 100e18, 30000000, …)` + router `Swapped` | 235,141 |
| 5 | 46686554 | [`0xce45eb70…f35f8`](https://sepolia.basescan.org/tx/0xce45eb70895c76002a541e23dee487f42c86c9f7da68c9cd3cfdb9761f1f35f8) | writer → accumulator | `Checkpointed(1, samples 1→2)` | 126,617 |
| 6 | 46686586 | [`0xf883cc89…3d4f3`](https://sepolia.basescan.org/tx/0xf883cc89b80ec92f7861430cabbef1e72959c9588f3bb5e972cc8c80b843d4c3) | writer → accumulator | `GroupFinalized(1, …, released 99957300)` | 187,834 |
| 7 | 46686760 | [`0xbb315073…5f488`](https://sepolia.basescan.org/tx/0xbb315073250d0a352639ea2977ce6ad85688522d31a07b3e49ff6dce0885f488) | buyer → **router** | `PortfolioSettled(1, buyer, high=true, 100e18, 42700, 0)` + router `Swapped` | 171,919 |

Reproduce the whole set:
```bash
cast logs --from-block 46685189 --to-block latest \
  --address 0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb -r $RPC
```

### 2.1 Group 1 final state

**QUERY**
```bash
cast call 0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb \
 "groupView(uint256)((address,address,address,address,uint256,uint256,uint256,uint256,uint256,bool,uint256,uint256,uint256,uint256))" 1 -r $RPC
```

| Field | Value |
|---|---|
| writer / vault | `0x975D862A…` / `0x9C9341d0…` |
| HIGH / CALM receipt | `0xF0bB12e9…` / `0x8B48ec64…` |
| highOutstanding / calmOutstanding | 0 / 0 |
| reserveLocked / exitBuffer | 0 / 0 |
| finalized | true |
| finalVariance = xWad | 427,669,801,868,880 |
| highPpu / calmPpu | **427 / 999,573** |

`highPpu + calmPpu = 1,000,000 = capPayoutPerUnit` exactly. That proves **payout complementarity**. It
does **not** by itself prove solvency, and is not offered as such — see §3.

### 2.2 Vault accounting through the lifecycle

**MINED**, read from the vault's own events in the transactions above:

| Stage | Event | balance | locked | `locked <= balance` |
|---|---|---|---|---|
| deposit | `Deposited(100000000)` | 100,000,000 | 0 | ✓ |
| issue | `LockedIncreased(100000000)` | 130,000,000 | 100,000,000 | ✓ |
| finalize | `LockedDecreased(99957300)` | 130,000,000 | 42,700 | ✓ |
| settle | `LockedDecreased(42700)` | 129,957,300 | 0 | ✓ |

- Reserve at issuance: `ceil(100e18 · 1,000,000 / 1e18) = 100,000,000` — matches `LockedIncreased`.
- Final liability: `100,000,000 − 99,957,300 = 42,700 = 100 × 427` — matches `highPpu`.
- Settlement released exactly the remaining 42,700, returning locked to 0.

**QUERY** — current vault state:
```bash
cast call 0x13a058bE25Da579e0858d689F5982eDaCE8356B7 "balanceOf(address)(uint256)" 0x9C9341d0E752a97BD1c7c47FB1579866daBCc47C -r $RPC  # 129957300
cast call 0x9C9341d0E752a97BD1c7c47FB1579866daBCc47C "lockedQuote()(uint256)" -r $RPC  # 0
cast call 0x9C9341d0E752a97BD1c7c47FB1579866daBCc47C "freeQuote()(uint256)"   -r $RPC  # 129957300
```

### 2.3 Receipt supplies

**QUERY**

| Receipt | totalSupply | held by vault | held by buyer |
|---|---|---|---|
| HIGH `0xF0bB12e9…` | 900e18 | 900e18 | 0 |
| CALM `0x8B48ec64…` | 1000e18 | 1000e18 | 0 |

1000e18 of each side was minted into the vault as inventory. 100 HIGH sold and later burned on
settlement; **zero CALM ever sold**. That single fact is the evidence gap §4 exists to close.

### 2.4 Chainlink derivation

**MINED** — two `Checkpointed` events on the portfolio accumulator (seed at group creation, then
samples 1→2). The finalized number reproduces exactly from the checkpoint data:

```
sumSquaredReturns = 8,136,792,273        (from the checkpoint at block 46686554)
window            = 600 s
rv = 8,136,792,273 × 31,536,000 / 600 = 427,669,801,868,880   ✓ equals finalVariance
```

The annualization factor and formula are `contracts/src/libs/RealizedVariance.sol:52`. No oracle write,
no keeper, no price submitted by Tremor — the number is a pure function of the Chainlink proxy's own
round history.

---

## 3. What Group 1 does NOT prove

Stated plainly because a judge will ask:

1. **No CALM was ever issued in Group 1**, so `max(h, c)` never differed from `h + c`. *Closed by Group 2
   §4.1.*
2. **No EXIT was ever executed** in Group 1, funded or underfunded; it is finalized and can never host one.
   *Closed by Group 2 §4.2 and §4.4.*
3. **No exit buffer was ever allocated** in Group 1. *Closed by Group 2 §4.3.*
4. **`burnWorthless` has never been called** publicly. Both Group 1 PPUs were positive, so it did not apply.
5. `highPpu + calmPpu = S` proves the two payouts are complementary. It does **not** prove the vault held
   enough, that rounding never leaves dust, or that every intermediate state was solvent. Those come from
   the observed `locked <= balance` ladder in §2.2 and from the test suite (§5), not from that identity.
6. Checkpointing and finalization are permissionless in code, but both Group 1 calls were sent **by the
   writer**. No third party has exercised that path publicly.

---

## 4. Group 2 — the evidence Group 1 could not produce

**EXECUTED.** Six transactions mined on Base Sepolia plus one labelled simulation. Full decoded detail,
per-step state deltas and reproduction commands: [`evidence/group2-transactions.md`](evidence/group2-transactions.md).

Group 2 parameters: window `1789159992 → 1789161792` (1800 s), `sampleInterval` 600, `capVariance` 4e15,
`capPayoutPerUnit` 1,000,000, `maxUnitsPerSide` 1000e18, quotes HIGH 300000/250000, CALM 750000/700000.
HIGH receipt `0xA897ea80673Fc7908285bFDAfB03254407814067`, CALM receipt `0xFEB46811d84Db9b3B249B724a31dD175CfC72cBE`.

| # | Step | Tx | Block | From → To | Gas |
|---|---|---|---|---|---|
| S1 | `createGroup` → group 2 | [`0xacafa07c…`](https://sepolia.basescan.org/tx/0xacafa07c2bf194d03635db529873b47b46828dd44a49caa00f0fc04661f6592e) | 46695855 | writer → market | 2,983,897 |
| S2 | ISSUE_HIGH 100 | [`0xa52ff9eb…`](https://sepolia.basescan.org/tx/0xa52ff9eb71434b3e5b2500fc4c2f05ee8de07eaabda6f4d8560fbd4c88c36912) | 46696178 | buyer → **router** | 235,141 |
| S3 | ISSUE_CALM 100 | [`0x36d20156…`](https://sepolia.basescan.org/tx/0x36d201560c8db096c42feea38f9612bcb53bb855131e42c79c4321b5ea78ae17) | 46696287 | buyer → **router** | 191,988 |
| S4 | underfunded EXIT | **SIMULATION — no tx, never broadcast** | 46696315 | — | — |
| S5 | `allocateExitBuffer(2, 5000000)` | [`0xdf4f5b90…`](https://sepolia.basescan.org/tx/0xdf4f5b90f945595ac2dc2ceea134f2a59322efa1e251927218bccf77b5b960a4) | 46696359 | writer → market | 68,098 |
| S6 | EXIT_HIGH 20 | [`0x322802e8…`](https://sepolia.basescan.org/tx/0x322802e8c5a18468c9a82aa1895d1c0090c0a28cbc404506bbac095bac591d89) | 46696441 | buyer → **router** | 175,980 |

All six returned `status: 0x1`. S2, S3 and S6 targeted the router and each emitted exactly one `Swapped`.

### 4.1 The shared reserve, proven (S3)

**QUERY** after S3, read straight off `groupView(2)`:

| Field | Value |
|---|---|
| highOutstanding | 100e18 |
| calmOutstanding | 100e18 |
| **`reserveLocked`** | **100,000,000** |
| **`standaloneCaps`** | **200,000,000** |

Before S3 both figures read 100,000,000 with only HIGH outstanding. Selling a second full-cap side
**added nothing to the lock** — the vault's `lockedQuote` stayed at 100,000,000 across the transaction.
Two independently backed single-sided series would lock 200,000,000 for the same book.

Saving: **100,000,000, i.e. 50% for this book at this composition.** Both numbers are contract reads,
not off-chain arithmetic. This is not a universal 50% claim.

### 4.2 The blocked exit (S4) — simulation, not a failed transaction

`eth_call` at block 46696315 against EXIT_HIGH order hash
`0x2223fa7006624419870f3da2677e3ecc76dc182196cfa7c8b719396d210d71f1`:

```
execution reverted: ExitUnderfunded(2, 5000000, 0)
raw: 0x8c7ebfde …0002 …004c4b40 …0000
```

Selector verified with `cast sig`. **A reverting transaction cannot be mined, so this has no hash and
never will.** Capture: [`evidence/s4-exit-underfunded-simulation.txt`](evidence/s4-exit-underfunded-simulation.txt).

Burning 20 HIGH takes the reserve from `max(100,100)` to `max(80,100)` — CALM still sets it, so the burn
releases exactly zero. The same `max(h,c)` property that creates the capital saving is what stops one
side draining shared backing.

### 4.3 Buffer allocation (S5) — zero transfers

`ExitBufferFunded(2, writer, 5000000, 5000000)`, and **zero ERC-20 `Transfer` events in the whole
transaction**. The buffer came from the writer's existing *free* vault collateral; `lockedQuote` rose
100,000,000 → 105,000,000 while the vault balance stayed at 234,957,300.

### 4.4 The funded exit (S6)

`PortfolioExited(2, buyer, high=true, 20e18, amountOut=5000000, released=**0**, draw=**5000000**,
newReserve=100000000)`.

```
MockUSDC:   VAULT  → BUYER    5000000
HIGHrcpt:   BUYER  → ROUTER   20e18
HIGHrcpt:   ROUTER → VAULT    20e18
HIGHrcpt:   VAULT  → 0x0      20e18     ← burned
```

`released = 0, draw = 5,000,000` — paid entirely from the buffer, settlement reserve untouched. HIGH
outstanding 100e18 → 80e18; buffer → 0; HIGH `totalSupply` 1000e18 → 980e18.

### 4.5 Solvency across the trading phase

`lockedQuote <= balance` at every observed state:

| After | balance | locked | margin |
|---|---|---|---|
| S1 | 129,957,300 | 0 | 129,957,300 |
| S2 | 159,957,300 | 100,000,000 | 59,957,300 |
| S3 | 234,957,300 | 100,000,000 | 134,957,300 |
| S5 | 234,957,300 | 105,000,000 | 129,957,300 |
| S6 | 229,957,300 | 100,000,000 | 129,957,300 |

### 4.6 Settlement — complete

| # | Step | Tx | Block | From → To | Gas |
|---|---|---|---|---|---|
| S7a | `checkpoint(2, 8)` | [`0xf107df40…`](https://sepolia.basescan.org/tx/0xf107df40f790c9b45b94fa54b72ad0e5a867692b7e07ce55f43a9c1e08a0f293) | 46696776 | writer → accumulator | 128,366 |
| S7b | `finalize(2)` | [`0xed2ac4d8…`](https://sepolia.basescan.org/tx/0xed2ac4d86f73d1f3875c0623235e9d6e7be785a080988d2904faa1b648477bf6) | 46696797 | writer → accumulator | 167,832 |
| S8a | SETTLE_HIGH 80 | [`0xe3845a36…`](https://sepolia.basescan.org/tx/0xe3845a368cb73d7535d6b6ea30bd37ff91db1f2f47c8d08d8e5280758e8141c4) | 46696892 | buyer → **router** | 171,928 |
| S8b | CALM cannot settle | **SIMULATION — no tx** | 46696864 | — | — |
| S8c | `burnWorthless(2,false,100e18)` | [`0xac4ac42f…`](https://sepolia.basescan.org/tx/0xac4ac42f47846666a0030c42fb9bd17820b5d8ec374913dd8d83f80dc2d33a1c) | 46696944 | buyer → **market** | 44,358 |

**Finalization (S7b).** `Checkpointed(2, samples 1→3, sumSquaredReturns 5095975502759)` then
`GroupFinalized`:

| Field | Value |
|---|---|
| `finalVariance` | **89,281,490,808,337,680** (≈ 8.93e16) |
| `xWad` | **1e18 — x = 1.0, the cap truncated** |
| `highPpu` / `calmPpu` | **1,000,000 / 0** (sum = the cap, preserved at the boundary) |
| released | 20,000,000 |

Realized variance ran ≈**22× the 4e15 cap** — roughly **29.9% annualized vol** against a cap set at 6.3%.
The number is a pure function of the Chainlink proxy's own round history; Tremor submits no price.

This was **not** the projected outcome. The runbook expected `x ≈ 0.12–0.22`, having sized the cap off
Group 1's realized 2.1% — a reading now understood to be anomalously low, since Group 1's window produced
a single usable return. The runbook committed in advance to recording whatever the feed printed rather
than re-rolling, and that is what happened. It is the more complete evidence outcome: it exercises the
**cap-truncation limitation** the docs disclose, and forces **`burnWorthless`**, which Group 1 could never
demonstrate.

**SETTLE_HIGH (S8a).** `PortfolioSettled(2, buyer, high=true, 80e18, 80000000, newTotal=0)`, PMode 5,
one router `Swapped`. Payout `floor(80e18 × 1,000,000 / 1e18) = 80,000,000` — the full cap.

```
MockUSDC:   VAULT  → BUYER    80000000
HIGHrcpt:   BUYER  → ROUTER   80e18
HIGHrcpt:   ROUTER → VAULT    80e18
HIGHrcpt:   VAULT  → 0x0      80e18     ← burned
```

**CALM cannot settle (S8b) — SIMULATION.** `eth_call` at block 46696864 on PMode 6:
`ZeroPayout(2, 6)`, raw `0xef09fd4e…0002…0006`, selector verified with `cast sig`. No hash, ever.
Capture: [`evidence/s8-calm-zeropayout-simulation.txt`](evidence/s8-calm-zeropayout-simulation.txt).

**`burnWorthless` (S8c).** `WorthlessBurned(2, buyer, high=false, 100e18)`. Sent **to the market, not the
router** — **zero router `Swapped`, zero MockUSDC transfers**, one CALM transfer `BUYER → 0x0`. The
function requires `ppu == 0` and reverts `PayoutNotZero` otherwise, so it can never destroy a side that
still owes money.

### 4.7 Group 2 final state and full solvency ledger

**QUERY** `groupView(2)`: highOutstanding **0**, calmOutstanding **0**, `reserveLocked` **0**,
`exitBuffer` **0**, `standaloneCaps` **0**, finalized **true**, finalVariance 89,281,490,808,337,680,
xWad 1e18, highPpu 1,000,000, calmPpu 0. Vault balance **149,957,300**, `lockedQuote` **0**.
Both receipt supplies back to 900e18.

`lockedQuote <= balance` at every observed state, never breached:

| After | balance | locked | margin |
|---|---|---|---|
| S1 | 129,957,300 | 0 | 129,957,300 |
| S2 | 159,957,300 | 100,000,000 | 59,957,300 |
| S3 | 234,957,300 | 100,000,000 | 134,957,300 |
| S5 | 234,957,300 | 105,000,000 | 129,957,300 |
| S6 | 229,957,300 | 100,000,000 | 129,957,300 |
| S7b | 229,957,300 | 80,000,000 | 149,957,300 |
| S8a | 149,957,300 | **0** | 149,957,300 |
| S8c | 149,957,300 | **0** | 149,957,300 |

Economics close exactly: buyer paid 105,000,000 in premiums and received 85,000,000 (5,000,000 exit +
80,000,000 settlement), net **−20,000,000**; the writer's free collateral rose 129,957,300 → 149,957,300,
net **+20,000,000**. Zero-sum to the base unit.

## 5. Local evidence (not public-chain)

**LOCAL** — see [`FINAL_AUDIT.md`](FINAL_AUDIT.md) for the executed release-gate results, including the
Foundry suite, the Base-fork lifecycle tests, invariants, and the backend/web/subgraph gates. Local fork
runs exercise the full two-sided lifecycle including exits and the underfunded rejection; they are local
and are never presented as public-chain activity.

---

## 6. Source verification status

**Unresolved.** Contract sources are not verified on Basescan for the 84532 deployment. What exists in
its place is the reproducible-build check in §1.1, which is byte-level and independently re-runnable, but
it is **not** the same thing as explorer verification: a reader must run the script themselves rather than
clicking a green check on a block explorer.

`routerSourceCommit` remains `"unknown"` for the reason given in §1.1.

---

## 7. Indexing

- **Rust backend** indexes chain 84532 at schema 3 and reconciles field-for-field with `groupView(1)`.
  Portfolio checkpoints are **backend-only**. Endpoints: `/health`, `/pairs`, `/pairs/:id`,
  `/pairs/:id/events`, `/pairs/:id/checkpoints`.
- **The Graph**: the endpoint currently referenced by the web env
  (`https://api.studio.thegraph.com/query/1758209/tremor/v2`) is **live but stale** — it indexes a
  *previous, abandoned* 84532 deployment (its only vault is `0x5276bcc6…`, not the current
  `0x9C9341d0…`) and its schema has no portfolio entities at all. It must not be cited as evidence for
  anything in this document. See [`FINAL_AUDIT.md`](FINAL_AUDIT.md) for the remediation.

**The Graph does not index portfolio checkpoints.** Any claim otherwise is false.
