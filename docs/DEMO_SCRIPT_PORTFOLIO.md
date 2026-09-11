# Portfolio demo script (v3 HIGH/CALM) — three minutes

Status: the on-chain flow below is executable as both an end-to-end staged script (`contracts/script/demo.sh` stages P1–P6) and via the live web app (`/pairs`, `/pairs/1`, `/pairs/2`, `/pairs/new`). All frontend surfaces referenced in [brackets] (vault card, portfolio reserve bar, exit buffer controls, live fills/history event feed) are fully integrated and verified against the running fork. Nothing here is broadcast to a public chain without explicit authorization.

Amounts are chosen so the mechanism is visible: $100 of backing, $1 cap per unit, 100-unit positions.
Do not overfund — the point of stage 4 is that the buyback genuinely has nothing to draw on.

## Beats

1. **Fund a protected account** (0:00–0:20)
   Writer deposits 100 USDC into their `TremorMakerVault` — no admin, no rescue, unrevokable Aqua
   allowance — and creates one risk group: ETH realized variance over one shared window, cap 100% vol,
   HIGH pays `$1·x`, CALM pays `$1·(1−x)` where `x = min(realizedVariance/cap, 1)`.
   [Vault card: balance $100, locked $0.]

2. **Sell HIGH — reservation appears** (0:20–0:45)
   Buyer A buys 100 HIGH through the official SwapVM router for $30. The taker's $30 USDC premium pays
   directly into the writer's vault. The vault locks $100 — the full cap of the sold claims.
   [Portfolio card: reserve $100, standalone caps $100, vault balance $130, free cash $30.]

3. **Sell CALM — the punchline** (0:45–1:20)
   Buyer B buys 100 CALM for $75. That $75 premium pays directly into the vault. **The reserve does not move.**
   HIGH's and CALM's maxima cannot occur at the same outcome; the shared reserve is `max(h,c)·$1 = $100`, where
   two separately backed series would lock $200.
   [Portfolio card: reserve $100, standalone caps $200, vault balance $205, free cash $105.] Say precisely:
   this is the worst-case of THIS book, not a universal 50% saving. Note that free cash is unreserved balance;
   it is not automatically allocated as an exit buffer.

4. **The unsafe exit, rejected** (1:20–1:50)
   Writer withdraws the free $105 (allowed — it is not backing). Buyer A asks to sell back 20 HIGH for
   $5. The transaction reverts `ExitUnderfunded(needed $5, available $0)`: burning the smaller-or-equal
   side releases zero reserve, and paying from the $100 would strand CALM holders. Frame it as the
   mechanism working, not a broken button. (On the recording this revert is shown as a simulation /
   failed transaction — a revert cannot be broadcast.)

5. **Fund the buyback, execute it** (1:50–2:15)
   Writer deposits $5 and locks it as the group's exit buffer. The same exit now executes: buyer A gets
   $5, the buffer is consumed, the reserve is still $100 (max(80,100)). State the disclosed trade-off:
   exit liquidity is separate from settlement backing, and the writer may withdraw unused buffer, so an
   exit quote can disappear — settlement backing cannot.

6. **Finalize once, redeem everything** (2:15–2:50)
   To demonstrate the complete settlement lifecycle without waiting for a 7-day live series expiry,
   the walkthrough executes against a fresh backdated risk group (created over real historical Chainlink
   rounds, e.g. Stage P6 / Group 2).
   A third account — neither writer nor buyer — walks the observation window in bounded permissionless
   checkpoints and finalizes. ONE finalization fixes both payouts, summing to exactly $1 per complete
   set. Both buyers redeem through the router without the writer's cooperation; total payout ≤ $100;
   the writer withdraws whatever remains.

7. **Close** (2:50–3:00)
   Final balances on screen: every claim paid from the shared reserve, the vault exactly solvent at
   every step, all six programs stock `Salt`/`Deadline`/`Extruction` on the unmodified official router.

## Claims discipline

Say: enforceable shared backing for complementary capped claims; executable capacity-aware fills;
quote == swap. Do not say: risk-free, guaranteed win, universal 50% savings, invented complementary
claims, fair-value volatility oracle, or protection beyond the tested cases.
