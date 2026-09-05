"use client";

import { useState } from "react";
import { explorerAddressUrl, explorerTxUrl } from "@/config/chains";
import { cx, shortAddr, shortHash } from "@/lib/format";
import { IconCheck, IconCopy, IconExternal } from "./Icons";

export function Address({ value, chars = 4, className, full }: { value: string; chars?: number; className?: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  const url = explorerAddressUrl(value);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <span className={cx("mono inline-flex items-center gap-1.5 text-[13px]", className)}>
      <span title={value} className={full ? "break-all" : undefined}>
        {full ? value : shortAddr(value, chars)}
      </span>
      <button type="button" aria-label="Copy address" className="text-ink-3 hover:text-ink" onClick={copy}>
        {copied ? <IconCheck width={14} height={14} className="text-lime-dark" /> : <IconCopy width={14} height={14} />}
      </button>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" aria-label="Open in explorer" className="text-ink-3 hover:text-ink">
          <IconExternal width={14} height={14} />
        </a>
      ) : null}
    </span>
  );
}

export function TxHash({ value, className }: { value: string; className?: string }) {
  const url = explorerTxUrl(value);
  const inner = <span className={cx("mono text-[12.5px]", className)}>{shortHash(value)}</span>;
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline decoration-line-2 underline-offset-2 hover:decoration-current">
      {inner}
      <IconExternal width={12} height={12} />
    </a>
  ) : (
    <span title={value}>{inner}</span>
  );
}
