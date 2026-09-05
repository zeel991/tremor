The observation window is walked forward by **bounded, permissionless checkpoints**, and the payout is fixed by a **permissionless finalization**. No keeper, no privileged address, and no single caller who pays for the whole window.

## Why the accumulator exists

v1 computed the entire window inside the first settlement. On a Base fork a 5-day window at 2-hour sampling — 61 samples — cost the first redeemer ≈3.6 M gas while every later redeemer paid ≈0.17 M. The first person to want their money subsidised everyone else, and a long window could price itself out of settling at all.

v2 stores progress instead:

```solidity
uint16 public constant MAX_SAMPLES_PER_CALL = 32;

function checkpoint(uint256 seriesId, uint16 maxSamples) external returns (uint256 stored, uint256 available);
function finalize(uint256 seriesId) external returns (uint256 finalVariance);
```

`checkpoint` reads at most `min(maxSamples, 32)` new samples, adds their squared log returns to the accumulator, and advances a resumable cursor into the Chainlink round history. Calling it when the window is already current is an idempotent no-op, not a revert — so a UI can offer the button without having to predict whether it is needed.

## Progress and currency

```solidity
function progress(uint256 id) returns (uint256 stored, uint256 available, uint256 total);
function isCurrent(uint256 id) returns (bool);
```

- `total` — sample points in the whole window, `(expiry − start)/Δ + 1`.
- `available` — sample points whose timestamp has passed.
- `stored` — sample points actually accumulated.
- `isCurrent` — `stored == available`.

**A market cannot quote while it is behind.** Both ISSUE and EXIT require `isCurrent`, because the projection blends realized variance with forward variance, and a stale realized term would let a trader price off a window the market has not looked at yet. When a series is behind, the series page says how many samples are missing and the ticket offers the update.

The cursor makes catching up cheap: sample 0 is a full phase-aware search, and each subsequent sample gallops forward from the round the previous one landed on. Resuming a partially-walked window costs the same as never having stopped.

## Finalization

```text
requires block.timestamp >= expiry
requires stored == total          (the whole window is accumulated)
```

`finalize` annualizes the accumulated sum, writes `finalVariance`, computes

```text
payoutPerUnit = floor(unitNotional · min(finalVariance, cap) / 1e18)
```

and calls back into the controller, which reprices the writer's reservation from the cap down to the real liability and releases the difference. See [Collateral and the vault](/docs/mechanics/collateral#finalization-reprices-the-liability).

Anyone can call it, exactly once. It is the same transaction for a holder who wants to redeem, a writer who wants their surplus back, and a bystander.

## Incentives, honestly

Nobody is paid to checkpoint. It works because everybody who wants anything from the series needs it done:

- A **holder** cannot redeem until the window is finalized.
- A **trader** cannot buy or exit while the market is behind.
- A **writer** cannot get their cap surplus back until finalization.

The cost is bounded and splittable across as many callers and transactions as anyone likes. What the design deliberately avoids is a trusted keeper whose absence breaks settlement.

## Measured gas, Base fork

Against the real Chainlink ETH/USD proxy on a Base mainnet fork (`contracts/test/ForkE2E.t.sol`), a 5-day window at 2-hour sampling — 61 sample points — walked in **8 bounded calls of 8 samples each**:

| Step | Gas |
|---|---|
| One bounded checkpoint call, 8 samples of real history | 513,002 |
| Whole 61-sample window, all 8 calls | 4,104,019 |
| `finalize` | 159,192 |
| One redemption after finalization | 296,021 |
| One bounded checkpoint on a live forward window | 192,773 |

Total gas across the window is not lower than v1's monolithic settlement — it is a little higher. What changed is who pays and whether the transaction fits: no single caller carries the whole window, every call has a hard upper bound, and a long window cannot price itself out of settling.

Note the per-sample cost is dominated by the phase-aware round search, which is why the write flow's sampling ladder targets at most 84 samples.

```cards
[{"href":"/docs/guides/oracle","title":"Update and finalize","subtitle":"How to do both from the app, and what each costs","icon":"⟳"},
 {"href":"/docs/mechanics/realized-variance","title":"Realized variance","subtitle":"The grid, the phase-aware search and annualization","icon":"σ²"}]
```
