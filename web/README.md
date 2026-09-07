# Tremor — web

Next.js 16 (App Router, TypeScript strict) front end for Tremor: a two-sided market in capped ETH
realized-variance receipts on 1inch Aqua.
Stack: Tailwind v4, wagmi v3 + viem v2 (injected connector only), @tanstack/react-query, recharts, zod, react-markdown + remark-gfm (docs),
three + @react-three/fiber + @react-three/drei (landing 3D, client-only chunks).
Design system: `../DESIGN.md` **v2** — light editorial trading UI (Swiss/terminal). Figtree + JetBrains Mono via `next/font/google`;
tokens `--bg/--bg-2/--bg-3`, `--line/--line-2`, `--ink/--ink-2/--ink-3`, one lime accent (`#BAFE4E`) for the primary action and
"live" state, `--panel*` for inverted surfaces. Square corners (2px), hairlines, bracketed labels (`[ Markets ]`), diagonal-hatch
chart fills instead of gradients, and a dark right-hand trade rail on app pages. See "Design" below.

## Run

```bash
cd web
npm install
cp .env.example .env.local        # adjust if needed
npm run dev -- --port 3000        # http://localhost:3000
npm run build && npm start        # production
npm run lint
```

The app degrades gracefully: with no deployment it shows a "not deployed" banner and disables chain reads / txs;
with the backend down it shows a quiet "API offline" state and still renders whatever the RPC can answer.

## Environment (`.env.local`, all public / inlined at build time)

| Var | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8787` | Rust backend (ARCHITECTURE.md §4) |
| `NEXT_PUBLIC_RPC_URL` | `http://127.0.0.1:8545` | JSON-RPC of the active chain |
| `NEXT_PUBLIC_CHAIN_ID` | `31337` | `31337` Tremor Fork (anvil fork of Base), `84532` Base Sepolia, `8453` Base |
| `NEXT_PUBLIC_TREMOR_SUBGRAPH_URL` | unset | The Graph GraphQL endpoint for Base Sepolia historical fills, checkpoints and finalization; the Rust API remains the fallback |

To run against the public deployment, copy `.env.sepolia.example` to `.env.local` and run a backend against
`contracts/deployments/84532.json`. The default `.env.local` remains the local Anvil configuration.

## Deployment addresses and ABIs

* `src/config/deployment.json` — manifest in the §3.4 shape. A zero-address placeholder is checked in; the real
  file is copied by `contracts/script/sync-deployment.sh <chainId>` (from `contracts/deployments/<chainId>.json`).
  `src/lib/contracts.ts` exports `ADDR` and `isDeployed`; the UI never crashes on zero addresses.
* `src/abi/*.json` — `TremorLens`, `TremorPrograms`, `VarianceSeriesFactory`, `TremorMarketEngine`,
  `TremorMakerVault`, `TremorSeriesDeployer`, `VarianceAccumulator`, `AquaSwapVMRouter`, `Aqua`,
  `VarianceReceipt`, `ERC20`, `AggregatorV3`, `RealizedVarianceOracle`, `MockUSDC`. `contracts.ts` uses a JSON
  ABI when its `abi` array is non-empty and otherwise falls back to human-readable fragments (`parseAbi`).
  Types always come from the human-readable definitions, so swapping the runtime ABI is transparent.

  ```bash
  cd contracts && ./script/export-abi.sh      # refreshes web/src/abi and backend/abi together
  ```

  > **The Lens must be read through the JSON ABI.** Its `SeriesState` is a nested struct, and a stale export
  > decodes the live struct into the wrong fields with no error anywhere — every number on the page is then
  > quietly wrong. Re-export after every redeploy; `make demo` does.

## Structure

