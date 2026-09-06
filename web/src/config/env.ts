/** Public runtime configuration. All values are inlined at build time by Next. */
export const env = {
  apiUrl: (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/+$/, ""),
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545",
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "31337"),
  subgraphUrl: process.env.NEXT_PUBLIC_TREMOR_SUBGRAPH_URL ?? "",
} as const;
