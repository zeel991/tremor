Two jobs keep a series moving, and **anyone can do either one**. There is no keeper, no privileged address and no bot you have to trust.

| Job | When | Call |
|---|---|---|
| **Update the market** | Any time sample points have passed without being stored | `accumulator.checkpoint(id, maxSamples)` |
| **Finalize** | Once, after expiry, when every sample is stored | `accumulator.finalize(id)` |

Both live in the **Oracle** tab of the trade rail on any series page.

## Updating

```solidity
uint16 public constant MAX_SAMPLES_PER_CALL = 32;
function checkpoint(uint256 seriesId, uint16 maxSamples) external returns (uint256 stored, uint256 available);
```

Each call reads up to `min(maxSamples, 32)` new sample points from the Chainlink round history, adds their squared log returns to the accumulator, and advances a resumable cursor. Calling it on a market that is already current is a no-op rather than a revert.

The app shows `stored / available / total` and how many calls are needed. Press the button repeatedly, or let several people press it — the cursor makes partial progress free to resume, and two callers cannot double-count a sample.

**Why you might care even if you hold nothing:** a market that is behind cannot quote. Both ISSUE and EXIT require the realized term to be current, because the projection blends it with the forward variance. If you want to buy or exit, updating is the prerequisite.

Measured on a Base fork: one bounded 8-sample call over real Chainlink history costs **513,002 gas**; a live forward window's single-sample catch-up costs **192,773**.

## Finalizing

```solidity
function finalize(uint256 seriesId) external returns (uint256 finalVariance);
```

Requires `now ≥ expiry` and a complete window. It annualizes the accumulated sum, writes `finalVariance` and `payoutPerUnit`, and calls back into the controller, which reprices the writer's reservation from the cap down to the real liability and releases the difference on the spot.

It costs **159,192 gas** on the fork, runs exactly once, and unlocks redemption for every holder.

## Who ends up doing it

Everybody who wants something:

- Holders, because redemption needs finalization.
- Traders, because quoting needs currency.
- Writers, because the cap surplus comes back at finalization.

Nobody is paid for it. That is a deliberate trade: an unpaid job that many parties want done is more robust than a paid job that depends on one party showing up.

## What can go wrong

| Error | Meaning |
|---|---|
| `NotExpired` | `finalize` before `expiry` |
| `IncompleteWindow` | Samples are still missing — checkpoint first |
| `AlreadyFinalized` | Somebody already did it. The payout is fixed |
| `WindowPredatesFeed` | The window starts before the feed's first round; the series cannot be settled and should never have been created |

The first three are ordinary sequencing, and the app orders the buttons so you meet them rarely. The last is a creation-time mistake, and the controller's validation is what keeps it from happening.
