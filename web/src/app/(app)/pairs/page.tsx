import type { Metadata } from "next";
import { GroupTable } from "@/components/pairs/GroupTable";
import { PageHeader } from "@/components/ui/SectionRow";
import { TestTokenBanner } from "@/components/ui/TestTokenNotice";
import { LinkButton } from "@/components/ui/Button";

export const metadata: Metadata = { title: "Paired markets" };

export default function PairsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        label="Paired markets"
        title="Two capped claims, one reserve"
        body="Each risk group backs a HIGH claim (pays more the more variance is realized) and a CALM claim (pays the rest) on the same window. Because the two payouts always sum to the cap payout, the vault reserves max(HIGH, CALM) — not the sum of the caps. Prices are fixed bid/ask quotes set by the writer, not a fair-value volatility model."
        action={
          <LinkButton href="/pairs/new" variant="secondary">
            Write a paired market
          </LinkButton>
        }
      />
      <TestTokenBanner />
      <GroupTable />
    </div>
  );
}