```
src/
  app/                       routes (App Router)
    page.tsx                 /            landing: hero, trailing RV tiles (1d/7d/30d + sparkline), open series, how it works, LVR hook
    markets/page.tsx         /markets     realized vol, market vol, bid, ask, available units, locked backing
    series/[id]/page.tsx     /series/:id  realized vs market vol + executable band, price path, payoff,
                                          Buy/Exit/Redeem/Oracle rail, locked collateral, fills, program viewer
    write/page.tsx           /write       three decisions → thirteen derived params → one create transaction
    portfolio/page.tsx       /portfolio   receipts held (indexed entry, exit bid, payout, redeem/burn), the maker
                                          vault (deposit / withdraw free), and series written (stop / close)
    hedge/page.tsx           /hedge       LVR calculator → hedge units per open market → buy
    (app)/                   route group carrying the app Shell (top nav, dock, footer) for /, /markets, /series, /write, /portfolio, /hedge
    docs/layout.tsx          /docs/*      GitBook-style docs shell: 280px grouped sidebar, ⌘K search, light/dark toggle (docs only)
    docs/page.tsx            /docs        index = About Tremor → Architecture
    docs/[...slug]/page.tsx  /docs/<group>/<page>  24 pages prerendered from src/content/docs/**.md (generateStaticParams)
    layout.tsx, globals.css  fonts, providers, shell, design tokens (Tailwind v4 @theme) + component classes in @layer components
  config/   env.ts, chains.ts (Tremor Fork / Base Sepolia / Base), deployment.json
  abi/      JSON ABI drop zone (see above)
  lib/
    contracts.ts   addresses, ABI selection (JSON → parseAbi fallback), TAKER_SPENDER (= router)
    api.ts         zod schemas + fetchers + react-query hooks for every backend endpoint (snake_case → camelCase, bigint)
    chain.ts       viem reads: Lens state/states/quotes/buildTakerData/legDirection, factory orders/shipPlan, ERC20
    tx.ts          the twelve flows (create vault / deposit / withdraw free / create series / stop issuance /
                   close / buy / exit / redeem / burn worthless / checkpoint / finalize); the create flow's
                   persisted checkpoint is versioned and keyed by account+chain+vault+params
    hooks.ts       useSeriesList / useSeries (chain-first, API extras), useNow, useMounted
    series.ts      normalized SeriesState model + bigint math (liability, payoff, integrals, lifecycle gating)
    derive.ts      /write: three decisions → a complete, validated SeriesParams, in integers
    program.ts     SwapVM program decoder ([opcode][len][args], MakerTraits program offset, Extruction target)
    format.ts      exact fixed-point parsing/formatting, sqrtWad, vol% ↔ variance
  components/
    shell/      TopBar (64px, bracketed links, black/lime wallet button), BottomBar (mobile icon dock), Footer, NetworkChip, DeploymentBanner
    ui/         Card/LineItems/DarkItems, Button, Tag/StatusTag (square dots), AmountInput/SelectInput, Segmented, StatTile,
                Hatch (AllocBar, Ring), EmptyState, Skeleton, Toast, Banner, Address, SectionRow/PageHeader
    charts/     hatch.tsx (SVG diagonal-hatch pattern + SquareDot), ChartTooltip, ChartLegend, ChartDataTable,
                Sparkline, VolatilityChart (realized vs market quote + executable band), PricePathChart, PayoffChart
    series/     SeriesTable, SeriesDetail (terminal grid), TradeRail (dark, sticky, lifecycle-aware),
                TicketWidget, BuyTicket, ExitTicket, RedeemTicket, OracleTicket, CollateralCard, MoneyFlow,
                FillsFeed, ProgramViewer
    landing/    Hero (+ HeroTicket, HeroEyebrow), SlantMarquee, TrailingTiles, HowItWorks, MechanismFigure, LvrHook
    three/      VarianceSurface (lime low-poly terrain: height-coloured, lime wireframe overlay, amplitude 0.6 + 2.2·live 7d RV),
                HeroSurface (dynamic ssr:false wrapper), Ornament (4 mechanism scenes: wallet+legs, real K(t) ribbon, Σ r² cubes,
                LVR/payout/flat ribbons; frameloop="demand", preserveDrawingBuffer, mounted once), CardOrnament (data plumbing +
                mount-once wrapper), useActive (in-view / mount-once / tab-visible / reduced-motion gates)
    docs/       DocsSidebar, DocsSearch (⌘K modal), DocsThemeToggle, CopyButton, OnThisPage, Markdown (react-markdown + remark-gfm,
                ```cards fences → link cards), DocPageView (breadcrumb, H1, lede, prev/next)
    write/ portfolio/ hedge/ tx/TxProgress
  content/docs/ nav.ts (groups → pages, order = sidebar + prev/next) and <group>/<page>.md bodies; `{{router}}`-style
                placeholders are filled from deployment.json at render (src/lib/docs.ts)
