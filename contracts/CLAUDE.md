# contracts/ — agent notes
Read `CONTRACTS.md` (file map, program layouts, deviations, gas) before editing.
- Build/test: `forge build --sizes`, `forge test` (171 tests). `ForkE2E` and `RouterCompat` need `BASE_RPC_URL`.
- Remappings in `remappings.txt`; `lib/swap-vm` (submodule, needs `yarn install` inside) and `lib/solady`.
- **There are no custom opcodes.** Pricing goes behind the stock `Extruction` (0x04) in `TremorMarketEngine`,
  which is what lets the programs run on the unmodified official `AquaSwapVMRouter`. Do not add an opcode
  bank back; `test/RouterCompat.t.sol` is the evidence for the claim and must keep passing.
- `TremorOrderBuilder` is the ONLY encoding path. `router.hash(order) == keccak256(abi.encode(order)) ==`
  the Aqua strategy hash must hold for all three legs.
- Engine changes: validate the order hash against `(seriesId, leg)`, check `maker == vault` and the token
  direction, guard recompute, and write storage only when `!isStaticContext`.
- Any pricing change → update `tools/reference/pricing_reference.py`, regenerate
  `test/vectors/pricing_vectors.json` (keep `n_cases` in sync), then re-run BOTH replicas:
  `cd ../sim && npm run check` and `cd ../web && npm test`.
- Size budget: the controller embeds its children's creation code, so **EIP-3860 initcode (49,152)** binds
  before EIP-170. Margin is 2,668 bytes. Read models belong in `TremorLens` / `TremorPrograms`, not here.
- `script/demo.sh` is the acceptance test; it must end with `DEMO COMPLETE ✓`, and stage C must show every
  writer attack reverting.
