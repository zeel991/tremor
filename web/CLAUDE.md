# web/ — agent notes
Read `README.md` and `/DESIGN.md` (v2). Data plumbing: `src/lib/{contracts,api,chain,tx,format,program}.ts`; UI in `src/components`.
- `npx tsc --noEmit`, `npx eslint src`, then `npm run build` ONLY with the dev server stopped (`pkill -f "next dev"; rm -rf .next`).
- ABIs: `src/abi/*.json` (exported by contracts/script/export-abi.sh); addresses: `src/config/deployment.json` (synced by sync-deployment.sh).
- All on-chain amounts are bigint; never float. Variance is WAD; vol = sqrt(variance).
- `src/lib/series.ts` replicates `contracts/src/libs/VariancePricing.sol`. Any pricing change must keep
  `npm test` green — it checks the replica against the contracts' own 60-digit reference vectors, exactly.
- The Lens is the executable authority; the backend is a replica. Merge chain state over API state, never the
  reverse, and re-quote on chain immediately before building a transaction. Never render an estimate where the
  user will read an executable price.
- Terminology is binding: writer (not seller), market quote volatility (not implied), locked collateral (not
  coverage), issue/exit/redeem legs, executable bid/ask. Never say order book, conventional variance swap,
  fair-value oracle or perfect LVR hedge.
- Only show "fully collateralized" when the Lens says so: balance >= locked AND the allowance suffices AND a
  burn leg is still shipped.
- Docs section: `src/content/docs/<group>/*.md` + `src/content/docs/nav.ts`; GFM tables, ```cards JSON blocks for link cards.
- 3D: `src/components/three/*` (react-three-fiber). Canvases must stay mounted on scroll; pause via frameloop, never unmount.
- Verify visuals with the browser workflow described in root `AGENTS.md`; the preview pane may not paint WebGL.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