```

## Design (v2)

Binding spec: `../DESIGN.md`. How it maps to code:

* **Tokens** — `src/app/globals.css` `@theme`: `bg #FFFFFF`, `bg-2 #F9F7F4`, `bg-3 #F3F4F5`, `line #E6E8EA`, `line-2 #D5D8DB`,
  `ink #0D0D0D`, `ink-2 #5F6368`, `ink-3 #9AA0A6`, `lime #BAFE4E`, `lime-dark #2E5A00`, `up #2FB344`, `down #E5484D`,
  `panel #0D0D0D`, `panel-2 #1A1B1E`, `panel-3 #5C6166`. Custom component classes live in `@layer components` so Tailwind
  utilities (e.g. `md:hidden`) still win. Radius is 2px everywhere; no shadows; motion 120ms ease-out, reduced-motion respected.
* **Type** — Figtree 300/400/500/600 (`--font-figtree`), JetBrains Mono 400 (`--font-jetbrains`). Classes: `.display` (72/76),
  `.h-section` (50/56), `.h-card` (20/28 500), `.body` (16/24 ink-2), `.label` (13/16 ink-3), `.micro` (11 uppercase),
  `.num-lg` (40/44 tabular), `.step-num` (64/300 line-2), `.bracket` renders `[ Label ]` with muted bracket glyphs.
* **Shell** — 64px top nav (logo mark + `[ Markets ] [ Write ] [ Portfolio ] [ Hedge ] [ Docs ]` + `[ Tremor Fork ]` + black
  "Connect wallet" that turns lime with the address). Mobile (< 768px): black bottom dock, square cells, active cell lime. Footer:
  hairline, bracketed links, "Built on 1inch Aqua · Base". No sidebar, no starfield.
* **Primitives** — `.btn` primary (lime) / secondary (ink) / tertiary (white + line-2) / white; `.card` (+ `.card-2`, `.card-flush`,
  `.card-head` title row with hairline); `.tag` square tags; `StatusTag` = `■ Live` (lime-dark) / `■ Upcoming` (ink-3) /
  `■ Finalizing` (ink-2) / `■ Finalized` (up) / `■ Closed` (ink-3); `.segmented` rectangular cells, selected cell ink (lime on dark); `.input` on bg-3; `.table` with bg-3 header,
  52px rows, hover bg-2; `.alloc` = solid segment + vertically hatched remainder; `.ring` = striped ring ornament (empty states,
  principle cards); `.toast` white square with 1px ink border.
* **Charts** — `charts/hatch.tsx` exports `HatchPattern` (1px ink lines at 45°, 6px spacing, 35% opacity) and `SquareDot`; every
  area fill is `url(#hatch…)`, strokes are ink 1.5px, the market-quote series ink-3 dashed, the executable band a flat line-2 fill, grid `--line`, ticks 11px ink-3, tooltip is the
  square white `InkTooltip`. Square markers appear when a series has ≤ 40 points.
* **Trade rail** — `series/TradeRail.tsx`: `--panel` container, a bid/ask strip, a lifecycle-aware
  Buy/Exit/Redeem/Oracle segmented control (a tab whose only outcome would be a revert is never rendered),
  `TicketWidget` (two `--panel-3` halves:
  "Balance … / MAX" head, 40px centered amount, selector chip, square swap button on the seam), `DarkItems` key-value rows on
  `--panel-2`, lime CTA, dark `TxProgress`. `BuyTicketPreview` renders the same ticket in a light frame inside the landing hero.
