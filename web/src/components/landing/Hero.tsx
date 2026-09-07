import { Suspense } from "react";
import { LinkButton } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { HeroSurface } from "@/components/three/HeroSurface";
import { HeroTicket } from "./HeroTicket";
import { HeroEyebrow } from "./HeroEyebrow";

/** Dark hero panel: lime variance terrain behind the live buy ticket. */
export function Hero() {
  return (
    <section className="hero bleed hero-bleed" aria-labelledby="hero-title">
      <HeroSurface />
      <div className="hero-shade" aria-hidden="true" />
      <div className="hero-content mx-auto grid w-full max-w-[1280px] gap-10 px-6 pt-10 pb-[calc(2.5rem_+_var(--slant))] md:pt-12 md:pb-[calc(3rem_+_var(--slant))] lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-16">
        <div className="flex min-h-[280px] flex-col justify-between gap-10">
          <HeroEyebrow />
          <div className="flex flex-col gap-7">
            <h1 id="hero-title" className="display max-w-[14ch] text-balance">
              <span className="text-lime">Trade volatility.</span> Not direction.
            </h1>
            <div className="flex flex-wrap gap-3">
              <LinkButton href="/markets" variant="white" size="lg">
                Browse markets
              </LinkButton>
              <LinkButton href="/write" size="lg">
                Write a series
              </LinkButton>
            </div>
          </div>
        </div>
        <div className="flex flex-col justify-between gap-6">
          <Suspense
            fallback={
              <div className="ticket-preview flex flex-col gap-3">
                <Skeleton className="h-[176px] w-full" />
                <Skeleton className="h-[176px] w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            }
          >
            <HeroTicket />
          </Suspense>
          <p className="m-0 max-w-[36ch] text-[14px] leading-5 text-white/70 lg:self-end lg:text-right">
            Buy receipts that pay realized variance, or write them from a vault only you own. Both sides of the market are
            quoted on chain, every unit sold is fully collateralized, and settlement is computed from Chainlink&apos;s own round
            history.
          </p>
        </div>
      </div>
    </section>
  );
}
