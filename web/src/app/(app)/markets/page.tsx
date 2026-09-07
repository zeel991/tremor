import type { Metadata } from "next";
import { SeriesTable } from "@/components/series/SeriesTable";
import { PageHeader } from "@/components/ui/SectionRow";
import { LinkButton } from "@/components/ui/Button";

export const metadata: Metadata = { title: "Markets" };

export default function MarketsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        label="Markets"
        title="Every variance market on this chain"
        body="Market vol is what this market quotes; realized vol is computed on chain from the Chainlink rounds stored so far. Locked backing is the collateral the writer's vault has reserved for the units already sold — it cannot be withdrawn while a claim is live."
        action={
          <LinkButton href="/write" variant="secondary">
            Write a series
          </LinkButton>
        }
      />
      <SeriesTable />
    </div>
  );
}
