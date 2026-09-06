import { defineChain, type Chain } from "viem";
import { env } from "./env";

/**
 * Chain definitions are declared locally (not imported from the `viem/chains` barrel) so the
 * bundle does not pull every chain definition — the barrel drags `ox/tempo` in with a dynamic
 * require that webpack flags as a critical dependency.
 */

/** Anvil fork of Base mainnet (see ARCHITECTURE.md §0). */
export const tremorFork = defineChain({
  id: 31337,
  name: "Tremor Fork",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.chainId === 31337 ? env.rpcUrl : "http://127.0.0.1:8545"] } },
  contracts: { multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11" } },
  testnet: true,
});

export const baseSepolia = defineChain({
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.chainId === 84532 ? env.rpcUrl : "https://sepolia.base.org"] } },
  blockExplorers: { default: { name: "Basescan", url: "https://sepolia.basescan.org", apiUrl: "https://api-sepolia.basescan.org/api" } },
  contracts: { multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11", blockCreated: 1059647 } },
  testnet: true,
});

export const base = defineChain({
  id: 8453,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.chainId === 8453 ? env.rpcUrl : "https://mainnet.base.org"] } },
  blockExplorers: { default: { name: "Basescan", url: "https://basescan.org", apiUrl: "https://api.basescan.org/api" } },
  contracts: { multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11", blockCreated: 5022 } },
});

export const chains = [tremorFork, baseSepolia, base] as const satisfies readonly [Chain, ...Chain[]];
export type SupportedChain = (typeof chains)[number];
export type SupportedChainId = SupportedChain["id"];

export function chainById(id: number): SupportedChain | undefined {
  return chains.find((c) => c.id === id);
}

/** The chain the UI reads from and asks the wallet to use. */
export const activeChain: SupportedChain = chainById(env.chainId) ?? tremorFork;

export function explorerTxUrl(hash: string): string | undefined {
  const url = activeChain.blockExplorers?.default.url;
  return url ? `${url}/tx/${hash}` : undefined;
}

export function explorerAddressUrl(address: string): string | undefined {
  const url = activeChain.blockExplorers?.default.url;
  return url ? `${url}/address/${address}` : undefined;
}
