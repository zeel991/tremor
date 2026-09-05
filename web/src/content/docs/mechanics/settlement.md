A receipt leaves circulation in exactly one of two ways, and both burn it.

| Path | When | Price | Leg |
|---|---|---|---|
| **Exit** | Before expiry, while the market is current | The executable bid | EXIT |
| **Redemption** | After finalization | The final realized variance | SETTLE |

Both are `receipt → USDC` swaps that pull from the same real balance — the writer's vault — through separate virtual Aqua allocations. The receipt's router-only `postTransferIn` hook burns every unit that arrives, so supply falls exactly with redemption and a receipt can never be recycled for a second payout.

## The payoff

```text
RVc           = min(finalVariance, capVariance)
payoutPerUnit = floor(unitNotional · RVc / 1e18)          USDC (6 dec) per 1e18 units
proceeds(u)   = floor(u · payoutPerUnit / 1e18)
```

`payoutPerUnit` is written once, by `finalize`, and never changes. Before finalization it does not exist, and the app says "not yet fixed" rather than showing an estimate dressed as a price.

The most one unit can ever pay is `maxPayoutPerUnit = floor(unitNotional · cap / 1e18)`, which is fixed at creation and is exactly what the writer's vault reserves per unit sold.

## Exit

Exit is priced by the market, not by the payoff. It is the integral of the falling bid over the size being sold — see [The two-sided quote](/docs/mechanics/market-quote#integral-fill-pricing) — and it is clamped by four things:

```text
units    <= units actually outstanding
units     <= units to zero bid
amountOut <= collateral this burn releases
amountOut <= the leg's Aqua balance
```

The third clamp is what makes one shared balance safe behind two virtual allocations. A payout can never draw more than the obligation that disappears in the same transaction.

Exit closes at `expiry` — the EXIT program carries a `Deadline`. Between `saleEnd` and `expiry` a market has no ask and only a bid, which is deliberate: nobody should be able to enter after most of the variance has already printed.

## Redemption

SETTLE deliberately has **no deadline**. A holder who redeems years late still redeems.

```text
exact-in:   amountOut = floor(amountIn · payoutPerUnit / 1e18)
exact-out:  unsupported — SETTLE is exact-in only
```

`amountOut` is clamped to the leg's Aqua balance and to the liability the burn releases. Rounding is maker-favouring throughout, which here costs the holder at most one base unit of USDC.

## The worthless case

A series that finalizes at zero realized variance has `payoutPerUnit == 0`. SwapVM refuses a swap with `amountOut == 0`, so those receipts cannot be redeemed through the router at all. The controller exposes `burnWorthless(id, units)` for exactly that case: the holder burns their receipts, the writer's reservation is released, and nobody is left holding a token that can only revert. The app switches the ticket's action from **Redeem** to **Burn** automatically when it detects the state.

## Measured on a Base fork

A 5-day backdated window against real Chainlink history, finalized and redeemed (`contracts/test/ForkE2E.t.sol`):

```text
final realized variance   0.239751118934944514  (48.96% annualized vol)
payout per unit           23.975111 USDC
finalize                  159,192 gas
one redemption            296,021 gas
collateral released at finalization   760.248890 USDC
```

## What we do not show

Before finalization the Lens can compute the payout implied by the variance realized *so far*. Tremor does not present that as an exit price. It excludes the remaining window, the premium, the spread and the depth of the bid. Where the app shows an exit value it uses the **executable bid**, quoted on chain, and where it shows a redemption value it uses the **fixed** `payoutPerUnit`. It never blends them.
