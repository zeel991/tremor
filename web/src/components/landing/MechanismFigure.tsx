"use client";

import dynamic from "next/dynamic";
import { useRef } from "react";
import { useInViewActive, usePrefersReducedMotion } from "@/components/three/useActive";
import type { MechanismKind } from "@/components/three/MechanismScene";

const MechanismScene = dynamic(() => import("@/components/three/MechanismScene"), {
  ssr: false,
  loading: () => <div className="mechanism-canvas-placeholder" />,
});

const LABELS: Record<MechanismKind, { accessible: string; tags: Array<{ text: string; position: string }> }> = {
  write: {
    accessible: "Writer collateral sits in a protected vault while the issue, exit and settle strategies are shipped to Aqua.",
    tags: [
      { text: "maker vault", position: "mechanism-tag-left" },
      { text: "issue · exit · settle", position: "mechanism-tag-right" },
    ],
  },
  buy: {
    accessible: "Two receipt purchases push the market's quote upward before the inventory skew decays back toward the anchor.",
    tags: [
      { text: "fill", position: "mechanism-tag-fill-one" },
      { text: "fill", position: "mechanism-tag-fill-two" },
      { text: "half-life decay", position: "mechanism-tag-right" },
    ],
  },
  settle: {
    accessible: "Chainlink price samples become squared returns, are annualized, and flow through a payout cap.",
    tags: [
      { text: "oracle samples", position: "mechanism-tag-left" },
      { text: "Σ r²", position: "mechanism-tag-center" },
      { text: "capped USDC", position: "mechanism-tag-right" },
    ],
  },
  hedge: {
    accessible: "A balance compares an LP's estimated loss-versus-rebalancing with a capped variance receipt position.",
    tags: [
      { text: "estimated LVR", position: "mechanism-tag-left" },
      { text: "hedge sizing", position: "mechanism-tag-center" },
      { text: "capped variance payout", position: "mechanism-tag-right" },
    ],
  },
};

export function MechanismFigure({ kind }: { kind: MechanismKind }) {
  const ref = useRef<HTMLDivElement>(null);
  const active = useInViewActive(ref, "160px");
  const reduced = usePrefersReducedMotion();
  const labels = LABELS[kind];
  return (
    <div ref={ref} className={`mechanism-figure mechanism-figure-${kind}`} role="img" aria-label={labels.accessible}>
      <MechanismScene kind={kind} active={active} frozen={reduced} />
      <div className="mechanism-tags" aria-hidden="true">
        {labels.tags.map((tag) => (
          <span key={`${tag.text}-${tag.position}`} className={`mechanism-tag ${tag.position}`}>{tag.text}</span>
        ))}
      </div>
    </div>
  );
}
