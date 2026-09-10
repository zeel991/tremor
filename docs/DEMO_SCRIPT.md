# Demo video script (target 3:30)

The through-line: **v1's receipts were promises; v2's are claims on money that cannot leave.** Everything
in the demo either shows that, or shows a writer failing to break it.

0:00  Cold open on the landing tiles: "ETH realized vol, last 7 days: XX%. That number is now a market —
      with a bid and an ask."

0:20  The claim, in one sentence: capped ETH variance receipts as Aqua positions, priced by a SwapVM
      program on the **official, unmodified** router, fully collateralized in a vault the writer cannot
      raid, settled from Chainlink's own round history. Show the three program byte strings and the
      program viewer: `Salt`, `Deadline`, `Extruction` — stock opcodes all the way down.

0:45  WRITE. `/write`: three decisions, thirteen parameters derived, one transaction. Point at the ticket:
      "opens 5.18 / 5.40 USDC" — a bid and an ask, both executable, before a single unit has traded.
      Then the sentence that matters: "the collateral goes into a vault only I own, and the moment
      somebody buys, the part backing their unit stops being mine to withdraw."

1:15  BUY. `/series/[id]`: buyer 1 takes 20 units; the ask ticks up and *so does the bid*. Buyer 2 takes
      10 at the higher ask. Show the vault card: locked went from 0 to exactly `units × 100 USDC` at the
      cap. "The quote is state in the program, not a bot. And the backing is arithmetic, not a promise."

1:45  THE ATTACKS. This is the segment v1 could not film. On the fork, as the writer:
      withdraw the reserved collateral → `ExceedsFree(7854428834, 5208727555)`.
      revoke the vault's Aqua allowance → there is no function to call.
      transfer the unsold inventory out → controller-only.
      dock the SETTLE leg while claims exist → reverts.
      "Four things a v1 seller could do. None of them exist any more."

2:15  EXIT. Buyer 1 sells 8 units back at the executable bid, before expiry. Show three things in one
      transaction: USDC out, receipt supply down by exactly 8 units, and the vault's `locked` down by
      exactly 8 × 100 USDC. "That is why the exit and the redemption can share one balance: whichever one
      you use, the receipt burns and the obligation disappears with it."

2:45  THE ORACLE, and who pays for it. Back-dated series, expiry an hour ago. Press **Update the market**
      from a wallet that owns nothing — 8 bounded calls, 513k gas each, walking real Chainlink rounds.
      Then **Finalize**: the payout fixes at 23.975111 USDC per unit and 760.25 USDC of cap surplus goes
      back to the writer on the spot. "No keeper. Anyone can do this, and everyone who wants anything
      from the series needs it done."

3:05  REDEEM. One click: USDC out equal to the Lens quote to the base unit, receipts burned.
      "quote == swap, because history does not change."

3:20  LVR. `/hedge`: pool value 1M, 7 days, trailing vol → expected LVR → units, priced by the on-chain
      integral for that exact size. "The loss LPs complain about is σ². This pays σ². Below the cap it
      tracks the bill by construction — and at the cap it under-pays, which is why we call it a sizing
      tool and not a hedge."

3:30  Close: three stock SwapVM instructions, zero upstream lines modified, canonical Aqua on Base, and a
      writer who cannot take back what they sold. Repo link.

---

## What to have ready before recording

```bash
make dev            # fork + deploy + seed + API + web; stage C prints every attack reverting
```

`scripts/dev.sh` leaves the whole lifecycle seeded: series 1 is a live forward market with 30 units sold
and 8 exited, series 2 is a back-dated series already finalized, redeemed and closed. Re-running with
`--fresh` reproduces both from a clean fork.

For the attack segment, `contracts/script/demo.sh` stage C already simulates each one and prints the
revert reason; running the same calls live with `cast call` gives the on-screen error selectors.
