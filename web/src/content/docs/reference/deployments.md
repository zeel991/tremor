Addresses come from `contracts/deployments/<chainId>.json`, written by `Deploy.s.sol` and copied to `web/src/config/deployment.json` by `script/sync-deployment.sh <chainId>`.

```json
{ "schemaVersion": 2, "chainId": 31337,
  "aqua": "0x…", "weth": "0x…", "usdc": "0x…", "feed": "0x…",
  "router": "0x…", "routerSourceCommit": "…", "routerBytecodeHash": "0x…",
  "seriesFactory": "0x…", "marketEngine": "0x…", "accumulator": "0x…",
  "seriesDeployer": "0x…", "programs": "0x…", "lens": "0x…", "oracle": "0x…",
  "deploymentBlock": 51021223, "writer": "0x…", "buyer": "0x…" }
```

The manifest is **versioned**. The backend rejects `schemaVersion` other than 2 at startup rather than mis-decoding a v1 manifest, and it also refuses zero addresses. `routerSourceCommit` and `routerBytecodeHash` pin exactly which official `AquaSwapVMRouter` source this deployment runs — see [Running on the official router](/docs/programs/official-router).

## This build — {{chainName}} ({{chainId}}), {{deployed}}

| Contract | Address |
|---|---|
| Aqua | `{{aqua}}` |
| AquaSwapVMRouter | `{{router}}` |
| VarianceSeriesFactory | `{{seriesFactory}}` |
| TremorMarketEngine | `{{marketEngine}}` |
| VarianceAccumulator | `{{accumulator}}` |
| TremorSeriesDeployer | `{{seriesDeployer}}` |
| TremorPrograms | `{{programs}}` |
| TremorLens | `{{lens}}` |
| RealizedVarianceOracle | `{{oracle}}` |
| USDC | `{{usdc}}` |
| Chainlink ETH/USD | `{{feed}}` |
| WETH | `{{weth}}` |
| Demo writer | `{{writer}}` |
| Demo buyer | `{{buyer}}` |
| Deployment block | `{{deploymentBlock}}` |
| Router source commit | `{{routerSourceCommit}}` |
| Router bytecode hash | `{{routerBytecodeHash}}` |
| Manifest schema | `{{schemaVersion}}` |

Env for this build: `NEXT_PUBLIC_RPC_URL={{rpcUrl}}`, `NEXT_PUBLIC_API_URL={{apiUrl}}`.

## Chains

| Chain | Id | Aqua | USDC | Chainlink ETH/USD |
|---|---|---|---|---|
| Tremor Fork (anvil fork of Base mainnet) | `31337` | canonical `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` | real `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 dec) | real `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` (8 dec) |
| Base Sepolia | `84532` | our own Aqua deployment | `MockUSDC` | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` |
| Base | `8453` | canonical `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` | real USDC | real ETH/USD |

Note the router. Tremor deploys the **official `AquaSwapVMRouter` source, unmodified**, rather than using the router deployed at the canonical SwapVM address, because that address exposes a different SwapVM revision's swap ABI. The compatibility gate documents the observation and the fallback.

## Reference fork deployment (`deployments/31337.json`, deploymentBlock 51021223)

A fresh `demo.sh` run on a fresh fork reproduces the same addresses when deployed from the same account and nonce.

| | |
|---|---|
| aqua (canonical) | `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a` |
| weth | `0x4200000000000000000000000000000000000006` |
| usdc (real) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| feed (real ETH/USD) | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` |
| router (official source) | `0x1B83b466d739cb84B131B21CF66e598C9c01971e` |
| seriesFactory | `0x43AfB5635F840c1b0D4D68b10CE9CE272a354523` |
| marketEngine | `0xE37eC1884ce6b498C69B63d6911646006Dd226da` |
| accumulator | `0x740af24813F255C2ce72649bE15A2DEcb4eEDC8a` |
| seriesDeployer | `0x669D2dfb6Da3F834f46c10f9c91DddD5fE517d85` |
| programs | `0x1BcA8cF5c9c60559c10535851Df022E35513F2B9` |
| lens | `0x19613E7614086c162C75fB53D5911F8FE936E2e5` |
| oracle | `0x856C170B1188e5C36C49cF1EE4073173E41d02b4` |
| writer (anvil #0) | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| buyer (anvil #1) | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |

Writer vaults and receipts are **not** in the manifest, because they do not need to be: a vault address is `CREATE2` from `keccak256(writer, quoteToken)` and `lens.writerVault(writer)` returns it whether or not it exists yet.

## Build settings and sizes

Solidity `0.8.30`, via-IR, optimizer **200 runs** — size-tuned, because the controller embeds its children's creation code and therefore has to fit EIP-3860's 49,152-byte initcode limit as well as EIP-170's 24,576-byte runtime limit.

| Contract | Runtime | Initcode | Runtime margin |
|---|---:|---:|---:|
| AquaSwapVMRouter (official) | 20,052 | 21,540 | 4,524 |
| VarianceSeriesFactory | 17,892 | 46,484 | 6,684 |
| TremorLens | 15,184 | 16,364 | 9,392 |
| TremorSeriesDeployer | 11,236 | 11,574 | 13,340 |
| TremorMarketEngine | 8,612 | 8,868 | 15,964 |
| TremorPrograms | 7,607 | 8,057 | 16,969 |
| VarianceAccumulator | 6,858 | 7,163 | 17,718 |
| RealizedVarianceOracle | 5,562 | 5,781 | 19,014 |
| TremorMakerVault | 3,652 | 4,408 | 20,924 |
| VarianceReceipt | 2,981 | 5,218 | 21,595 |

The binding constraint is the controller's **initcode**: 46,484 of 49,152, a margin of 2,668 bytes. That is why the read models live in separate contracts (`TremorLens`, `TremorPrograms`) rather than on the controller itself.

```cards
[{"href":"/docs/reference/abi","title":"Contract ABI notes","subtitle":"Who approves whom, taker data, Lens field order","icon":"ABI"},
 {"href":"/docs/programs/official-router","title":"The official router","subtitle":"What the compatibility gate observed","icon":"0x"},
 {"href":"/docs/guides/run-locally","title":"Run locally","subtitle":"Fork, demo, backend, web","icon":"⌘"}]
```
