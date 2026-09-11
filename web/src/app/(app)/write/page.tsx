import type { Metadata } from "next";
import { WriteWizard } from "@/components/write/WriteWizard";
import { ClientOnly } from "@/components/ui/ClientOnly";
import { Skeleton } from "@/components/ui/Skeleton";
import { PageHeader } from "@/components/ui/SectionRow";
import { TestTokenBanner } from "@/components/ui/TestTokenNotice";

export const metadata: Metadata = { title: "Write" };

export default function WritePage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        label="Write"
        title="Open a variance market"
        body="Window, size, price — the other ten parameters derive from them. Your collateral goes into a vault only you own, and the part backing units you have sold cannot come back out until those receipts are burned."
      />
      <TestTokenBanner />
      <ClientOnly
        fallback={
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(360px,1fr)]">
            <div className="card">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="mt-4 h-10 w-full" />
              <Skeleton className="mt-3 h-10 w-full" />
            </div>
            <div className="panel p-4">
              <Skeleton dark className="h-6 w-24" />
              <Skeleton dark className="mt-4 h-40 w-full" />
            </div>
          </div>
        }
      >
        <WriteWizard />
      </ClientOnly>
    </div>
  );
}
