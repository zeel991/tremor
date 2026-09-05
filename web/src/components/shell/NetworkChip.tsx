"use client";

import { activeChain } from "@/config/chains";
import { useApiOnline } from "@/lib/api";
import { useRpcOnline } from "@/lib/chain";
import { isDeployed } from "@/lib/contracts";
import { cx } from "@/lib/format";

function Dot({ state, label }: { state: boolean | undefined; label: string }) {
  const color = state === undefined ? "text-ink-3" : state ? "text-lime-dark" : "text-down";
  const text = state === undefined ? "checking" : state ? "online" : "offline";
  return (
    <span className={cx("inline-flex items-center gap-1", color)} title={`${label} ${text}`} aria-label={`${label} ${text}`}>
      <span className="sdot" />
      <span className="micro !text-current">{label}</span>
    </span>
  );
}

/** `[ Tremor Fork ]` + RPC / API square dots. */
export function NetworkChip({ className }: { className?: string }) {
  const rpc = useRpcOnline();
  const api = useApiOnline();
  return (
    <div className={cx("items-center gap-3", className)}>
      <span className="bracket bracket-muted">{activeChain.name}</span>
      <Dot state={rpc} label="RPC" />
      <Dot state={api} label="API" />
      {!isDeployed ? <span className="tag tag-dim">not deployed</span> : null}
    </div>
  );
}
