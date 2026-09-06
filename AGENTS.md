# Tremor — agent guide

You are working on Tremor: a **two-sided market in capped ETH realized-variance receipts** on 1inch
Aqua and SwapVM. ETHGlobal ETHOnline 2026 entry, 1inch "Build an Aqua App" track. Read this file first,
then `ARCHITECTURE.md` (binding spec), `DESIGN.md` (binding visual system), `contracts/CONTRACTS.md`
(what was actually built, plus deviations) and `docs/TASKS.md` (open work). Do not re-derive decisions
those files already make.

## What it is, in one paragraph

A writer funds a `TremorMakerVault` — one per writer, deterministic address, no admin, no upgrade path.
`VarianceSeriesFactory.createSeries` mints the receipt inventory into that vault and ships three
strategies to canonical Aqua in one transaction: ISSUE (USDC → receipts), EXIT (receipts → USDC before
expiry) and SETTLE (receipts → USDC at the final variance). All three are stock SwapVM programs —
`Salt`, `Deadline`, `Extruction` — running on the **unmodified official `AquaSwapVMRouter`**, with all
pricing behind the `Extruction` target `TremorMarketEngine`. Every unit sold reserves its capped payout
in the vault; the reservation is released only when the receipt is burned, which both burn legs do
through the receipt's router-only maker hook. The observation window is walked forward in bounded
permissionless checkpoints and finalized permissionlessly. Quote equals swap by construction.

## Repository map

```
contracts/   Foundry. src/VarianceSeriesFactory.sol (controller), TremorMarketEngine, TremorMakerVault,
             VarianceAccumulator, TremorSeriesDeployer, TremorLens, TremorPrograms, RealizedVarianceOracle,
             tokens/VarianceReceipt, libs/{SeriesParams,VariancePricing,RealizedVariance,TremorOrderBuilder}.
             src/portfolio/ is the v3 portfolio market (HIGH/CALM risk groups, shared max(h,c) reserve,
             exit buffer) — see ARCHITECTURE §2A and CONTRACTS.md "Portfolio markets".
             test/ (171 tests across 14 suites, incl. stateful invariants and a Base-fork E2E),
             test/vectors/pricing_vectors.json (60 cases at 60 digits, from tools/reference/pricing_reference.py),
             script/ (Deploy, DemoFlow, demo.sh, sync-deployment.sh, export-abi.sh).
             lib/swap-vm and lib/solady are submodules; swap-vm needs `yarn install` inside it.
backend/     Rust, axum, alloy, sqlx/SQLite. Three-leg indexer + Chainlink round cache + realized-variance
             and market-quote replicas + vault/market/checkpoint APIs. Binary `tremor-api`, port 8787.
             Read-only: it holds no keys and refuses to start if given one.
subgraph/    The Graph. Same event history as entities; optional fill-history source for the web app.
web/         Next.js 16 App Router, Tailwind v4, wagmi v3/viem, recharts, react-three-fiber. Routes:
             / markets series/[id] write portfolio hedge docs/* (content in src/content/docs).
sim/         Ten-scenario economic simulation against an integer replica of the deployed pricing library.
docs/        architecture.md (mermaid), DEMO_SCRIPT.md, TASKS.md, TREMOR_V2_IMPLEMENTATION_PLAN.md.
```

## Non-negotiable invariants

**Contracts**
- No upstream 1inch or Solady file is modified, and Tremor deploys the **official** router source. There
  are no custom opcodes; `TREMOR_OPCODES` in `web/src/lib/program.ts` is deliberately empty.
- `quote == swap`: the engine writes storage only when `!isStaticContext`; the arithmetic is identical.
- Maker-favouring rounding throughout: takers pay `ceil` and receive `floor`; liabilities `ceil`.
- A reservation is created by a sale and destroyed **only** by a burn. `onBurn` on the controller is the
  single place a liability decreases, and it requires `amountOut <= released`.
- The vault has no admin, no upgrade path, no rescue, no arbitrary call, and no way to change its Aqua
  allowance. `withdrawFree` reverts above `balance - locked`. Every mutation re-asserts solvency.
- Docking is controller-only, inside `stopIssuance` and `closeSeries`, and reverts on a burn leg while
  claims are outstanding.
- Realized variance is exactly `ARCHITECTURE` §1; sampling is phase-aware and treats a reverting **or**
  zero-`updatedAt` round as nonexistent (live Base aggregators return zeros).
- The controller must fit **EIP-3860** (49,152 initcode) as well as EIP-170, because it embeds its
  children's creation code. Margin is 2,668 bytes; read models live in separate contracts for this reason.
