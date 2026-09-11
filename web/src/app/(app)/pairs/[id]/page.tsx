import type { Metadata } from "next";
import { Suspense } from "react";
import { GroupDetail } from "@/components/pairs/GroupDetail";
import { Skeleton } from "@/components/ui/Skeleton";
import { TestTokenBanner } from "@/components/ui/TestTokenNotice";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Paired market #${id}` };
}

export default async function PairPage({ params }: Props) {
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
        <GroupDetail idStr={id} />
      </Suspense>
    </div>
  );
}
