# Group 2 — mined transaction evidence

Base Sepolia, chain **84532**. Every row was read back from its mined receipt, not from expectation.
Explorer prefix: `https://sepolia.basescan.org/tx/`

Group 2 parameters (read back with `groupParams(2)`): window `1789159992 → 1789161792` (1800 s),
`sampleInterval` 600, `capVariance` 4e15, `capPayoutPerUnit` 1,000,000, `maxUnitsPerSide` 1000e18,
quotes HIGH 300000/250000 and CALM 750000/700000.

- HIGH receipt `0xA897ea80673Fc7908285bFDAfB03254407814067`
- CALM receipt `0xFEB46811d84Db9b3B249B724a31dD175CfC72cBE`
- Writer `0x975D862A1f01a292EDf11b12cC809dffaC35997A` · Buyer `0xbaAe28c72177Bc3814dd0961b9aA09fddB56B752`
- Vault `0x9C9341d0E752a97BD1c7c47FB1579866daBCc47C`

## Transactions

| # | Step | Tx | Block | From → To | Gas |
|---|---|---|---|---|---|
| S1 | `createGroup` | [`0xacafa07c…6592e`](https://sepolia.basescan.org/tx/0xacafa07c2bf194d03635db529873b47b46828dd44a49caa00f0fc04661f6592e) | 46695855 | writer → PortfolioMarket | 2,983,897 |
| S2 | ISSUE_HIGH 100 | [`0xa52ff9eb…36912`](https://sepolia.basescan.org/tx/0xa52ff9eb71434b3e5b2500fc4c2f05ee8de07eaabda6f4d8560fbd4c88c36912) | 46696178 | buyer → **Router** | 235,141 |
| S3 | ISSUE_CALM 100 | [`0x36d20156…8ae17`](https://sepolia.basescan.org/tx/0x36d201560c8db096c42feea38f9612bcb53bb855131e42c79c4321b5ea78ae17) | 46696287 | buyer → **Router** | 191,988 |
| S4 | underfunded EXIT | **NO TRANSACTION — `eth_call` simulation, never broadcast** (block 46696315) | — | — | — |
| S5 | `allocateExitBuffer(2, 5000000)` | [`0xdf4f5b90…960a4`](https://sepolia.basescan.org/tx/0xdf4f5b90f945595ac2dc2ceea134f2a59322efa1e251927218bccf77b5b960a4) | 46696359 | writer → PortfolioMarket | 68,098 |
| S6 | EXIT_HIGH 20 | [`0x322802e8…91d89`](https://sepolia.basescan.org/tx/0x322802e8c5a18468c9a82aa1895d1c0090c0a28cbc404506bbac095bac591d89) | 46696441 | buyer → **Router** | 175,980 |

All six mined transactions returned `status: 0x1`. S2, S3 and S6 were sent **to the router**
`0xb8dcED3Cf6266Dd8fEc05849fce3734B79A7e722` and each emitted exactly one router `Swapped`.

## S1 — group creation

`GroupCreated(2, writer, vault, 0xA897ea80…, 0xFEB46811…, params)` — **1** event, plus **exactly 6
`StrategyShipped`** on the vault (one per `(side, leg)`: ISSUE/EXIT/SETTLE × HIGH/CALM) and the seeding
`Checkpointed`. The six shipped hashes are each checked against the locally computed order hash inside
`_create`, which reverts `ShippedHashMismatch` on any mismatch.

## S2 — ISSUE_HIGH 100 units

Decoded `PortfolioIssued(groupId=2, actor=buyer, high=true, units=100e18, premium=30000000,
highOutstanding=100e18, calmOutstanding=0, reserve=100000000)`. Order mode **PMode 1 = ISSUE_HIGH**.

Token flow — note the taker's input transits the router, the maker's output does not:

```
HIGHrcpt:   VAULT  → BUYER    100000000000000000000
MockUSDC:   BUYER  → ROUTER   30000000
MockUSDC:   ROUTER → VAULT    30000000
```

Premium is exactly `ceil(100e18 × 300000 / 1e18) = 30,000,000`.

| State | before | after |
|---|---|---|
| vault balance | 129,957,300 | **159,957,300** |
| `lockedQuote` | 0 | **100,000,000** |
| free | 129,957,300 | 59,957,300 |
| `reserveLocked` / `standaloneCaps` | 0 / 0 | 100,000,000 / 100,000,000 |

With one side outstanding the shared reserve and the standalone figure are identical. That is the
**baseline** for the next row.

## S3 — ISSUE_CALM 100 units — the shared-reserve proof

Decoded `PortfolioIssued(groupId=2, actor=buyer, high=false, units=100e18, premium=75000000,
highOutstanding=100e18, calmOutstanding=100e18, reserve=100000000)`. Order mode **PMode 2 = ISSUE_CALM**.

```
CALMrcpt:   VAULT  → BUYER    100000000000000000000
MockUSDC:   BUYER  → ROUTER   75000000
MockUSDC:   ROUTER → VAULT    75000000
```

| State | before | after |
|---|---|---|
| highOutstanding | 100e18 | 100e18 |
| calmOutstanding | 0 | **100e18** |
| **`reserveLocked`** | 100,000,000 | **100,000,000 — unchanged** |
| **`standaloneCaps`** | 100,000,000 | **200,000,000** |
| `lockedQuote` | 100,000,000 | **100,000,000 — unchanged** |
| vault balance | 159,957,300 | 234,957,300 |

**The vault took on a second full-cap obligation and locked nothing additional.** Two independently
backed single-sided series would have locked 200,000,000; this group locks 100,000,000 — a saving of
**100,000,000 (50%) for this book at this composition**. `reserveLocked` and `standaloneCaps` are both
read directly off `groupView(2)`; neither is computed off-chain.

This is a property of *this* book at *this* composition, not a universal 50% saving.

## S4 — underfunded EXIT — SIMULATION ONLY, NEVER MINED

`eth_call` at block **46696315**, `--from` buyer, target router, order mode **PMode 3 = EXIT_HIGH**,
order hash `0x2223fa7006624419870f3da2677e3ecc76dc182196cfa7c8b719396d210d71f1`, amount 20e18 exact-in.

```
execution reverted: ExitUnderfunded(2, 5000000, 0)
raw: 0x8c7ebfde
     0000000000000000000000000000000000000000000000000000000000000002
     00000000000000000000000000000000000000000000000000000000004c4b40
     0000000000000000000000000000000000000000000000000000000000000000
```

Selector `0x8c7ebfde` verified against `cast sig "ExitUnderfunded(uint256,uint256,uint256)"`.
Needed 5,000,000; available 0.

**There is no transaction hash for this and there never can be — a reverting transaction cannot be
mined.** Full capture with reproduction commands: `s4-exit-underfunded-simulation.txt`.

Why it must fail: burning 20 HIGH moves the reserve from `max(100,100)` to `max(80,100)` — CALM still
sets it, so the burn releases **exactly zero**. With an empty buffer there is nothing to pay from, and
paying out of the reserve would strand CALM holders. This is the cost side of the same `max(h,c)`
property that makes the shared reserve efficient.

## S5 — exit-buffer allocation

`ExitBufferFunded(2, writer, 5000000, 5000000)` plus the vault's `LockedIncreased(5000000, 105000000)`.

**ERC-20 Transfer events in this transaction: 0.** That absence is the evidence — the buffer came from
the writer's *existing free vault collateral*, not from a wallet top-up. (`allocateExitBuffer` is
writer-only and moves no tokens; the permissionless `fundExitBuffer` would have transferred.)

| State | before | after |
|---|---|---|
| `exitBuffer` | 0 | **5,000,000** |
| `lockedQuote` | 100,000,000 | **105,000,000** |
| free | 134,957,300 | 129,957,300 |
| vault balance | 234,957,300 | **234,957,300 — unchanged** |

## S6 — funded EXIT_HIGH 20 units

Decoded `PortfolioExited(groupId=2, holder=buyer, high=true, units=20e18, amountOut=5000000,
released=0, draw=5000000, newReserve=100000000)`. Order mode **PMode 3 = EXIT_HIGH**, same order hash
as the S4 simulation.

```
MockUSDC:   VAULT  → BUYER    5000000
HIGHrcpt:   BUYER  → ROUTER   20000000000000000000
HIGHrcpt:   ROUTER → VAULT    20000000000000000000
HIGHrcpt:   VAULT  → 0x0      20000000000000000000    ← burned
```

**`released = 0` and `draw = 5,000,000`**: the payout was drawn entirely from the exit buffer and did
not touch the settlement reserve by a single unit. The receipt is burned, and that burn is the only
mechanism in the protocol that releases a reservation.

| State | before | after |
|---|---|---|
| highOutstanding | 100e18 | **80e18** |
| calmOutstanding | 100e18 | 100e18 |
| `reserveLocked` | 100,000,000 | **100,000,000** (CALM still sets it) |
| `exitBuffer` | 5,000,000 | **0** |
| `standaloneCaps` | 200,000,000 | 180,000,000 |
| vault balance | 234,957,300 | **229,957,300** |
| `lockedQuote` | 105,000,000 | **100,000,000** |
| HIGH totalSupply | 1000e18 | **980e18** |

Proceeds are exactly `floor(20e18 × 250000 / 1e18) = 5,000,000`.

## Solvency ledger across the trading phase

`lockedQuote <= vault balance` held at every observed state:

| After | balance | locked | margin |
|---|---|---|---|
| S1 | 129,957,300 | 0 | 129,957,300 |
| S2 | 159,957,300 | 100,000,000 | 59,957,300 |
| S3 | 234,957,300 | 100,000,000 | 134,957,300 |
| S5 | 234,957,300 | 105,000,000 | 129,957,300 |
| S6 | 229,957,300 | 100,000,000 | 129,957,300 |

## Backend reconciliation

`GET http://localhost:8789/pairs/2` returned all four lifecycle events with matching values —
`issued/high 100e18 @ 30,000,000`, `issued/calm 100e18 @ 75,000,000`, `buffer_funded 5,000,000`,
`exited/high 20e18 @ 5,000,000` — plus the seeding checkpoint, with `indexer_error: null`.

## Remaining steps

Checkpointing, finalization and settlement follow after expiry `1789161792`. This file is updated with
their mined results; until then no claim is made about final payouts.

---

# Settlement phase (after expiry 1789161792)

| # | Step | Tx | Block | From → To | Gas |
|---|---|---|---|---|---|
| S7a | `checkpoint(2, 8)` | [`0xf107df40…a0f293`](https://sepolia.basescan.org/tx/0xf107df40f790c9b45b94fa54b72ad0e5a867692b7e07ce55f43a9c1e08a0f293) | 46696776 | writer → accumulator | 128,366 |
| S7b | `finalize(2)` | [`0xed2ac4d8…477bf6`](https://sepolia.basescan.org/tx/0xed2ac4d86f73d1f3875c0623235e9d6e7be785a080988d2904faa1b648477bf6) | 46696797 | writer → accumulator | 167,832 |
| S8a | SETTLE_HIGH 80 | [`0xe3845a36…8141c4`](https://sepolia.basescan.org/tx/0xe3845a368cb73d7535d6b6ea30bd37ff91db1f2f47c8d08d8e5280758e8141c4) | 46696892 | buyer → **Router** | 171,928 |
| S8b | CALM cannot settle | **NO TRANSACTION — `eth_call` simulation** (block 46696864) | — | — | — |
| S8c | `burnWorthless(2,false,100e18)` | [`0xac4ac42f…d33a1c`](https://sepolia.basescan.org/tx/0xac4ac42f47846666a0030c42fb9bd17820b5d8ec374913dd8d83f80dc2d33a1c) | 46696944 | buyer → **Market** (not the router) | 44,358 |

## S7a — checkpoint

`Checkpointed(2, fromSample=1, toSample=3, processedThrough=1789161792, lastRoundId=18446744073709831418,
sumSquaredReturns=5095975502759)`. One bounded call covered the three remaining samples (budget 8).
Sample 0 was seeded by `createGroup`, so the window `1789159992 → 1789161792` at 600 s produced 4 sample
points and 3 returns.

## S7b — finalization from Chainlink round history

`GroupFinalized(2, finalVariance, xWad, highPpu, calmPpu, released)`:

| Field | Value |
|---|---|
| `finalVariance` | **89,281,490,808,337,680** (≈ 8.93e16) |
| `capVariance` | 4,000,000,000,000,000 (4e15) |
| `xWad` | **1,000,000,000,000,000,000 — x = 1.0, the cap truncated** |
| `highPpu` | **1,000,000** (the full cap) |
| `calmPpu` | **0** |
| released | 20,000,000 |

`highPpu + calmPpu = 1,000,000 = capPayoutPerUnit`, complementarity preserved at the boundary.

Realized variance ran **≈22× the cap** — about **29.9% annualized volatility** against a cap set at
6.3%. No price was submitted by Tremor: the number is a pure function of the Chainlink ETH/USD proxy's
own round history, per `RealizedVariance.sol`.

**This was not the predicted outcome and the record should say so.** The runbook projected
`x ≈ 0.12–0.22`, having calibrated `capVariance` off Group 1's realized 2.1% annualized. That reading
was anomalously low — Group 1's window produced a single usable return and caught almost no movement.
Group 2's three returns caught real ETH movement. The runbook committed in advance to recording whatever
the feed printed rather than re-rolling the group, and that is what happened.

It is the more complete evidence outcome: it exercises the **cap truncation** limitation that the
documentation discloses, and it forces **`burnWorthless`**, which Group 1 could never demonstrate because
both its payouts were positive.

Vault at finalization: `LockedDecreased(20000000, 80000000)` — `reserveLocked` 100,000,000 → 80,000,000,
exactly `80e18 × 1,000,000 / 1e18` for the remaining HIGH, with CALM contributing zero liability.

## S8a — SETTLE_HIGH 80 units through the router

`PortfolioSettled(2, buyer, high=true, units=80e18, amountOut=80000000, newTotal=0)`, order mode
**PMode 5 = SETTLE_HIGH**, order hash `0x1c0e1cf653b41e3ea8505dd52ec7ba303499b697ce7d30a453f9aee0a934d548`,
one router `Swapped`.

```
MockUSDC:   VAULT  → BUYER    80000000
HIGHrcpt:   BUYER  → ROUTER   80000000000000000000
HIGHrcpt:   ROUTER → VAULT    80000000000000000000
HIGHrcpt:   VAULT  → 0x0      80000000000000000000    ← burned
```

Payout is exactly `floor(80e18 × 1,000,000 / 1e18) = 80,000,000` — the full cap, since x clamped to 1.

| State | before | after |
|---|---|---|
| highOutstanding | 80e18 | **0** |
| `reserveLocked` | 80,000,000 | **0** |
| vault balance | 229,957,300 | **149,957,300** |
| `lockedQuote` | 80,000,000 | **0** |
| HIGH totalSupply | 980e18 | **900e18** |

## S8b — CALM cannot settle — SIMULATION ONLY

`eth_call` on `router.quote`, block 46696864, order mode **PMode 6 = SETTLE_CALM**, order hash
`0x9424a267165fe7a35ee816b2dab5d770f6b4bb01ff17eae72458131f468de259`, 100e18 exact-in:

```
execution reverted: ZeroPayout(2, 6)
raw: 0xef09fd4e …0002 …0006
```

Selector `0xef09fd4e` verified against `cast sig "ZeroPayout(uint256,uint8)"`. `_priceSettle` requires
`ppu > 0`; a zero-output swap is not a meaningful fill and SwapVM is not asked to route one. No hash —
this is an `eth_call`. Capture: `s8-calm-zeropayout-simulation.txt`.

## S8c — burnWorthless removes the zero side

`WorthlessBurned(2, buyer, high=false, units=100e18)`.

Sent **to the market, not the router** — no Aqua, no SwapVM, no payout:

```
CALMrcpt:   BUYER → 0x0    100000000000000000000
```

**Zero router `Swapped` events and zero MockUSDC transfers in the whole transaction.** `burnWorthless`
itself requires `ppu == 0` and reverts `PayoutNotZero` otherwise, so it can never destroy a side that
still owes money.

| State | before | after |
|---|---|---|
| calmOutstanding | 100e18 | **0** |
| buyer CALM balance | 100e18 | **0** |
| CALM totalSupply | 1000e18 | **900e18** |

## Final state — Group 2 closed

`groupView(2)`: highOutstanding **0**, calmOutstanding **0**, `reserveLocked` **0**, `exitBuffer` **0**,
`standaloneCaps` **0**, finalized **true**, finalVariance 89,281,490,808,337,680, xWad 1e18,
highPpu 1,000,000, calmPpu 0.

Vault: balance **149,957,300**, `lockedQuote` **0**, `freeQuote` **149,957,300**.

### Full solvency ledger — `lockedQuote <= balance` at every observed state

| After | balance | locked | margin |
|---|---|---|---|
| S1 createGroup | 129,957,300 | 0 | 129,957,300 |
| S2 ISSUE_HIGH | 159,957,300 | 100,000,000 | 59,957,300 |
| S3 ISSUE_CALM | 234,957,300 | 100,000,000 | 134,957,300 |
| S5 allocateExitBuffer | 234,957,300 | 105,000,000 | 129,957,300 |
| S6 EXIT_HIGH | 229,957,300 | 100,000,000 | 129,957,300 |
| S7b finalize | 229,957,300 | 80,000,000 | 149,957,300 |
| S8a SETTLE_HIGH | 149,957,300 | **0** | 149,957,300 |
| S8c burnWorthless | 149,957,300 | **0** | 149,957,300 |

Never negative, never breached. Every unit sold was backed from sale to burn.

### Economics close to the base unit

Buyer paid 30,000,000 + 75,000,000 = **105,000,000** in premiums and received 5,000,000 (exit) +
80,000,000 (settlement) = **85,000,000**, net **−20,000,000**.
Writer's free collateral went 129,957,300 → 149,957,300, net **+20,000,000**.
Zero-sum, exactly.