- Takers approve the ROUTER. The vault's approvals to Aqua are made by code the writer does not control.
- Portfolio groups (v3): reserve == ceil(max(h,c)·S/1e18) while live; exits pay only from released reserve
  plus the group's locked exit buffer, never from free balance read mid-fill; `extruction` requires
  `msg.sender == ROUTER` in both engines; complementary payouts sum to exactly S.

**Cross-stack**
- The Lens and the on-chain quotes are authoritative. The backend and the frontend replicas must agree
  with them, and every replica is pinned to `contracts/test/vectors/pricing_vectors.json`.
- Manifests, DB schemas, API schemas and persisted frontend checkpoints are all versioned. A v1 artefact
  must fail loudly rather than be reinterpreted.
- Never present a UI estimate as an executable price. Every ticket re-quotes on chain before it signs.
- Never say order book, conventional variance swap, fair-value oracle, implied volatility, or perfect
  LVR hedge. See `web/src/content/docs/about/trust-surface.md`.

## Commands (from repo root unless noted)

```
make dev            # the whole stack: fork + deploy + seed + API + web, skipping satisfied steps
make anvil          # anvil --fork-url $BASE_RPC_URL --chain-id 31337 --auto-impersonate --port 8545
make test           # cd contracts && forge test       (ForkE2E and RouterCompat need BASE_RPC_URL)
make demo           # deploy + every demo stage with balance asserts, then sync manifest + export ABIs
make backend        # cargo run --release in backend/   (--reset-db after a redeploy)
make web            # npm run dev -- --port 3000 in web/
cd sim && npm run check && npm run sim      # pin the pricing replica, then run the ten scenarios
```

Ports: anvil 8545, API 8787, web 3000. The API's CORS origin is pinned to `http://localhost:3000`.

## Gotchas that cost time before

- **A stale exported ABI decodes the live Lens into the wrong fields** and every number on the page is
  quietly wrong, with no error anywhere. Always run `export-abi.sh` after a redeploy; `make demo` does.
- The backend's schema is versioned and it **refuses** to start against an older one. A redeploy needs
  `--reset-db`; `scripts/dev.sh` passes it automatically whenever it deployed.
- Never run `npm run build` while `next dev` is running: both write `.next` and corrupt each other.
  Stop dev, `rm -rf .next`, build, restart.
- A reverting transaction cannot be broadcast, so the demo's attack stage simulates rather than sends;
  and `vm.prank` inflates the nonce, which is why the attack and legitimate stages are separate scripts.
- Chainlink ETH/USD on Base changed aggregator phase around 2026-08-27, so 7-day windows cross phases.
  The accumulator's cursor stores its phase; tests cover overlap and gap variants across three phases.
- Public `mainnet.base.org` throttles (~10 calls/burst); cold trailing-variance queries take 30–60 s.
- WebGL does not paint in the Claude Code preview pane (`visibilityState: hidden` suspends rAF). Verify
  3D with headless Chromium:
  `"$HOME/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" --headless=new --hide-scrollbars --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --window-size=1440,900 --virtual-time-budget=15000 --screenshot=out.png http://localhost:3000/`
- drei `<Text>` does not render under swiftshader; in-scene labels use a CanvasTexture.
- `wagmi/connectors` barrel breaks the build (pulls Coinbase deps); import `injected` from `@wagmi/core`.
- alloy's `sol!` macro cannot decode a flat 35-element tuple, which is why the Lens groups its state into
  `LegStatus` / `MarketQuote` / `OracleProgress` / `VaultState` sub-structs.
- Solidity 0.8.30, via-IR, **optimizer_runs 200** — size-tuned for the controller's initcode budget, not
  a performance choice.

## Working rules

- Verify with real command output; never claim a result you did not observe.
- Keep `ARCHITECTURE.md` / `DESIGN.md` / `CONTRACTS.md` in sync with the code — update the doc or the
  code, never diverge silently. Update docs only after the behaviour is implemented and tested.
- Frontend changes follow `DESIGN.md` (light editorial, Figtree, square corners, lime accent only,
  hatched chart fills). Docs content is `web/src/content/docs/<group>/*.md` + `nav.ts`.
- Commit messages: imperative, one-line summary plus a short body. Commit continuously — judges read git
  history. The v1 prototype was built 2026-09-02; that is disclosed in the submission.
- Tracks: 1inch only. Add another sponsor integration only if it genuinely improves the product.
- Do not handle private keys. Base Sepolia deployment is done by the human with `--account <keystore>`.

## Hackathon facts

ETHOnline 2026, hacking 2026-09-04 → 09-16, submission Sunday 2026-09-13 12:00 EDT. 1inch judges reward
a named mechanism with custom SwapVM programs, quote/swap fidelity, real on-chain token transfers in the
demo, and a clean commit history. Compilers, agent operators and UI-only projects did not place before.
