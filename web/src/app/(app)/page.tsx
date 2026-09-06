import { LinkButton } from "@/components/ui/Button";
import { SectionRow } from "@/components/ui/SectionRow";
import { Hero } from "@/components/landing/Hero";
import { TrailingTiles } from "@/components/landing/TrailingTiles";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { LvrHook } from "@/components/landing/LvrHook";
import { SlantMarquee } from "@/components/landing/SlantMarquee";
import { SeriesTable } from "@/components/series/SeriesTable";

export default function HomePage() {
  return (
    <div className="flex flex-col gap-20 pb-8">
      <Hero />

      <SlantMarquee variant="market" />

      <SectionRow
        id="live"
        label="Live variance"
        title="What ETH has actually been doing, in three windows."
        body="Trailing realized volatility from Chainlink ETH/USD, the same feed every series settles against. Bars show vol as a share of 100%."
      >
        <TrailingTiles />
      </SectionRow>

      <SectionRow
        id="open"
        label="Open series"
        title="Receipts you can buy right now."
        body="Every market quotes a bid and an ask. The quote rises as inventory sells, falls when holders exit, and decays back to the anchor. Rows are read from the Lens, with fill statistics from the indexer."
        action={
          <LinkButton href="/markets" variant="tertiary">
            All markets
          </LinkButton>
        }
      >
        <SeriesTable compact limit={6} initialSaleOnly />
      </SectionRow>

      <SlantMarquee />

      <SectionRow
        id="how"
        label="How it works"
        title="Three SwapVM strategies. No new pool, no custody of your funds."
        body="Each writer has their own non-upgradeable vault. Every unit sold reserves its capped payout there, and the reservation is released only when the receipt is burned — on exit or on redemption."
      >
        <HowItWorks />
      </SectionRow>

      <SectionRow
        id="lvr"
        label="Hedge LVR"
        title="Loss-versus-rebalancing is a variance bill. Pay it forward."
        body="Estimate gross variance notional from V·σ²·T/8, then compare live receipt cost and capacity. Premium, caps, maturity and oracle basis mean this is not an exact hedge."
      >
        <LvrHook />
      </SectionRow>
    </div>
  );
}
