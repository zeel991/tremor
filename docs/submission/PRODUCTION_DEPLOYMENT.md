# Production deployment plan — frontend, API, subgraph

**Nothing in this document has been published, deployed, or created.** No hosting account was found in
the repository, none was assumed, and no service was provisioned. This is the configuration and the
sequence, prepared so the actual deployment is a short, reviewable operation once accounts are named.

Current reality: the app runs only on `localhost:3002` (Next.js) and `localhost:8789` (Rust API). **A
submission cannot depend on localhost**, so this is a P0.

---

## 1. What exists in the repo today

Discovered by inspection, not assumption:

| Thing | Status |
|---|---|
| `vercel.json`, `netlify.toml`, `Dockerfile`, `fly.toml`, `render.yaml` | **none exist** |
| CI/CD workflow for deployment | none |
| Any `*.vercel.app` / `*.fly.dev` / `*.onrender.com` URL anywhere in the repo | none |
| `web/.env.example`, `web/.env.sepolia.example`, root `.env.example` | exist — the conventions below follow them |
| Deployed subgraph | one, **stale** — see §5 |

The root `.env.example` already establishes the variable names (`RPC_URL`, `DEPLOYMENT_JSON`,
`DATABASE_URL`, `PORT`, `CORS_ORIGIN`, `NEXT_PUBLIC_*`). Nothing new is invented here.

**Templates now in the repo** (placeholders only — no credential, no invented URL):

| File | For |
|---|---|
| `web/.env.production.example` | Vercel production environment |
| `backend/.env.production.example` | Fly.io app environment |
| `web/.env.sepolia.example` | local run against the public Base Sepolia deployment |

Note both `.gitignore`s ignore `.env*` by default; explicit `!` rules were added so these three templates
are tracked. They must never gain a real value — the ignore rules protect `.env` and `.env.local`, not
these.

---

## 2. Recommended architecture (smallest viable)

| Component | Recommendation | Why |
|---|---|---|
| Next.js frontend | **Vercel** | Next.js 16 App Router with `ƒ` dynamic routes (`/pairs/[id]`, `/series/[id]`) needs a Node runtime, not static export. Zero-config for this framework; free tier is sufficient. |
| Rust API | **Fly.io** | The API is a single binary with a **SQLite file** that must persist. Fly volumes give a real persistent disk on the free/hobby tier. Render's free tier has ephemeral disk, which would silently reset the index. |
| Subgraph | **Subgraph Studio** | Already the project's path; one stale deployment exists. |

Alternative if a Fly account is unavailable: Railway (persistent volumes, Docker) or a Render **paid**
instance with a disk. **Do not** put this API on any host with ephemeral storage — the indexer would
re-scan from block 46685189 on every restart and serve empty data in the meantime.

---

## 3. Frontend production environment

The frontend reads exactly four variables (`web/src/config/env.ts`).

```bash
# Vercel → Project → Settings → Environment Variables (Production)
NEXT_PUBLIC_CHAIN_ID=84532
NEXT_PUBLIC_RPC_URL=https://sepolia.base.org
NEXT_PUBLIC_API_URL=https://<api-host>          # the Fly app's public URL, no trailing slash
NEXT_PUBLIC_TREMOR_SUBGRAPH_URL=                # DELIBERATELY EMPTY — see §5
```

Build settings: root directory `web`, build command `npm run build`, install `npm ci`, output handled by
the Vercel Next.js preset. Node 20+.

**`NEXT_PUBLIC_RPC_URL`**: `https://sepolia.base.org` is the public endpoint and it rate-limits. If a
private Base Sepolia RPC (Alchemy/Infura/QuickNode) is available, use it — but note it will be embedded in
the client bundle and therefore **public**. Only use a key that is rate-limited and disposable, or keep the
public endpoint.

