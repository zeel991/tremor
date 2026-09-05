## What exactly does a receipt pay?

`floor(unitNotional · min(RV, capVariance) / 1e18)` USDC per unit, where `RV` is the annualized realized variance of ETH/USD over `[start, expiry]`, computed on chain from Chainlink rounds. `1e18` variance is 100% annualized vol.

## Why variance and not vol?

Variance is additive over time and linear in squared returns, so it can be summed from samples with no square roots inside the sum and no model at all. The UI shows vol (`√variance`) because it is the number people think in; the contract pays variance.

## Who holds the collateral?

The writer's own vault — a `TremorMakerVault` at a deterministic address with no admin, no upgrade path and no rescue function. Every unit sold reserves its capped payout there, and the vault reverts any withdrawal that would touch a reservation. The writer cannot revoke the vault's Aqua allowance either: it is set once in the constructor and there is no setter.

## Can the writer default on a sold receipt?

No. That is the central change from v1. The collateral for every sold unit is reserved in the vault at the cap, and the only thing that releases a reservation is the receipt being burned — on exit or on redemption. A writer can stop selling, but they cannot take back what backs what they already sold.

## So can I get my money out before expiry?

Yes — that is the EXIT leg. Sell your receipts back to the market at its executable bid, any time before expiry. The receipts are burned and the writer's collateral is released in the same transaction. See [Exit before expiry](/docs/guides/exit).

## What do I approve, and to whom?

Buyers and holders approve the **router** — USDC to buy, receipts to exit or redeem. Writers approve their **vault** (for the deposit) and nothing else, ever. The vault's approvals to Aqua are made by code the writer does not control. See [Contract ABI notes](/docs/reference/abi).

## Does someone have to run a bot?

No, but somebody has to press a button. The observation window is walked forward in bounded permissionless `checkpoint` calls and the payout is fixed by a permissionless `finalize`. Anyone can call either; nobody is paid to. It works because everyone who wants anything from the series — redemption, a quote, the cap surplus — needs it done. See [Checkpoints and finalization](/docs/mechanics/checkpoints).

## Why can't I trade right now?

Because the market is behind. Both buying and exiting require every passed sample point to be stored, since the market's projection blends realized variance with forward variance. A stale realized term would let someone price off a window the market has not looked at. The Oracle tab fixes it in one transaction, from any wallet.

## What is "market vol", if it isn't implied vol?

It is one market's quote, expressed as a volatility. There is no option surface anywhere in Tremor. The writer picks an anchor; the quote moves with inventory, decays back on a half-life, and blends into what has actually been realized as the window progresses. It is executable and it is not a fair value.

## Can I split a buy to pay less?

No. Fills are priced at the integral of the marginal price across the size, so `n` small fills cost the same as one fill of the same total — and where integer rounding differs, it differs against the splitter. Tested against 60-digit reference vectors on both the contract and the frontend replica.

## What happens at `saleEnd`? At `expiry`?

At `saleEnd` the ISSUE program's `Deadline` fails: no more receipts can be bought, and the market becomes bid-only. At `expiry` the EXIT program's `Deadline` fails too, and finalization becomes possible. SETTLE has no deadline at all — a holder who redeems years late still redeems.

## What if a series finalizes at zero?

`payoutPerUnit` is zero, and SwapVM refuses a swap with zero output, so the SETTLE leg cannot pay you. `factory.burnWorthless(id, units)` exists for exactly that case: it burns the receipts and releases the writer's reservation. The app switches the button from Redeem to Burn on its own.

## What if the window crosses a Chainlink phase change?

The round search is phase-aware: the highest phase whose first round is at or before the sample time, then the largest round in that phase with `updatedAt ≤ tᵢ`. A round "does not exist" when `getRoundData` reverts **or** returns `updatedAt == 0`; both occur on Base depending on aggregator generation, and both are handled and tested. The accumulator's cursor stores its phase, so a window that crosses a boundary resumes correctly across bounded calls.

## Did you fork the 1inch router?

No. v1 did — it shipped four custom opcodes, which required Tremor's own router. v2 has no custom opcodes: every program is `Salt`, `Deadline` and the stock `Extruction`, and it runs on the unmodified official `AquaSwapVMRouter`. `contracts/test/RouterCompat.t.sol` is the evidence, and it ran before any production encoding depended on it.

## Is anything upgradeable or admin-controlled?

No. No admin keys, no proxies, no keeper, no pause, no oracle override, no emergency custodian. Everything needed to verify a series is in the three program byte strings, the contracts' immutables, and the feed's own history.

## How do I hedge LVR with it?

`E[LVR] ≈ V · σ² · T / 8`; buy `(V · T / 8) / unitNotional` units. The `/hedge` page does the arithmetic and quotes the executable cost per open series. It is a coarse gross sizing, not a replication — see the caveats in [Hedge LVR](/docs/guides/hedge-lvr).
