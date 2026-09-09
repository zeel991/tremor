# ABI drop zone

Placeholders (`{ "abi": [] }`) are checked in so the app builds before the contracts exist.
`src/lib/contracts.ts` uses a JSON ABI when its `abi` array is non-empty (both the Foundry
artifact shape `{ abi: [...] }` and a bare `[...]` array are accepted) and otherwise falls back
to the human-readable ABI fragments from ARCHITECTURE.md §3.1 / §2.2.

Refresh from the contracts build:

```
cd contracts && forge build
for c in TremorLens VarianceSeriesFactory TremorRouter VarianceReceipt; do
  forge inspect $c abi --json > ../web/src/abi/$c.json
done
cp out/Aqua.sol/Aqua.json ../web/src/abi/Aqua.json   # or forge inspect Aqua abi --json
```