**Verified**: a production build with exactly these values (placeholder API host) compiles clean —
35 static pages, 14 routes, no errors. The only `localhost` strings in the output bundle are the
**chain-31337 anvil fallback definition** (dead code when `chainId=84532`) and the documentation pages that
legitimately *document* the local defaults. **There is no production localhost leak.**

---

## 4. Backend production environment

The API is read-only by design: it holds no keys and refuses to start if given one
(`backend/src/config.rs:59`).

```bash
RPC_URL=https://sepolia.base.org
DEPLOYMENT_JSON=/app/deployments/84532.json     # must be the schema-3 manifest
DATABASE_URL=sqlite:///data/tremor_84532.db     # MUST live on the mounted volume
PORT=8080
BIND_ADDRESS=0.0.0.0                            # default is 127.0.0.1 — unreachable in a container
CORS_ORIGIN=https://<frontend-host>             # exact origin, no trailing slash, no wildcard
POLL_MS=3000
```

Four things that will break a deployment if missed:

1. **`BIND_ADDRESS=0.0.0.0`.** The default `127.0.0.1` (`config.rs:76`) means the container listens only to
   itself and every health check fails.
2. **`DATABASE_URL` on the volume.** The default `sqlite://tremor.db` is relative and lands on ephemeral
   container disk. Point it at the mount.
3. **`CORS_ORIGIN`.** Defaults to `http://localhost:3000` (`config.rs:82`). The browser will block every
   API call from the deployed frontend until this is the real origin. `build_cors` accepts a
   comma-separated list, and `*` for `Any` — **do not use `*`**; name the origin.
4. **`DEPLOYMENT_JSON` must be schema 3** and must be shipped into the image. The backend validates the
   schema version and refuses to start on an older one.

### Persistence requirement

SQLite file on a persistent volume, ≥1 GB. Without it the indexer restarts from block 46685189 on every
deploy and serves incomplete data until it catches up. Backfill from 46685189 to head is currently ~9,000
blocks — minutes, not hours — but it must not happen on every request-serving restart.

### Health and readiness

`GET /health` already returns everything a probe needs:

```json
{"ok":true,"chain_id":84532,"schema_version":3,"manifest_schema_version":3,
 "head_block":…,"indexed_block":…,"lag_blocks":3,"indexer_error":null,…}
```

- **Liveness**: `GET /health` returns 200.
- **Readiness**: `ok == true` **and** `indexer_error == null` **and** `lag_blocks` under ~50.

There is no separate `/ready` route; a probe should parse `/health`. Adding one is not necessary and would
be scope creep.

### Suggested Fly configuration

Not written to the repo — this is the content to create when an account is named.

```toml
# fly.toml
app = "tremor-api"          # placeholder; use the real app name
primary_region = "iad"      # near Base Sepolia RPC

[build]
  dockerfile = "backend/Dockerfile"

[env]
  RPC_URL = "https://sepolia.base.org"
  DEPLOYMENT_JSON = "/app/deployments/84532.json"
  DATABASE_URL = "sqlite:///data/tremor_84532.db"
  PORT = "8080"
  BIND_ADDRESS = "0.0.0.0"
  POLL_MS = "3000"
  # CORS_ORIGIN set via `fly secrets set` or here once the frontend URL exists

[[mounts]]
  source = "tremor_data"
  destination = "/data"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false     # the indexer must keep running
  min_machines_running = 1

  [[http_service.checks]]
    path = "/health"
    interval = "30s"
    timeout = "5s"
```

`auto_stop_machines = false` matters: this is not a request-driven service, it is a continuously running
indexer.

A `backend/Dockerfile` does not exist yet and would need to be written (multi-stage Rust build, copy the
binary plus `contracts/deployments/84532.json`). It is a ~20-line file; it is not written here because
creating deployment scaffolding for an unnamed host is premature.

---

## 5. The Graph — the stale-subgraph problem

**This is the one item where doing nothing is actively harmful.**

