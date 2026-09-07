# Tremor — one-command dev flow. See README.md.
BASE_RPC_URL ?= https://mainnet.base.org
.PHONY: dev anvil contracts test demo sync backend web subgraph-install subgraph-codegen subgraph-build subgraph-configure sim sim-check all
dev:              ## bring up the whole stack: chain + contracts + API + web
	./scripts/dev.sh
anvil:            ## fork Base mainnet locally (canonical Aqua, real USDC, real Chainlink)
	anvil --fork-url $(BASE_RPC_URL) --chain-id 31337 --auto-impersonate --port 8545
contracts:        ## build contracts
	cd contracts && forge build
test:             ## run the Foundry suite (fork test needs BASE_RPC_URL)
	cd contracts && BASE_RPC_URL=$(BASE_RPC_URL) forge test -vv
demo:             ## deploy to the running anvil fork and run all demo stages
	cd contracts && ./script/demo.sh && ./script/sync-deployment.sh 31337 && ./script/export-abi.sh
backend:          ## run the Rust API on :8787
	cd backend && RPC_URL=http://127.0.0.1:8545 DEPLOYMENT_JSON=../contracts/deployments/31337.json cargo run --release
web:              ## run the Next.js app on :3000
	cd web && npm run dev -- --port 3000
subgraph-install: ## install The Graph CLI and graph-ts dependencies
	cd subgraph && npm install
subgraph-codegen: ## generate AssemblyScript types from the Tremor subgraph schema
	cd subgraph && npm run codegen
subgraph-build:    ## compile the Tremor subgraph to WebAssembly
	cd subgraph && npm run build
subgraph-configure: ## configure the subgraph from a Base Sepolia deployment manifest
	cd subgraph && node scripts/configure.mjs 84532
sim-check:        ## pin the simulation's pricing replica against the Solidity reference vectors
	cd sim && npm run check
sim:              ## run the ten economic scenarios and rewrite sim/out/report.md + findings.md
	cd sim && npm run check && npm run sim
