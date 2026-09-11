import type { Metadata } from "next";
import { Suspense } from "react";
import { SeriesDetail } from "@/components/series/SeriesDetail";
import { Skeleton } from "@/components/ui/Skeleton";
import { TestTokenBanner } from "@/components/ui/TestTokenNotice";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Series #${id}` };
}

export default async function SeriesPage({ params }: Props) {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-6">
      <TestTokenBanner />
      <Suspense
        fallback={
          <div className="card">
            <Skeleton className="h-8 w-48" />
          </div>
        }
      >
        <SeriesDetail idStr={id} />
      </Suspense>
    </div>
  );
}