`web/.env.local` (developer-local, gitignored) points at
`https://api.studio.thegraph.com/query/1758209/tremor/v2`, and `web/.env.sepolia.example` used to. That
endpoint is **live and fully synced**
(block 46694251, `hasIndexingErrors: false`) — and it indexes a **different, abandoned deployment**:

```bash
curl -s -X POST https://api.studio.thegraph.com/query/1758209/tremor/v2 \
  -H 'content-type: application/json' -d '{"query":"{vaults(first:5){id}}"}'
# {"data":{"vaults":[{"id":"0x5276bcc641465e5a900e88b22a8bdc0ccd972d1d"}]}}
```

`0x5276bcc6…` is not the current vault (`0x9C9341d0…`). Its schema has no `portfolioGroups` field at all.
A judge who opens that endpoint sees stale, unrelated data presented as Tremor's indexing layer.

**Decision: ship with `NEXT_PUBLIC_TREMOR_SUBGRAPH_URL` empty.** The frontend already treats an empty
subgraph URL as "not configured" and falls back to the Rust API, which is accurate and current. An empty
variable is honest degradation; a populated one pointing at dead data is a false claim.

**Done locally.** `web/.env.sepolia.example` no longer carries the stale URL and explains why it is empty;
`web/.env.production.example` ships it empty. The application code needs no change: `env.subgraphUrl`
already defaults to `""` (`web/src/config/env.ts`), and `web/src/lib/graph.ts` gates on
`Boolean(env.subgraphUrl) && env.chainId === 84532`, so an unset value disables every Graph-backed query
and the app reads from the Rust API and directly from chain. `web/.env.local` is a developer's own
gitignored file and was left alone; it is currently pinned to chain 31337, where that same guard already
disables the Graph path.

### Local subgraph status (verified, this revision)

```
npx graph codegen   → Types generated successfully          (exit 0)
npx graph build     → Build completed: build/subgraph.yaml   (exit 0)
npx graph test      → All 4 tests passed                     (exit 0)
```

The local `subgraph.yaml` already targets the current v3 addresses: PortfolioMarket
`0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb`, Controller `0xC86Cf4AD…`, Accumulator `0xcdd79544…`, Router
`0xb8dcED3C…`, all at `startBlock: 46685189`.

### What a republished subgraph would and would not index

**Would index** (PortfolioMarket data source, `src/portfolio.ts`): `GroupCreated`, `PortfolioIssued`,
`PortfolioExited`, `PortfolioSettled`, `GroupFinalized`, `ExitBufferFunded`, `ExitBufferWithdrawn`,
`WorthlessBurned` → `PortfolioGroup` and `PortfolioEvent` entities. Plus the v2 Controller/Router/Receipt/
Vault sources.

**Would NOT index: portfolio checkpoints.** The `Checkpointed` handler is bound to the **v2 series**
accumulator `0xcdd79544…`, not the portfolio accumulator `0xea5A9Cfb…`. **Portfolio checkpoints are
backend-only and must always be described that way.** Do not widen Graph scope to make the integration
look broader — that would be exactly the appearance-driven change the project rules forbid.

Also worth stating: the two v2 data sources (Controller, Accumulator) will index **nothing**, because the
v2 `seriesFactory` at `0xC86Cf4AD…` has **zero logs** on Base Sepolia — no v2 series was ever created
there. That is not a bug, but a judge who queries `series_collection` and gets an empty list deserves the
explanation.

### Publishing (requires separate approval)

```bash
cd subgraph
npx graph auth --studio <deploy-key>        # entered interactively by the user, never in chat
npx graph codegen && npx graph build
npx graph deploy --studio tremor            # publishes a NEW version; label it v3
```

Then verify before pointing anything at it:
```bash
curl -s -X POST <new-endpoint> -H 'content-type: application/json' \
  -d '{"query":"{_meta{block{number} hasIndexingErrors} portfolioGroups(first:5){id groupId}}"}'
```
Only once `portfolioGroups` returns group 1 (and group 2, if it exists by then) and `hasIndexingErrors`
is false should `NEXT_PUBLIC_TREMOR_SUBGRAPH_URL` be set in Vercel.

