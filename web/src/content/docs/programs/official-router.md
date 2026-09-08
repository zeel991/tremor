Tremor v1 shipped four custom SwapVM opcodes in the unallocated `0xd0..0xef` bank. That meant Tremor had to deploy **its own router** to execute them, which is a strange thing to build on a shared-liquidity layer: every Tremor program was unrunnable on the official one.

v2 has **no custom opcodes**. Every program is three stock instructions, all of Tremor's logic lives behind the built-in `Extruction` (`0x04`) and a maker hook, and the programs run on the unmodified official `AquaSwapVMRouter`.

## The compatibility gate

`contracts/test/RouterCompat.t.sol` is the evidence, and it ran **before** any production order encoding depended on the claim. Nothing in it is a Tremor contract: the maker is a bare EOA, pricing comes from a mock `ExtructionEcho`, and the hook target is a mock `HookProbe`. The gate measures the router, not Tremor.

### Gate 1 — the router deployed at the canonical address

Observed on a Base mainnet fork at block 51,021,219, the canonical SwapVM address `0x111111338c5091E8440b67B168bAe16a668AC0De`:

- **holds a SwapVM router** that points at canonical Aqua, `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a`;
- **hashes Aqua-mode orders identically** to the pinned source — `router.hash(order) == keccak256(abi.encode(order)) ==` the Aqua strategy hash;
- **does not expose the pinned swap ABI**: neither `quote((address,uint256,bytes),uint256,bytes)` (`0xb7ebf0c5`) nor `swap(...)` (`0xa69f95bd`) is dispatchable, so the deployed bytecode is a different SwapVM revision than the submodule this repository pins and cannot be driven through `ISwapVM`.

The test asserts that **observation**, not a wish. If a future Base state does expose the pinned ABI, the test turns red and forces the decision to be revisited rather than silently going stale.

### Gate 2 — the unmodified official source

The documented fallback for exactly that case is to deploy the official `AquaSwapVMRouter` from the pinned `lib/swap-vm` submodule, unmodified, and repeat the gate against it. That test proves the two facts v2 depends on:

1. `Extruction` (`0x04`) calls out to an arbitrary target and lets it fix the swap registers.
2. A maker `postTransferIn` hook fires with the amounts the router actually moved.

Both pass. That is the router Tremor deploys and the router every Tremor program runs on.

## Why this matters

The claim v2 makes is **custom SwapVM programs and external pricing logic**, not custom opcodes. Concretely:

| | v1 | v2 |
|---|---|---|
| Opcodes | 4 custom (`0xd0`–`0xd3`) | none |
| Router | Tremor's fork | official `AquaSwapVMRouter`, unmodified |
| Where pricing lives | inside the router | behind `Extruction`, in `TremorMarketEngine` |
| Runs on the official router | no | yes |
| Upstream files modified | none | none |

The `TREMOR_OPCODES` table in `web/src/lib/program.ts` is deliberately empty, and the program viewer on each series page shows you the real thing: stock opcodes all the way down, with one `Extruction` whose target is Tremor's engine.
