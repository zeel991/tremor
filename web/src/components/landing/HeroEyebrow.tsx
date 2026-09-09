"use client";

import { useTrailing } from "@/lib/api";
import { fmtVolPct } from "@/lib/format";

/** `[ ETH realized vol · 7d · 50.5% ]` — live from the backend; falls back to the plain tagline. */
export function HeroEyebrow() {
  const trailing = useTrailing("7d");
  return (
    <span className="bracket bracket-light self-start">
      {trailing.data ? (
        <>
          ETH realized vol · 7d · <span className="text-lime">{fmtVolPct(trailing.data.rv)}%</span>
        </>
      ) : (
        "Variance swaps on 1inch Aqua"
      )}
    </span>
  );
}
