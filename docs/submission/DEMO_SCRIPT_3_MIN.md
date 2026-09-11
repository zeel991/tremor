# Three-minute demo script — 1inch Aqua / SwapVM track

**Group 2 is mined.** Every beat below is now backed by a real Base Sepolia transaction, except the
underfunded exit, which is and always will be a simulation. The hashes are in
[`evidence/group2-transactions.md`](evidence/group2-transactions.md) — open them in tabs before recording.

### The labelling rule, non-negotiable

Every frame is one of these, and the words must match:

| Kind | Say | Never say |
|---|---|---|
| Mined on Base Sepolia | "this transaction on Base Sepolia", show the hash | — |
| Live contract read | "reading the contract right now" | "the transaction shows" |
| Local fork / test | "in our test suite", "on a local fork" | "on chain", "deployed" |
| `eth_call` simulation | "simulated — a revert can't be broadcast" | "this transaction failed" (implies mined) |

The quote token is **Tremor MockUSDC**, freely mintable. Say "test USDC" or "MockUSDC" out loud at least
once. Never "USDC" unqualified, and never imply Circle.

---

## 0:00–0:20 — The problem

> "If you want exposure to how violently ETH moves — not which way — your options are an options
> surface you have to model, or a variance swap you can't get as a retail participant.
>
> And when someone does write you that exposure on chain, the usual backing is a wallet allowance. The
> writer can revoke it the moment it's about to cost them. That's not collateral. That's a promise with a
> cancel button."

Show: the landing page. Keep it moving — this is the shortest beat.

## 0:20–0:45 — What Tremor is

> "Tremor splits one number — ETH's realized variance over a window — into two complementary claims.
> HIGH pays more as variance rises. CALM pays the complement. Per unit they always sum to exactly the
> cap, one test-USDC here.
>
> Both are backed by a maker vault with no admin, no upgrade path, no rescue function, and no way for the
> writer to revoke the allowance that pays holders out."

Show: `/pairs/2`, both sides side by side, the payoff chart.

## 0:45–1:20 — Aqua and SwapVM

> "Every leg runs on 1inch Aqua through the official, unmodified AquaSwapVMRouter. Creating one risk
> group ships six SwapVM strategies into Aqua in a single transaction — issue, exit and settle, for each
> side.
>
> Three stock instructions: Salt, Deadline, Extruction. There are no custom opcodes and no forked router.
> All of Tremor's pricing lives behind the Extruction target."

Show, in this order:
1. Group 2's creation tx [`0xacafa07c…`](https://sepolia.basescan.org/tx/0xacafa07c2bf194d03635db529873b47b46828dd44a49caa00f0fc04661f6592e)
   (block 46695855) — point at the **six `StrategyShipped` events**.
