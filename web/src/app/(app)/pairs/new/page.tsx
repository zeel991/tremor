import type { Metadata } from "next";
import { CreateGroupForm } from "@/components/pairs/CreateGroupForm";
import { ClientOnly } from "@/components/ui/ClientOnly";
import { Skeleton } from "@/components/ui/Skeleton";
import { PageHeader } from "@/components/ui/SectionRow";

export const metadata: Metadata = { title: "Write a paired market" };

export default function NewPairPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        label="Paired markets"
        title="Write a paired market"
        body="One window, one cap, two complementary claims. Your collateral goes into a vault only you own; the reserve behind sold receipts cannot come back out until those receipts are burned. The four quotes below are fixed bid/ask prices you set — not a fair-value volatility model."
      />
      <ClientOnly
        fallback={
          <div className="card">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="mt-4 h-10 w-full" />
          </div>
        }
      >
        <CreateGroupForm />
      </ClientOnly>
    </div>
  );
}
