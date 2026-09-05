"use client";

import { activeChain } from "@/config/chains";
import { ADDR, deploymentError, isDeployed } from "@/lib/contracts";
import { useRpcOnline } from "@/lib/chain";
import { Banner } from "@/components/ui/Banner";

export function DeploymentBanner() {
  const rpc = useRpcOnline();
  const chainMismatch = ADDR.chainId > 0 && ADDR.chainId !== activeChain.id;
  if (isDeployed && rpc !== false && !chainMismatch) return null;
  return (
    <div className="mb-6 flex flex-col gap-2">
      {!isDeployed ? (
        <Banner tone="warning">
          {deploymentError ? `Deployment configuration is invalid: ${deploymentError}` : <>Contracts are not deployed for <span className="text-ink">{activeChain.name}</span>. Chain reads and transactions are disabled until the verified manifest matches this chain.</>}
        </Banner>
      ) : null}
      {chainMismatch ? (
        <Banner tone="warning">
          deployment.json targets chain {ADDR.chainId} but NEXT_PUBLIC_CHAIN_ID is {activeChain.id}.
        </Banner>
      ) : null}
      {rpc === false ? <Banner tone="negative">RPC unreachable. Live quotes and wallet actions are paused until it is back.</Banner> : null}
    </div>
  );
}