2. The ISSUE_HIGH tx [`0xa52ff9eb…`](https://sepolia.basescan.org/tx/0xa52ff9eb71434b3e5b2500fc4c2f05ee8de07eaabda6f4d8560fbd4c88c36912)
   (block 46696178) — specifically its **`to` field: the router** `0xb8dcED3C…`, and the single `Swapped`.
3. Optional, 3 seconds: deployed router bytecode reproduces the vendored official source byte-for-byte
   outside immutables.

> "This is a real mined transaction. The buyer approved the router, the router pulled the premium into
> the vault, and the vault released receipts through Aqua."

## 1:20–1:45 — The shared reserve (the punchline)

> "Here's the part that matters. A hundred HIGH sold: the vault locks a hundred test-USDC, the full cap.
> Now a hundred CALM sells — and watch the reserve."

Show: the CALM tx [`0x36d20156…`](https://sepolia.basescan.org/tx/0x36d201560c8db096c42feea38f9612bcb53bb855131e42c79c4321b5ea78ae17)
(block 46696287), then `groupView(2)` live on `/pairs/2`.

> "It doesn't move. A hundred HIGH and a hundred CALM are both outstanding, and the reserve is still
> exactly one hundred — `reserveLocked` one hundred million base units, `standaloneCaps` two hundred
> million. HIGH's worst case and CALM's worst case cannot happen at the same outcome, so the group
> reserves the larger side, not the sum. Two separately backed series would lock two hundred. The
> contract reports both numbers itself."

Say this exactly — it is the difference between a true claim and an overclaim:

> "That's a fifty percent reduction **for this book at this composition**. It is not a universal
> fifty percent."

## 1:45–2:10 — EXIT: blocked, then funded

> "The buyer wants out of twenty HIGH. It reverts."

Show: the captured revert `ExitUnderfunded(2, 5000000, 0)` — raw data and selector `0x8c7ebfde` in
`evidence/s4-exit-underfunded-simulation.txt`, or re-run the `eth_call` live in a terminal.

> "**This is a simulation, not a failed transaction — a revert can't be broadcast.** And it's the
> mechanism working, not a broken button: burning the smaller-or-equal side releases zero reserve, so
> paying this exit out of the reserve would strand CALM holders.
>
> The writer allocates five test-USDC of free collateral as an exit buffer — settlement backing is
> untouchable, buyback liquidity is separate and explicitly funded. Now the same exit executes through
> the router."

Show: the buffer tx [`0xdf4f5b90…`](https://sepolia.basescan.org/tx/0xdf4f5b90f945595ac2dc2ceea134f2a59322efa1e251927218bccf77b5b960a4)
(block 46696359 — point out it has **zero token transfers**, so the buffer came from the writer's own free
collateral), then the **mined EXIT** [`0x322802e8…`](https://sepolia.basescan.org/tx/0x322802e8c5a18468c9a82aa1895d1c0090c0a28cbc404506bbac095bac591d89)
(block 46696441), pointing at `released = 0` and `draw = 5000000` — the payout came entirely from the
buffer — and the receipt trail ending in a burn to `0x0`.

> "Disclose the trade-off: the writer can withdraw unused buffer, so an exit quote can disappear.
> Settlement backing cannot."

## 2:10–2:35 — Chainlink settlement

> "Nobody submits a price. The window is walked forward in bounded, permissionless checkpoints straight
> from the Chainlink ETH/USD feed's own round history, then finalized permissionlessly."

Show: the checkpoint transactions and `GroupFinalized`.

> "Realized variance came out at [actual]. Normalized against the cap that's x = [actual], so HIGH pays
> [actual] per unit and CALM pays [actual]. They sum to exactly one million base units — the cap — by
> construction, because CALM is defined as the integer complement, not rounded independently."

Fill the bracketed numbers from the mined result. Do not pre-write them.

## 2:35–2:50 — Settlement and the vault returning to zero

> "Both sides redeem through the router's SETTLE leg. The receipts burn, and burning is the only thing
> that releases a reservation."

Show: both `PortfolioSettled` transactions, then the vault: `lockedQuote` back to **0**.

> "Liabilities at zero. Every unit that was ever sold was backed from the moment it sold until the moment
> it was burned."

If one side finalized at exactly zero payout, say instead: "CALM settled worthless, so it can't go
through SETTLE — it's removed with `burnWorthless`, which only accepts a side whose payout is exactly
zero." Only say this if it actually happened.

## 2:50–3:00 — Close

Show: the address table and the test totals.

> "Live on Base Sepolia. 216 tests across 20 suites, including stateful invariants and two Base-fork
> lifecycle runs against the real Chainlink feed.
>
> **Tremor turns realized volatility into fully backed, capital-efficient claims that execute through
> Aqua and settle from verifiable Chainlink history.**"

---

## Pre-recording checklist

- [ ] Group 2 mined; every hash in the script is real and open in a tab
- [ ] Recording against the **public** frontend URL, not localhost
- [ ] MockUSDC said aloud at least once; no unqualified "USDC"
- [ ] The word "simulated" said on the underfunded-exit beat
- [ ] "for this book" said on the shared-reserve beat
- [ ] No Graph claim on screen unless the v3 subgraph is republished and queryable
- [ ] Bracketed numbers replaced with mined values
- [ ] Under 3:00

## If Group 2 has not run

Do not fake it. Record a version that is honest about the boundary:

> "Issuance and settlement are mined on Base Sepolia — here are the transactions. The two-sided
> reserve, the exit buffer and the exit path run in our Base-fork test suite; here they are executing
> there, against the real router and the real Chainlink feed."

Then show the fork test output, clearly framed as a test run. A judge will respect a clean boundary far
more than a blurred one.
