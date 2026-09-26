import "server-only";

import { isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { DEFAULT_SEPOLIA_RPC, usdcToAtomic } from "./network";

/**
 * Settings for paid verification. Two roles run in this one app:
 *
 *   - the Petri agent (payer): holds Sepolia USDC and pays a verifier over x402
 *   - the verifier (seller):   sells a `petri verify` run and settles in-process
 *
 * Keys stay on the server. The page receives addresses and names only.
 */

type Problem = { name: string; issue: string; fix: string };

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/** MetaMask exports a key without 0x. Accept both. */
const privateKey = (name: string): string | undefined => {
  const raw = process.env[name]?.trim();
  return raw && /^[0-9a-fA-F]{64}$/.test(raw) ? `0x${raw}` : raw;
};

export const DEFAULT_ROGUE_PAY_TO = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96";

export function sepoliaRpcUrl(): string {
  return process.env.PETRI_X402_RPC_URL?.trim() || process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL?.trim() || DEFAULT_SEPOLIA_RPC;
}

function usdc(name: string, fallback: string, problems: Problem[]): bigint {
  const raw = process.env[name]?.trim() || fallback;
  const v = usdcToAtomic(raw);
  if (v === null) {
    problems.push({ name, issue: `"${raw}" is not a USDC amount.`, fix: `Use a decimal like ${fallback}.` });
    return 0n;
  }
  return v;
}

function seconds(name: string, fallback: number, problems: Problem[]): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 30) {
    problems.push({ name, issue: `"${raw}" is not a whole number of seconds (30 or more).`, fix: `Use ${fallback}.` });
    return fallback;
  }
  return n;
}

/* ------------------------------------------------------------------ payer */

export type PayerConfig = {
  key: Hex;
  address: Address;
  /** PETRI_PAY_MAX_USD: Petri refuses any single fee above this. */
  maxAtomic: bigint;
  /** PETRI_PAY_MAX_VALIDITY_S: the longest an authorization Petri signs stays valid. */
  maxValiditySeconds: number;
  rpcUrl: string;
};

export type PayerConfigResult = { ok: true; config: PayerConfig } | { ok: false; problems: Problem[] };

export function getPayerConfig(): PayerConfigResult {
  const problems: Problem[] = [];
  const key = privateKey("PETRI_PAY_PRIVATE_KEY");
  if (!key || !PRIVATE_KEY.test(key)) {
    problems.push({
      name: "PETRI_PAY_PRIVATE_KEY",
      issue: key ? "Not 64 hex characters (with or without 0x)." : "Not set.",
      fix: "A throwaway key holding Sepolia USDC from faucet.circle.com. It needs no ETH. Server-side only.",
    });
  }
  const maxAtomic = usdc("PETRI_PAY_MAX_USD", "0.50", problems);
  const maxValiditySeconds = seconds("PETRI_PAY_MAX_VALIDITY_S", 300, problems);
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      key: key as Hex,
      address: privateKeyToAccount(key as Hex).address,
      maxAtomic,
      maxValiditySeconds,
      rpcUrl: sepoliaRpcUrl(),
    },
  };
}

/* --------------------------------------------------------------- verifier */

export type VerifierConfig = {
  /** Pays the gas for transferWithAuthorization. Needs Sepolia ETH. */
  relayerKey: Hex;
  relayerAddress: Address;
  /** Where the honest verifier is paid. Defaults to the relayer's address. */
  payTo: Address;
  feeAtomic: bigint;
  /** maxTimeoutSeconds in the 402. It covers the ~22 s verify and the settle. */
  timeoutSeconds: number;
  /** PETRI_HOME of the verifier's ed25519 Petri key. Needed only for the honest verifier's work. */
  petriHome: string | null;
  screenPayer: boolean;
  rogue: { payTo: Address };
  greedy: { feeAtomic: bigint };
  rpcUrl: string;
};

export type VerifierConfigResult = { ok: true; config: VerifierConfig } | { ok: false; problems: Problem[] };

export function getVerifierConfig(): VerifierConfigResult {
  const problems: Problem[] = [];
  const relayerKey = privateKey("PETRI_X402_RELAYER_KEY");
  if (!relayerKey || !PRIVATE_KEY.test(relayerKey)) {
    problems.push({
      name: "PETRI_X402_RELAYER_KEY",
      issue: relayerKey ? "Not 64 hex characters (with or without 0x)." : "Not set.",
      fix: "A throwaway key with a little Sepolia ETH. The verifier uses it to settle payments. Server-side only.",
    });
  }
  const payToRaw = process.env.PETRI_VERIFIER_PAY_TO?.trim();
  if (payToRaw && !isAddress(payToRaw)) {
    problems.push({ name: "PETRI_VERIFIER_PAY_TO", issue: "Not an EVM address.", fix: "0x + 40 hex, or leave it empty to use the relayer's address." });
  }
  const rogueRaw = process.env.PETRI_DEMO_ROGUE_PAY_TO?.trim() || DEFAULT_ROGUE_PAY_TO;
  if (!isAddress(rogueRaw)) {
    problems.push({ name: "PETRI_DEMO_ROGUE_PAY_TO", issue: "Not an EVM address.", fix: `Use a known-risk mainnet address, e.g. ${DEFAULT_ROGUE_PAY_TO}.` });
  }
  const screen = process.env.PETRI_VERIFIER_SCREEN_PAYER?.trim() || "on";
  if (screen !== "on" && screen !== "off") {
    problems.push({ name: "PETRI_VERIFIER_SCREEN_PAYER", issue: `"${screen}" is not on or off.`, fix: "Use on (default) or off." });
  }
  const feeAtomic = usdc("PETRI_VERIFIER_FEE_USDC", "0.01", problems);
  const greedyFee = usdc("PETRI_DEMO_GREEDY_FEE_USDC", "0.75", problems);
  const timeoutSeconds = seconds("PETRI_VERIFIER_TIMEOUT_S", 300, problems);
  if (problems.length > 0) return { ok: false, problems };

  const relayerAddress = privateKeyToAccount(relayerKey as Hex).address;
  return {
    ok: true,
    config: {
      relayerKey: relayerKey as Hex,
      relayerAddress,
      payTo: (payToRaw as Address | undefined) ?? relayerAddress,
      feeAtomic,
      timeoutSeconds,
      petriHome: process.env.PETRI_VERIFIER_HOME?.trim() || null,
      screenPayer: screen === "on",
      rogue: { payTo: rogueRaw as Address },
      greedy: { feeAtomic: greedyFee },
      rpcUrl: sepoliaRpcUrl(),
    },
  };
}
