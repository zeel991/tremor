"use client";

import dynamic from "next/dynamic";
import { useRef } from "react";
import { useTrailing } from "@/lib/api";
import { volPctNumber } from "@/lib/format";
import { useInViewActive, usePrefersReducedMotion } from "./useActive";

const VarianceSurface = dynamic(() => import("./VarianceSurface"), { ssr: false, loading: () => null });

/** Hero backdrop: terrain amplitude is driven by live 7d realized vol, with a 50% fallback. */
export function HeroSurface() {
  const ref = useRef<HTMLDivElement>(null);
  const active = useInViewActive(ref, "100px");
  const reduced = usePrefersReducedMotion();
  const trailing = useTrailing("7d");
  const vol = trailing.data ? volPctNumber(trailing.data.rv) / 100 : 0.5;
  return (
    <div ref={ref} className="hero-3d" aria-hidden="true">
      <VarianceSurface vol={vol} active={active} frozen={reduced} />
    </div>
  );
}
