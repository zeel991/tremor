"use client";

import { useState } from "react";
import { IconCheck, IconCopy } from "@/components/ui/Icons";

/** Copies the page as markdown. */
export function CopyButton({ markdown }: { markdown: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="docs-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(markdown);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      aria-label="Copy page as markdown"
    >
      {done ? <IconCheck width={14} height={14} /> : <IconCopy width={14} height={14} />}
      {done ? "Copied" : "Copy"}
    </button>
  );
}
