import type { Metadata } from "next";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { ClientOnly } from "@/components/ui/ClientOnly";
import { Skeleton } from "@/components/ui/Skeleton";
import { PageHeader } from "@/components/ui/SectionRow";

export const metadata: Metadata = { title: "Portfolio" };

export default function PortfolioPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader label="Portfolio" title="Receipts held and series written" body="Live positions are valued at the executable exit bid; finalized ones at the fixed payout per unit. The two are never blended." />
      <ClientOnly
        fallback={
          <div className="grid gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-3 h-10 w-32" />
              </div>
            ))}
          </div>
        }
      >
        <PortfolioView />
      </ClientOnly>
    </div>
  );
}
