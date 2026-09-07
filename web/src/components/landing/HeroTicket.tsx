"use client";

import { useSeriesList } from "@/lib/hooks";
import { canBuy, Status } from "@/lib/series";
import { BuyTicketPreview } from "@/components/series/BuyTicket";
import { ClientOnly } from "@/components/ui/ClientOnly";
import { Skeleton } from "@/components/ui/Skeleton";
import { Ring } from "@/components/ui/Hatch";

function TicketSkeleton() {
  return (
    <div className="ticket-preview flex w-full flex-col gap-3">
      <Skeleton className="h-[176px] w-full" />
      <Skeleton className="h-[176px] w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

function LiveTicket() {
  const { data, isLoading } = useSeriesList();
  const s =
    (data ?? []).find((x) => canBuy(x)) ??
    (data ?? []).find((x) => x.status === Status.Live || x.status === Status.Upcoming) ??
    data?.[0];

  if (isLoading || (!s && data === undefined)) return <TicketSkeleton />;
  if (!s) {
    return (
      <div className="ticket-preview flex w-full flex-col items-center gap-4 py-10 text-center">
        <Ring size="sm" />
        <p className="m-0 text-[13px] text-ink-3">No series yet. Write the first one and the ticket appears here.</p>
      </div>
    );
  }
  return (
    <div className="w-full">
      <BuyTicketPreview s={s} />
    </div>
  );
}

/** The real buy ticket, in read-only preview mode, floating in the hero. Client-only to keep hydration exact. */
export function HeroTicket() {
  return (
    <ClientOnly fallback={<TicketSkeleton />}>
      <LiveTicket />
    </ClientOnly>
  );
}
