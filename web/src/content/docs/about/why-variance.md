Variance is the one volatility payoff that a smart contract can settle **without an oracle of opinion**. It is a sum of squared log returns over a fixed grid of timestamps, so given a price feed with history, the payoff is arithmetic — there is nothing left to model, quote or dispute.

## One number, from immutable history

```text
rᵢ = ln(Pᵢ / Pᵢ₋₁)                    Pᵢ = the Chainlink answer at tᵢ = start + i·Δ
RV = Σ rᵢ² · 31,536,000 / (expiry − start)
```

Every input is a Chainlink round that already exists on chain. Settlement reads that history; it does not ask anyone what the price *should* have been. Two people running the same window get the same number, forever.

An option, by contrast, needs a strike, a model, a spot at expiry and a volatility surface to price before expiry. Each of those is a place where someone's judgment enters, and every one of them is a place where a protocol has to trust something.

## Capped, because a vault has to be able to back it

Uncapped variance has unbounded downside for the writer: no amount of collateral is enough. Tremor pays

```text
payoutPerUnit = floor(unitNotional · min(RV, capVariance) / 1e18)
```

so one unit's worst case is a **known constant** fixed at creation. That single property is what makes full collateralization possible: the vault reserves `ceil(units · unitNotional · cap / 1e36)` the moment a unit sells, and that reservation is the whole liability. A buyer is not holding an unsecured claim on a writer's good behaviour — they are holding a claim on money that cannot leave.

The cost of the cap is honest and visible: above the cap the receipt stops tracking variance. Every screen states the cap in volatility terms, and the payoff chart flattens where it flattens.

## Why it fits Aqua

Aqua's makers are strategies, not order books. A capped variance receipt suits that model well:

- The payoff needs **no counterparty discovery** — the writer's vault is the maker on all three legs.
- The worst case is bounded, so the maker's obligation can be shipped as a real, reserved USDC balance instead of an allowance somebody might revoke.
- Pricing is a pure function of time, inventory and what the feed has printed, which is exactly what a SwapVM program can express through an `Extruction`.

## Why an LP should care

Loss-versus-rebalancing for a constant-product LP over a horizon `T` is approximately `V · σ² · T / 8` — a bill denominated in variance. Options hedge that badly (wrong shape, path-dependent) whereas a variance receipt pays the same quantity that causes the loss. Tremor's `/hedge` page sizes the units against that formula and then shows the **executable** cost of buying them.

It is not a perfect hedge, and we do not call it one: the cap truncates the tail, the premium is a real cost, expiries are discrete, and the LP's pool prices are not the Chainlink feed.

```cards
[{"href":"/docs/mechanics/market-quote","title":"How the market quotes","subtitle":"Skew, projection, and the executable band","icon":"σ²"},
 {"href":"/docs/mechanics/collateral","title":"Collateral and the vault","subtitle":"What full collateralization actually means here","icon":"$"},
 {"href":"/hedge","title":"LVR calculator","subtitle":"Size units against V·σ²·T/8 and price them","icon":"∫"}]
```
