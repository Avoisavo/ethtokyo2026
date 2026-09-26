import type { Address } from "viem";

/**
 * The one network Petri's paid verification runs on: Ethereum Sepolia with
 * Circle's test USDC. The x402.org facilitator serves only Base Sepolia, so
 * the verifier settles in-process (lib/pay/verifier.ts).
 *
 * Checked on chain on 2026-09-27: the token implements EIP-3009
 * transferWithAuthorization with the EIP-712 domain {name "USDC", version "2"}.
 * The ENS MockUSDC has no transferWithAuthorization, so x402 cannot use it.
 */
export const SEPOLIA = {
  caip2: "eip155:11155111",
  chainId: 11155111,
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address,
  usdcDomain: { name: "USDC", version: "2" },
  /** Intercepta has no testnet data. Its advice is to screen under mainnet. */
  screenChainId: "1",
  explorer: "https://sepolia.etherscan.io",
} as const;

export const DEFAULT_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

export const explorerTx = (hash: string) => `${SEPOLIA.explorer}/tx/${hash}`;
export const explorerAddress = (a: string) => `${SEPOLIA.explorer}/address/${a}`;

/** "0.50" → 500000n. USDC has 6 decimals. */
export function usdcToAtomic(amount: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!m) return null;
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

export const sameAddress = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
