"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { activeChain } from "@/config/chains";
import { cx, shortAddr } from "@/lib/format";
import { useMounted } from "@/lib/hooks";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { IconChevron, IconCopy } from "@/components/ui/Icons";

/** Black "Connect wallet" button; lime with the truncated address when connected. */
export function WalletPill({ compact }: { compact?: boolean }) {
  const mounted = useMounted();
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!mounted) return <Skeleton className={compact ? "h-8 w-28" : "h-10 w-36"} />;

  if (!isConnected || !address) {
    return (
      <Button
        variant="secondary"
        size={compact ? "sm" : "md"}
        loading={isPending}
        onClick={() => {
          const connector = connectors[0];
          if (!connector) return toast.error("No injected wallet found");
          connect(
            { connector, chainId: activeChain.id },
            { onError: (e) => toast.error("Could not connect", e.message) },
          );
        }}
      >
        {compact ? "Connect" : "Connect wallet"}
      </Button>
    );
  }

  const wrongChain = chainId !== activeChain.id;

  return (
    <div className="relative flex items-center gap-2" ref={ref}>
      {wrongChain ? (
        <button
          type="button"
          className="btn btn-tertiary btn-sm"
          disabled={switching}
          onClick={() =>
            switchChain(
              { chainId: activeChain.id },
              { onError: (e) => toast.error("Switch failed", e.message) },
            )
          }
        >
          Switch to {activeChain.name}
        </button>
      ) : null}
      <button
        type="button"
        className={cx("btn btn-primary gap-2", compact && "btn-sm")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sdot" />
        <span className="mono text-[13px]">{shortAddr(address)}</span>
        <IconChevron width={14} height={14} />
      </button>
      {open ? (
        <div role="menu" className="menu absolute right-0 top-full z-30 mt-2 w-56">
          <div className="label px-2.5 py-1.5">Connected · {activeChain.name}</div>
          <button
            role="menuitem"
            className="menu-item"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(address);
                toast.info("Address copied");
              } catch {
                toast.error("Clipboard unavailable");
              }
              setOpen(false);
            }}
          >
            <IconCopy width={16} height={16} /> Copy address
          </button>
          <button
            role="menuitem"
            className="menu-item text-down hover:text-down"
            onClick={() => {
              disconnect();
              setOpen(false);
            }}
          >
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}
