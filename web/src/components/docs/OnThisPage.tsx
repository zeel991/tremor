"use client";

import { useEffect, useState } from "react";
import type { DocHeading } from "@/lib/docs";

/** Right rail with h2/h3 anchors; the heading currently in view is highlighted. */
export function OnThisPage({ headings }: { headings: DocHeading[] }) {
  const [active, setActive] = useState<string | undefined>(headings[0]?.id);

  useEffect(() => {
    if (headings.length === 0) return;
    const els = headings.map((h) => document.getElementById(h.id)).filter((x): x is HTMLElement => !!x);
    if (els.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: [0, 1] },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;
  return (
    <nav className="docs-toc" aria-label="On this page">
      <div className="docs-toc-title">On this page</div>
      {headings.map((h) => (
        <a key={h.id} href={`#${h.id}`} className={h.level === 3 ? "docs-toc-sub" : undefined} aria-current={active === h.id ? "location" : undefined}>
          {h.text}
        </a>
      ))}
    </nav>
  );
}
