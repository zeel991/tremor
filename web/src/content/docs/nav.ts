/** Docs navigation: groups → pages. Order here defines sidebar order and prev/next. */
export interface DocPageMeta {
  slug: string;
  title: string;
  description: string;
}
export interface DocGroup {
  slug: string;
  title: string;
  pages: DocPageMeta[];
}

export const DOCS_NAV: DocGroup[] = [
  {
    slug: "about",
    title: "About Tremor",
    pages: [
      {
        slug: "architecture",
        title: "Architecture",
        description: "What Tremor is, how it sits on the official 1inch Aqua and SwapVM contracts, and what is deployed.",
      },
      {
        slug: "why-variance",
        title: "Why variance, not options",
        description: "One number, settled from immutable history, with a capped promise a vault can fully back.",
      },
      {
        slug: "trust-surface",
        title: "Trust surface and caveats",
        description: "What settlement depends on, what a writer can and cannot do, and what we refuse to claim.",
      },
    ],
  },
  {
    slug: "mechanics",
    title: "Market mechanics",
    pages: [
      { slug: "series-parameters", title: "Series parameters", description: "Every SeriesParams field, its type and what it controls." },
      {
        slug: "market-quote",
        title: "The two-sided quote",
        description: "Inventory skew, projected variance, the bid/ask band and integral fill pricing.",
      },
      { slug: "collateral", title: "Collateral and the vault", description: "Reservations, what a writer cannot do, and what releases collateral." },
      { slug: "realized-variance", title: "Realized variance", description: "Sampling grid, phase-aware Chainlink search and annualization." },
      {
        slug: "checkpoints",
        title: "Checkpoints and finalization",
        description: "Bounded permissionless observation, why nobody pays for the whole window, and how the payout is fixed.",
      },
      { slug: "settlement", title: "Exit, redemption and payoff", description: "The two burn paths, the cap, payoutPerUnit and rounding." },
      { slug: "lifecycle", title: "Status and lifecycle", description: "Upcoming → Live → Finalizing → Finalized → Closed, and who can do what in each." },
    ],
  },
  {
    slug: "programs",
    title: "SwapVM programs",
    pages: [
      {
        slug: "market-engine",
        title: "TremorMarketEngine",
        description: "The Extruction target that prices all three legs, and the arguments that select the leg.",
      },
      { slug: "program-layouts", title: "Program layouts", description: "The three programs byte for byte, MakerTraits, and the hash identity." },
      {
        slug: "official-router",
        title: "Running on the official router",
        description: "Why v2 has no custom opcodes, and the compatibility evidence for that claim.",
      },
    ],
  },
  {
    slug: "guides",
    title: "Guides",
    pages: [
      { slug: "write", title: "Write a series", description: "Fund a maker vault and open a two-sided market from it." },
      { slug: "buy", title: "Buy receipts", description: "Pay USDC at the executable ask." },
      { slug: "exit", title: "Exit before expiry", description: "Sell receipts back to the market at the executable bid." },
      { slug: "oracle", title: "Update and finalize", description: "Walk the observation window forward and fix the payout. Anyone can." },
      { slug: "redeem", title: "Redeem at expiry", description: "Receipts → USDC at the final realized variance." },
      { slug: "hedge-lvr", title: "Hedge LVR", description: "Size variance units against an LP's expected loss-versus-rebalancing." },
      { slug: "run-locally", title: "Run locally", description: "Anvil fork of Base, demo.sh, the Rust backend and the web app." },
    ],
  },
  {
    slug: "reference",
    title: "Reference",
    pages: [
      { slug: "abi", title: "Contract ABI notes", description: "Who approves whom, taker data, and the Lens SeriesState field order." },
      { slug: "api", title: "API endpoints", description: "The backend read model on :8787." },
      { slug: "deployments", title: "Deployments", description: "Addresses for the active chain and the reference deployment." },
      { slug: "faq", title: "FAQ", description: "Short answers to the questions we get asked most." },
    ],
  },
];

export const DOCS_HOME = "/docs/about/architecture";