* **Landing** — dark hero (`.hero`: black → #2A2C2F fade + 12-column 6% grid), `SectionRow` (■ label | heading + body, 1:2 grid)
  for Live variance (stat tiles with hatched bars + hatched sparklines), Open series (compact table), How it works (4 bg-2 cards
  with rings and 01–04 numerals), Hedge LVR (allocation card with hatched bars).

## Docs section (`/docs/*`)

Own layout (not the app grid): header with centered search (`⌘K` opens a modal — arrow keys move, Enter opens; client-side over
titles, headings and body text), 280px sidebar with 12px uppercase group headers and 15px items (active bold + lime rule),
content column max 900px (breadcrumb, 38px H1, 17/28 body, right-aligned **Copy** = page as markdown, shaded-header tables,
external-link glyphs, link cards, Next/Previous footer cards), "On this page" rail at ≥1280px, "Built on 1inch Aqua" bottom-left.
Light/dark toggle for the docs only (dark: `#0F1114` bg, `#16191D` sidebar, `#E6E8EA` text, `rgba(255,255,255,0.08)` hairlines),
persisted in `localStorage['tremor-docs-theme']`, default light, applied pre-paint by an inline script. Mobile: sidebar becomes a
"Docs menu" disclosure. Content lives in `src/content/docs/<group>/<page>.md`; groups and order in `src/content/docs/nav.ts`.
Sources: `../ARCHITECTURE.md`, `../contracts/CONTRACTS.md`, `../backend/README.md`, `../docs/architecture.md`, `../README.md`.

## Transaction flows (`src/lib/tx.ts`)

Every flow simulates, waits for wallet confirmation, waits for the receipt, exposes an explicit failure
state, and invalidates the affected queries.

* **Buy** — `approve(USDC → router)` if needed, then `router.swap(issueOrder, amount, takerData)` with the order
  from `programs.order(id, ISSUE)`, `isAToB = lens.legDirection(id, ISSUE)` and
  `takerData = lens.buildTakerData(...)`. Exact-in or exact-out; threshold from the on-chain quote ± slippage.
  Built with `allowPartialFill = true`, so a size the engine clamps fills what it can instead of reverting on
  TakerTraits' amount check — and the ticket says so before you sign.
* **Exit** — `approve(receipts → router)`, then the EXIT order, exact-in only. The receipts are burned.
* **Redeem** — the SETTLE order at the fixed `payoutPerUnit`, exact-in only. A series that finalized worthless
  routes to `factory.burnWorthless` instead, because SwapVM cannot pay a zero output.
* **Create series** — `createVault()` (idempotent) → `approve(USDC → vault, topUp)` → `vault.deposit(topUp)` →
  `factory.createSeries(vault, params)`, which mints the inventory and ships all three strategies in one
  transaction. Only the shortfall over the vault's existing free collateral is pulled from the wallet.
* **Vault** — `deposit` and `withdrawFree(amount, recipient)`. The withdraw button is disabled above `free`,
  and the vault would revert anyway.
* **Writer lifecycle** — `stopIssuance` (confirmed; leaves exit and redemption untouched) and `closeSeries`
  (only with nothing outstanding). **Docking and approvals are not exposed to writers at all.**
* **Oracle** — `accumulator.checkpoint(id, 32)` and `accumulator.finalize(id)`, from any wallet.

All amounts are `bigint`; vol% ↔ variance conversions are exact integer math (`format.ts`), and
`src/lib/series.test.ts` pins the replica against the contracts' own 60-digit reference vectors.

## Data sources

Series lists and live fields come from the Lens via viem (**chain-first**) with backend extras (per-leg fill
statistics) merged in; the market chart, fills, checkpoints, vault history, trailing realized vol and feed
history come from the backend. Both poll every 8–30 s.

The split is deliberate: the Lens is the executable authority and the indexer is minutes behind by
construction, so merging the other way round would put a stale bid in a trade ticket.

## Verification (last run)

```
npm test                    # 25 tests — the pricing replica against contracts/test/vectors/pricing_vectors.json,
                            #            plus lifecycle gating, normalization and list behaviour
npx tsc --noEmit            # clean
npx eslint src              # 0 errors, 0 warnings
npm run build               # ✓ 33 routes: app routes + /docs + 24 × /docs/[...slug]; /series/[id] dynamic
```

Live checks against a seeded fork (`make dev`): `/`, `/markets`, `/series/1`, `/portfolio`, `/write`, `/hedge`,
`/docs/**` all render with real Lens data; no console errors; no horizontal overflow at 375 px on any route;
every interactive element has an accessible name; a buy and an exit executed through the official router
(234,481 and 241,866 gas) with the vault's reservation moving by exactly `units × maxPayoutPerUnit`.

Notes:
* `src/abi/*.json` currently hold the real ABIs extracted from `contracts/out/*.sol/*.json` (abi array only);
  `deployment.json` is refreshed by `contracts/script/sync-deployment.sh 31337` once `Deploy.s.sol` has written the manifest.
* `injected` is imported from `@wagmi/core` (not the `wagmi/connectors` barrel) because the barrel pulls Coinbase's
  `baseAccount` connector and its optional `@x402/*` peers into the webpack graph and breaks the build.
* Chain definitions live in `src/config/chains.ts` instead of the `viem/chains` barrel to keep `ox/tempo` out of the bundle.