---

## 6. Setup sequence

1. User names the hosting accounts. **← currently blocked here**
2. Write `backend/Dockerfile` and `fly.toml`; build locally; run the container against Base Sepolia and
   confirm `/health` reports chain 84532, schema 3, `indexer_error: null`.
3. Create the Fly app + volume; deploy; note the public URL. **(approval)**
4. Deploy the frontend to Vercel with `NEXT_PUBLIC_API_URL` set to that URL and the subgraph URL empty.
   **(approval)**
5. Set `CORS_ORIGIN` on the API to the Vercel production origin; redeploy the API.
6. Run the smoke test in §8 against the public URLs.
7. Separately: publish the v3 subgraph, verify it, and only then set the subgraph env var. **(approval)**

Steps 3, 4 and 7 are external actions and each needs its own go-ahead.

### Domain / CORS coupling

The API's `CORS_ORIGIN` must match the frontend's **final** origin exactly. Vercel preview deployments get
per-deployment URLs that will *not* match, so previews will fail their API calls unless every origin is
listed. Decide the production origin first, set CORS to it, and demo from that URL only.

### Rollback

- Frontend: Vercel keeps every deployment; promote the previous one. Instant, no data involved.
- API: `fly deploy --image <previous>` or `fly releases rollback`. The volume persists across rollbacks,
  so the index survives.
- Subgraph: Studio versions are immutable; point the frontend env back to the previous version, or empty.
- **No rollback affects on-chain state.** Nothing in this plan touches a contract.

---

## 7. Security review of the production config

- The API holds **no keys** and refuses to start if given one. Nothing secret goes into its environment.
- `NEXT_PUBLIC_*` variables are **embedded in the client bundle and are public by definition**. Never put
  anything sensitive there — specifically, no RPC key that is not disposable.
- The Graph deploy key is entered interactively via `graph auth`; it is never committed, never printed,
  and must never be pasted into chat.
- No private key, keystore, mnemonic, or database file may be added to the image or the repo.

---

## 8. Clean-browser smoke test

Run in a fresh private window against the **public** URLs, desktop (1440×900) and mobile (390×844).

**Routes** — each must load cold *and* survive a hard refresh (direct navigation, not client-side routing):
`/` · `/markets` · `/pairs` · `/pairs/1` · `/pairs/new` · `/portfolio` · `/write` · `/hedge` · `/docs`
and one deep docs page such as `/docs/about/trust-surface`.

**Per route:** no console errors, no hydration warnings, no layout overflow at 390 px, and no request to
`localhost` in the network tab.

**Chain and wallet:**
- Wallet connects; connecting on the wrong network offers a switch to Base Sepolia (84532).
- With no wallet connected, pages still render read-only data rather than erroring.

**Data provenance** — confirm each surface reads from where it claims:
- Group state, quotes, reserve, buffer → **direct chain reads** via `NEXT_PUBLIC_RPC_URL`.
- Event feed, checkpoints, `/pairs` list → **Rust API**.
- Nothing should be attributed to The Graph while `NEXT_PUBLIC_TREMOR_SUBGRAPH_URL` is empty.

**Degraded states** — these must be honest, not blank or falsely successful:
- API unreachable: the page still renders chain data and says the indexer is unavailable.
- Subgraph unset: no Graph-sourced claim appears anywhere.
- Group 1 finalized/settled: the UI shows a completed group, not a broken one.

**Token labelling:** every surface showing the quote asset must identify it as **Tremor MockUSDC**, a
freely mintable test token — never as USDC. Its ERC-20 `symbol()` returns `"USDC"`, so any UI that renders
the raw symbol is actively misleading and must be checked specifically.
