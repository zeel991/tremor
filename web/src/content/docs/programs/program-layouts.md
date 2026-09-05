`TremorOrderBuilder` is the **only** encoding path in Tremor. The bytes the vault ships to Aqua and the order a taker hands the router both come from it, so

```text
router.hash(order) == keccak256(abi.encode(order)) == aqua strategyHash
```

holds by construction for all three legs, on the official router.

## The three programs

```text
ISSUE   Salt(id,1) · Deadline(saleEnd) · Extruction(engine, [1,1,id])
EXIT    Salt(id,2) · Deadline(expiry)  · Extruction(engine, [1,2,id])
SETTLE  Salt(id,3) ·                     Extruction(engine, [1,3,id])
```

Three stock instructions, nothing else:

| Opcode | Instruction | Role |
|---|---|---|
| `0x02` | `Salt` | `abi.encodePacked(uint64 seriesId, uint8 leg)` — makes each leg's order hash unique, and makes the leg part of the identity |
| `0x20` | `Deadline` | ISSUE dies at `saleEnd`; EXIT dies at `expiry`. SETTLE has none, deliberately: a holder who redeems years late still redeems |
| `0x04` | `Extruction` | Calls `TremorMarketEngine` with the 10 immutable argument bytes and lets it fix the swap registers |

The engine's arguments are `[version:1][mode:1][seriesId:8]`. See [TremorMarketEngine](/docs/programs/market-engine).

## MakerTraits

```text
maker                     the writer's vault
receiver                  address(0) → defaults to the maker (Aqua requires it)
tokenA / tokenB           sorted ascending
useAquaInsteadOfSignature true
allowZeroAmountIn         false
hasPostTransferInHook     EXIT and SETTLE only, target = the series' receipt
every other hook          unset
```

Tokens are sorted, so the traits' direction flag says nothing about which way the leg runs. **Direction is enforced inside the engine by token address**, per leg, which is why an ISSUE order cannot be swapped backwards into a free exit.

## The burn hook

EXIT and SETTLE carry a `postTransferIn` hook targeting the series' `VarianceReceipt`. When receipts arrive at the maker, the receipt contract:

```text
requires msg.sender == ROUTER
requires tokenIn == address(this)
requires maker == VAULT
requires feeIn == 0
burns amountIn
calls controller.onBurn(orderHash, taker, amountIn, amountOut)
```

`onBurn` is the single place in the system where a liability decreases. It validates the leg from the order hash and requires `amountOut <= released`, which is the invariant that lets both burn legs draw on one real balance.

ISSUE has no hook. Receipts leaving the vault are ordinary Aqua pushes.

## Ship plan

`createSeries` ships all three strategies in one transaction, through the vault, and asserts that Aqua returned each pinned hash:

| Leg | Receipt amount | USDC amount |
|---|---|---|
| ISSUE | `maxUnits` | 0 |
| EXIT | 0 | `maxSeriesLiability` |
| SETTLE | 0 | `maxSeriesLiability` |

Both USDC amounts are Aqua **virtual** balances against the vault's one real balance — see [Collateral and the vault](/docs/mechanics/collateral#one-reserve-two-burn-paths).

`TremorPrograms` exposes the whole thing read-only: `orders(id)`, `order(id, leg)`, `shipPlan(id)` and `program(id, leg)`. The series page's program viewer decodes those bytes live, in the browser, and shows you the instruction list with the `Extruction` target resolved.

## Hash identity

The leg is part of the salt, so the three hashes differ even though the tokens and the maker do not. The controller stores all three and reverses them: given an order hash it knows the series and the leg, which is what both the engine and `onBurn` check before they will price or release anything.
