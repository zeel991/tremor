# Simulation findings

What the ten scenarios in `out/report.md` actually showed, and what each one implies.

## F1 — the accounting is solvent, at every step, in every scenario

No invariant failed. The vault's balance never fell below its locked collateral, no series' liability exceeded the full-cap reservation for its outstanding units, finalization never released more than had been locked, and every scenario ended with every claim extinguished, no liability remaining, and the closing balance equal to deposits plus premiums minus payouts to the base unit.

That last equality is the one worth dwelling on: it means no scenario found a path where money left the vault without a corresponding obligation disappearing, which is the property that lets EXIT and SETTLE share one balance.

## F2 — the writer's loss is bounded by the cap, and only by the cap

1 of 10 scenarios finished at or above the cap. The worst case across all of them is **−28,283.97 USDC** on 40,000.00 of collateral (high realized variance, at the cap), and that number is not approximately the floor — it *is* the floor: premium taken (11,716.02) minus the full capped payout on a sold-out inventory (40,000.00) is −28,283.97.

So the loss is exactly the short-variance exposure the writer sold, bounded by the cap they chose and reserved in full at creation. There is no leverage, no liquidation, no margin call, and no shortfall for anybody else to absorb — the money to pay it was locked before the position existed.

## F3 — the spread and the impact are the compensation, and they are small

7 scenarios were profitable for the writer and 3 were not. Where realized variance landed near the quote, the writer kept roughly the half-spread and the inventory impact — which is a thin margin, and correctly so: a two-sided market that charged more for standing on both sides would simply not get traded against.

## F4 — full-cap reservation makes capital expensive while the window is open

Mean utilization across the scenarios runs 5–96% of the vault's balance. A unit sold at a 40%-vol quote against a 100%-vol cap reserves roughly six times the premium it collected, because until the window is finalized the cap is the only bound that is knowable.

Finalization is what fixes it, and it fixes it immediately: repricing the liability from the cap to the real payout returns the surplus the moment the variance is known, without waiting for a single holder to redeem. The scenarios' 'released at finalization' column is that refund.

The design consequence is real and worth stating plainly: a writer choosing a high cap buys buyers more upside and pays for it in locked capital, at roughly `cap / quote` times the premium. That trade-off is the writer's to make, and `/write` shows both sides of it before they sign.

## F5 — the projection converges, which is what closes the late-entry hole

In the early-spike and late-spike scenarios the quote moves substantially over the window even with an unchanged anchor, because the projection weights measured variance by elapsed time. By expiry the projection equals the realized number exactly. A buyer arriving late is therefore quoted off what has already happened, not off the writer's opening opinion — and the sale window closes long before that, so they cannot arrive at all.

## F6 — exits clamp instead of failing

10 scenarios produced clamped fills (low-realized: 1, near-quote: 1, at-cap: 1, early-spike: 1, late-spike: 1, heavy-issuance: 1, heavy-early-exits: 1, alternating-flow: 1, issuance-stopped: 1, shared-vault: 1). Every one of them re-priced the size that actually filled rather than reverting, which is why the heavy-issuance and heavy-exit scenarios still complete. The clamps that bind are inventory, the cap, the vault's free collateral, the zero-bid point and the liability a burn releases — never a raw balance check that would have failed the transaction.

## F7 — the LVR hedge is a sizing tool, not a replication

Below the cap the receipt's payout and the V·σ²·T/8 estimate agree to within integer rounding — which is an identity of the sizing rule, not evidence of a good hedge: the same σ² cancels from both sides. What that leaves is the premium, and the premium is a real cost the LP pays whether or not variance shows up. The best residual across the scenarios is −92.87 USDC (low realized variance, well below the market's quote), and it is negative.

Where the cap bites the identity breaks in the wrong direction. 1 of 10 scenarios finished above the cap; in that one the payoff stops rising exactly where the LVR bill is largest, so the LP keeps both the premium and the excess. An instrument that under-pays in the tail is a sizing tool, not a hedge, and that is the language the app uses.

## What the simulation cannot tell you

It cannot prove a revert. Every claim about what a writer *cannot* do is tested against the real contracts (`contracts/test/Adversarial.t.sol`, `contracts/test/Invariants.t.sol`) and demonstrated on a Base fork (`contracts/script/demo.sh` stage C). This file is about the economics of the paths where everyone behaves.

