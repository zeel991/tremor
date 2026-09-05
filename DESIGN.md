# Tremor design system v2 — light editorial trading UI

Reference: Behance "DeFi Web3 Website Design UI/UX Webflow" (AstraFi case study by UI Farid Hossain /
UXify Studio, https://www.behance.net/gallery/253707819). Reproduce the visual language faithfully —
layout, palette, type scale, spacing, component shapes, chart treatment. Do not copy their imagery,
logo, or copy text. Reference crops for builders (view them):
/private/tmp/claude-501/-Users-zeeast-Desktop-optionsvm-proto/67cbc61e-acb5-4411-8e7d-c50bf5fb3a28/scratchpad/behance/crop_top.png (trading dashboard),
crop_hero.png (dark hero with swap widget), crop_widgets.png (swap widget, icon dock, hatched chart),
crop_dash2.png (dark account panel), crop_dash3.png (principle cards, light swap widget), crop_type.png,
crop_palette.png, crop_final.png (allocation card with hatched bars, network list).

## Mood
Swiss/editorial. Mostly white. Generous whitespace, thin hairlines, square corners everywhere (radius 0–4px),
one loud lime accent used sparingly for the primary action and "live" state, near-black for the strongest
emphasis and for inverted panels. Labels are set in small caps-height text with bracket glyphs, e.g. `[ Markets ]`.
Numbers are large and light. Charts use diagonal hatching instead of gradient fills. The whole thing reads like
a printed trading terminal, not a neon dashboard.

## Color tokens
```
--bg:          #FFFFFF;   /* page */
--bg-2:        #F9F7F4;   /* off-white section bands, card backgrounds */
--bg-3:        #F3F4F5;   /* table header, chips, inputs */
--line:        #E6E8EA;   /* hairlines */
--line-2:      #D5D8DB;   /* stronger borders, gray swatch */
--ink:         #0D0D0D;   /* primary text, black buttons, inverted panels */
--ink-2:       #5F6368;   /* secondary text */
--ink-3:       #6F7479;   /* muted labels, axis ticks; AA contrast on white */
--lime:        #BAFE4E;   /* primary CTA, live dot, selected state */
--lime-ink:    #0D0D0D;   /* text on lime */
--lime-dark:   #2E5A00;   /* small square bullets next to section labels */
--up:          #2FB344;   /* positive */
--down:        #E5484D;   /* negative */
--panel:       #0D0D0D;   /* inverted panel bg */
--panel-2:     #1A1B1E;   /* inverted panel cards */
--panel-3:     #5C6166;   /* the gray swap-widget surface (mid gray with white type) */
--panel-line:  rgba(255,255,255,0.10);
```
No gradients except a subtle vertical fade on the dark hero (black → #2A2C2F) behind a faint 12-column grid of
1px lines at 6% white (the reference has a foggy landscape photo; we use the grid + fade instead).

## Typography
- Display and UI: **Figtree** (closest free match to PP Mori) via next/font/google, weights 300/400/500/600.
- Mono for addresses, hashes, bytecode, round ids: **JetBrains Mono** 400.
Scale (desktop): hero 72/76 weight 400 letter-spacing -0.02em; section heading 50/56 weight 400; card title 20/28
weight 500; body 16/24 weight 400 `--ink-2`; label 13/16 weight 500 `--ink-3` with bracket glyphs where used as
navigation or meta (`[ Live ]`); micro 11/14 weight 500 uppercase 0.06em for table headers. Big numbers 40/44
weight 400 tabular-nums. Step numerals "01 02 03" at 64px weight 300 `--line-2`.

## Layout
- **Top navigation, no sidebar.** 64px bar, white, bottom hairline. Left: lime square logo mark (16px) + "Tremor" 18/500.
  Center: bracketed links `[ Markets ] [ Write ] [ Portfolio ] [ Hedge ] [ Docs ]`. Right: network chip
  (`[ Tremor Fork ]`), and a black rectangular "Connect wallet" button 40px (lime when connected, showing the truncated address).
- Content max-width 1280px, 24px gutters; section vertical rhythm 96px on landing, 24px in app pages.
- App pages use a **terminal grid**: left 2/3 white workspace (chart + tables), right 1/3 **inverted panel**
  (`--panel`) for the trade ticket, like the reference's dark account/deposit rail.
- The market page has a **fixed visible hierarchy**, and protocol internals do not get to jump it:
  1. compact market header (symbol, status, expiry, and a tape of bid/ask, realized vol, market vol, locked backing)
  2. the volatility time series
  3. the connected wallet's position summary
  4. the dark trade rail
  5. one line of locked-collateral state
  6. a plain-language settlement explanation
  7. `<details>` **Advanced details** — addresses, order hashes, raw programs, Aqua events, checkpoints, Chainlink
     round ids, immutable parameters, complete fills. Available to a judge in one click, not in an ordinary user's way.
- Mobile: nav collapses to logo + wallet + a bottom bar of 5 square icon tabs (reference's dark icon dock:
  black bar, square cells, active cell lime).

## Components
- **Buttons**: rectangular, 40px, 14/500. Primary = `--lime` bg `--ink` text. Secondary = `--ink` bg white text.
  Tertiary = white bg 1px `--line-2`. Disabled 40%. Hover darkens 6%. No shadows, no rounding beyond 2px.
- **Cards**: white on `--bg-2` bands or `--bg-2` on white, 1px `--line`, radius 2px, padding 24px. A card title row is
  a 20/500 title left and a small `--ink-3` meta right, separated from the body by a hairline.
- **Section label**: 10px square in `--lime-dark` + 16/500 label, left column; heading and body in the right column (2-col 1:2 grid), exactly like "Project Overview / Design Principles" rows in the reference.
- **Stat tile**: label 13 `--ink-3`, value 40/400 `--ink`, delta 13 in `--up/--down`, optional hatched mini-bar under it.
- **Table**: header row `--bg-3` with micro uppercase labels; rows 52px; hairline separators; status as a small
  square dot + text (`■ Live` in lime-dark, `■ Upcoming` in `--ink-3`, `■ Finalizing` in `--ink-2`, `■ Finalized`
  in `--up`, `■ Closed` in `--ink-3`); numbers tabular; action buttons are tertiary. Row hover `--bg-2`.
- **Trade ticket (dark rail)**: `--panel` container. A header row with `[ Order entry ]` and a live-quote dot, the
  receipt symbol with its status tag, and the market vol on the right. Then a **bid/ask strip** — two cells, `Bid /
  unit` and `Ask / unit` — because this is a two-sided market and both prices are executable. Then a
  **lifecycle-aware segmented control** over the tabs that can actually transact:
  `Buy · Exit · Redeem · Oracle`. Never render a tab whose only possible outcome is a revert.
  Inside a tab: an amount widget on `--panel-3` gray (small labels "Balance 1,000.00 USDC" / "MAX", huge centered
  amount 40/400 white, a token/units selector chip, a square swap-arrow on the seam between the halves), then
  key-value rows on `--panel-2` cards, then the lime primary button, then one line of `--white/45` footnote saying
  what the transaction actually does. A blocked ticket puts the reason on the button and the detail on its hover.
  - **Buy**: USDC in → receipts out. Rows: Units, Premium, Avg price / unit, Break-even vol, Max payout (at cap),
    Cap, Locked backing.
  - **Exit**: receipts in → USDC out, before expiry. Rows: Bid / unit, Proceeds, P&L vs indexed entry (or an em dash
    when this wallet has no indexed buys), and an explicit "the receipts are burned" disclosure.
  - **Redeem**: receipts in → USDC out at the fixed payout. Rows: Final variance, Payout / unit, Units, USDC out.
    Before finalization the ticket says `Locked until expiry` or `Finalize the variance first` — never an estimate.
  - **Oracle**: `Update the market` and `Finalize`, with `stored / available / total` and the call count. Labelled
    as permissionless, because it is.
- **Segmented control**: rectangular cells, 1px `--line-2`; selected cell `--ink` with white text (like "1D 1W 1M 1Y All").
- **Charts (recharts)**: stroke `--ink` 1.5px for the realized series, the market-quote series `--ink-3` dashed, and
  the executable bid/ask band as a flat `--line-2` fill at ~55% behind both — no gradient, ever; area fill is a
  **diagonal hatch pattern** (SVG pattern, 1px `--ink` lines at 45°, 6px spacing, 35% opacity) — never a gradient.
  Grid `--line`, axis ticks 11px `--ink-3`. Markers are 6px squares. Tooltip: white box, 1px `--ink`, square.
  Allocation bars (locked vs free collateral): solid lime or black segment + hatched remainder (reference "Asset
  Allocation"). Never label anything "coverage": what is shown is a reservation, not an observation.
- **Program viewer**: mono list; each instruction row `[0x04] Extruction` with decoded args in a `--bg-3` block.
  The `Extruction` whose target is Tremor's engine gets a lime left border 2px — everything else is stock SwapVM,
  and the viewer showing that is the point.
- **Empty states**: one line `--ink-3`, centered, with a large hatched circle ornament (the reference's striped ring).
- **Principles/steps cards**: `--bg-2` card, title 20/500, hatched ring ornament, body 16 `--ink-2`, large step numeral outside the card bottom-right.

## Landing (reference structure)
1. Top nav.
2. **Dark hero panel** full-width (not full-bleed; 24px inset, square corners): headline in two lines with the first phrase in lime,
   e.g. "Trade volatility. Not direction." with "Trade volatility." lime; two buttons (white "Browse markets", lime "Write a series");
   right side a floating light-gray trade widget (the real buy ticket in read-only preview mode) tilted 0°, plus a short paragraph bottom-right.
3. Section row `■ Live variance` → three stat tiles (1d/7d/30d realized vol) with hatched mini-bars.
4. Section row `■ Open series` → table.
5. Section row `■ How it works` → four principle cards with numerals 01–04 (write, buy, settle, hedge).
6. Section row `■ Hedge LVR` → allocation-style card with hatched bars + CTA.
7. Footer: hairline, bracketed links, "Built on 1inch Aqua · Base".

## Motion
120ms ease-out; hatch patterns static; no glow; respect reduced motion.
