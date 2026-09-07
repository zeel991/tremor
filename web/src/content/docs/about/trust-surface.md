What follows is the complete list of things that have to hold for a Tremor receipt to pay, and the complete list of things a writer can still do to you. We would rather state both than let a green badge imply more than it means.

## What settlement depends on

| Dependency | What breaks if it fails |
|---|---|
| Chainlink ETH/USD keeps its round history readable | The window cannot be checkpointed or finalized, so nothing can be redeemed |
| Somebody calls `checkpoint` and `finalize` | The payout is not fixed. Anyone can call both, and both are cheap and bounded — but they are not automatic |
| Aqua can still pull from the vault | The vault's allowance to Aqua is set once in the constructor and can never be reduced, so this fails only if Aqua itself changes |
| USDC transfers work | Redemption pays USDC |

There is no keeper, no admin, no multisig, no upgrade proxy and no privileged address anywhere in the settlement path.

## What a writer cannot do

Each of these is enforced by the vault or the controller and is covered by a test in `contracts/test/Adversarial.t.sol`:

- **Cannot withdraw reserved collateral.** `withdrawFree` reverts above `balance − locked`, and every mutation re-asserts solvency.
- **Cannot revoke the Aqua allowance.** The vault approves Aqua once, in its constructor, and exposes no setter.
- **Cannot move unsold inventory.** Receipt inventory is held by the vault and only the controller can move or burn it.
- **Cannot dock the legs that pay holders out.** Docking EXIT or SETTLE while claims are outstanding reverts.
- **Cannot re-price a sold unit.** A fill's price is fixed at fill time; later quotes do not reach back.
- **Cannot self-settle to drain the vault.** A redemption is bounded by the liability the burn releases, so a writer buying and redeeming their own receipts is a round trip, not a withdrawal.

## What a writer can still do

- **Stop issuance at any time.** This closes new sales for good. Exit and redemption are unaffected — that is the point of separating the legs.
- **Choose the parameters.** The anchor, the spread, the cap and the impact are the writer's decisions. A market quoted at 90% vol against 40% realized is a bad deal, not a bug; the series page shows both numbers side by side so you can see it.
- **Close a series with nothing outstanding.** This docks the strategies, burns the unsold inventory and frees the residual collateral. It reverts while any receipt exists.

## What we do not claim

- **Not an order book.** There is one maker per series: the writer's vault. There is no matching, no queue, no depth beyond the vault's inventory and reserve.
- **Not a conventional variance swap.** A conventional variance swap is an uncapped bilateral agreement with a variance strike and no token. This is a capped, transferable, prepaid receipt.
- **Not a fair-value oracle.** The bid and the ask are one market's quote. They are executable, which is a stronger claim than "indicative" and a much weaker claim than "fair".
- **Not implied volatility.** Nothing here is derived from an option surface. The chart's dashed line is labelled *market quote volatility* because that is exactly what it is.
- **Not a perfect LVR hedge.** See [Why variance](/docs/about/why-variance#why-an-lp-should-care).
- **Never an executable exit price from a UI estimate.** Where the app shows a value that is not a live on-chain quote, it says so, and the trade ticket always re-quotes on chain before it lets you sign.

## Residual risks worth naming

- **Feed gaps.** If Chainlink prints no round between two sample times, the earlier price repeats and that sample contributes a zero return, which biases realized variance downward. The 30-minute floor on the sampling grid exists because a finer grid made this common on Base.
- **Cap truncation.** A violent window can realize far above the cap. Holders get the cap.
- **Backend staleness.** Charts and fill history come from an indexer that is minutes behind by construction. Every executable number on a ticket is read from the chain instead.
- **Exit depth is finite.** An exit fills at most up to the point where the falling bid reaches zero, and its proceeds are additionally clamped by the collateral that burn releases and by the leg's Aqua balance. A very large holder gets a partial fill and a worse average than the top-of-book bid — which is what "executable" means, and why the ticket re-quotes the whole size on chain before you sign.
