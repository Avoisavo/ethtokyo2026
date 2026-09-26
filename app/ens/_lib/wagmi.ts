import { http, createConfig, injected } from "wagmi";
import { sepolia } from "wagmi/chains";

// ENSv2 is deployed on Sepolia only. Set NEXT_PUBLIC_SEPOLIA_RPC_URL to use
// your own RPC (the public default is rate limited, and getLogs ranges are small).
export const RPC_URL = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

export const config = createConfig({
  chains: [sepolia],
  connectors: [injected()],
  transports: { [sepolia.id]: http(RPC_URL) },
  ssr: true,
});

export const CHAIN_ID = sepolia.id;

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
