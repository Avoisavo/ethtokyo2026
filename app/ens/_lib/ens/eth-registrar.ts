// ETH Registrar helpers (see /ensv2/eth-registrar): contract handles, unit
// formatting, local commitment hashing, and the name lifecycle the registrar
// derives from ETHRegistry.getState().

import {
  type Address,
  type Hex,
  bytesToHex,
  encodeAbiParameters,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  pad,
  zeroAddress,
  zeroHash,
} from "viem";

import { BatchRegistrarAbi } from "./abis/BatchRegistrar";
import { ETHRegistrarAbi } from "./abis/ETHRegistrar";
import { ETHRegistryAbi } from "./abis/ETHRegistry";
import { StandardRentPriceOracleAbi } from "./abis/StandardRentPriceOracle";
import { PAYMENT_TOKENS, addresses } from "./contracts";
import { tryNormalize } from "./names";
import { RegistryRoles } from "./roles";

export const ethRegistrar = { address: addresses.ETHRegistrar, abi: ETHRegistrarAbi } as const;
export const ethRegistry = { address: addresses.ETHRegistry, abi: ETHRegistryAbi } as const;
export const batchRegistrar = { address: addresses.BatchRegistrar, abi: BatchRegistrarAbi } as const;
export const rootBatchRegistrar = { address: addresses.RootBatchRegistrar, abi: BatchRegistrarAbi } as const;

/** The deployed StandardRentPriceOracle. The registrar owner can swap it via setRentPriceOracle(). */
export const standardOracle = { address: addresses.StandardRentPriceOracle, abi: StandardRentPriceOracleAbi } as const;
export const oracleAt = (address: Address) => ({ address, abi: StandardRentPriceOracleAbi }) as const;

export const STATUS = ["AVAILABLE", "RESERVED", "REGISTERED"] as const;
export const Status = { AVAILABLE: 0, RESERVED: 1, REGISTERED: 2 } as const;

export const MINUTE = 60n;
export const HOUR = 3_600n;
export const DAY = 86_400n;
/** The oracle's discount points and the docs use 365-day years. */
export const YEAR = 365n * DAY;

/**
 * StandardRentPriceOracle prices in "standard units". On Sepolia 1 USD = 1e12:
 * USDC's ratio is 1/1e6 (so $8 = 8e12 -> 8_000000), DAI's is 1e6/1, and
 * PREMIUM_PRICE_INITIAL = 1e20 is the documented ~$100M.
 */
export const USD_DECIMALS = 12;
export const ONE_USD = 10n ** BigInt(USD_DECIMALS);

/** Roles the ETH Registrar needs on the .eth registry (granted on ROOT_RESOURCE). */
export const REGISTRAR_ROLES = RegistryRoles.ROLE_REGISTRAR | RegistryRoles.ROLE_RENEW;

export type TokenKey = keyof typeof PAYMENT_TOKENS;
export const TOKEN_KEYS = Object.keys(PAYMENT_TOKENS) as TokenKey[];

export const CIRCLE_FAUCET = "https://faucet.circle.com";

// --- Formatting -------------------------------------------------------------

/** Formats oracle standard units as USD. */
export function formatUsd(value: bigint): string {
  const n = Number(formatUnits(value, USD_DECIMALS));
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toPrecision(3)}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatToken(amount: bigint, token: TokenKey): string {
  const t = PAYMENT_TOKENS[token];
  return `${formatUnits(amount, t.decimals)} ${t.symbol}`;
}

const UNITS: [string, number][] = [
  ["y", 31_536_000],
  ["d", 86_400],
  ["h", 3_600],
  ["m", 60],
  ["s", 1],
];

/** "1y 3d", "4h 2m", "59s": the two most significant units. */
export function formatDuration(seconds: bigint | number, parts = 2): string {
  let n = Math.max(0, Math.floor(Number(seconds)));
  if (n === 0) return "0s";
  const out: string[] = [];
  for (const [unit, size] of UNITS) {
    if (n >= size) {
      out.push(`${Math.floor(n / size)}${unit}`);
      n %= size;
    }
  }
  return out.slice(0, parts).join(" ");
}

/** mm:ss (or h:mm:ss) countdown. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad2 = (v: number) => v.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(m)}:${pad2(s % 60)}`;
}

export function formatTimestamp(ts: bigint | number): string {
  const n = Number(ts);
  if (!n) return "—";
  return `${new Date(n * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export const hex256 = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;

// --- Input parsing ----------------------------------------------------------

/** Parses a .eth label ("alice", "Alice", "alice.eth"); the registrar takes the bare, normalized label. */
export function parseLabel(input: string): { label: string | null; error?: string } {
  const raw = input.trim().replace(/\.eth$/i, "");
  if (!raw) return { label: null, error: "Enter a label, e.g. alice for alice.eth." };
  const normalized = tryNormalize(raw);
  if (normalized === null || normalized === "") return { label: null, error: "Not a valid ENS label (ENSIP-15 normalization failed)." };
  if (normalized.includes(".")) return { label: null, error: "Enter a single label: the registrar only issues second-level .eth names." };
  return { label: normalized };
}

export type DurationUnit = "years" | "days" | "seconds";

export const UNIT_SECONDS: Record<DurationUnit, bigint> = { years: YEAR, days: DAY, seconds: 1n };

/** Parses "1.5" years / "30" days / "2419200" seconds into seconds. */
export function parseDuration(value: string, unit: DurationUnit): bigint | null {
  const s = value.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [int, frac = ""] = s.split(".");
  const scale = 10n ** BigInt(frac.length);
  const seconds = (BigInt(int + frac) * UNIT_SECONDS[unit]) / scale;
  return seconds > 0n && seconds < 2n ** 64n ? seconds : null;
}

/** Empty -> fallback; otherwise a checksummed address or null if invalid. */
export function parseAddressOr(input: string, fallback: Address | undefined): Address | null | undefined {
  const s = input.trim();
  if (!s) return fallback;
  return isAddress(s, { strict: false }) ? getAddress(s) : null;
}

/** Referrer: empty -> bytes32(0); any hex up to 32 bytes (e.g. an address) is left-padded. */
export function parseBytes32(input: string): Hex | null {
  const s = input.trim();
  if (!s) return zeroHash;
  if (!/^0x[0-9a-fA-F]{0,64}$/.test(s)) return null;
  const even = s.length % 2 === 0 ? s : `0x0${s.slice(2)}`;
  return pad(even as Hex, { size: 32 });
}

// --- Commit-reveal ----------------------------------------------------------

export type CommitParams = {
  label: string;
  owner: Address;
  secret: Hex;
  subregistry: Address;
  resolver: Address;
  duration: bigint;
  referrer: Hex;
};

/** Mirrors ETHRegistrar.makeCommitment: keccak256(abi.encode(label, owner, secret, subregistry, resolver, duration, referrer)). */
export function computeCommitment(p: CommitParams): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "address" },
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint64" },
        { type: "bytes32" },
      ],
      [p.label, p.owner, p.secret, p.subregistry, p.resolver, p.duration, p.referrer],
    ),
  );
}

/** A random 32-byte commitment secret. Call from event handlers only. */
export const randomSecret = (): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

// --- Lifecycle --------------------------------------------------------------

export type NameState = {
  status: number;
  expiry: bigint;
  latestOwner: Address;
  tokenId: bigint;
  resource: bigint;
};

export type Phase = "never" | "registered" | "reserved" | "grace" | "expired-reservation" | "premium" | "available";

export const PHASES: Record<Phase, { label: string; tone: "success" | "info" | "warning" | "danger" | "neutral"; description: string }> = {
  never: { label: "Never registered", tone: "success", description: "Available at the base price (no premium)." },
  registered: { label: "Registered", tone: "info", description: "Owned until expiry. Anyone can renew it." },
  reserved: {
    label: "Reserved",
    tone: "neutral",
    description:
      "No owner and no token, e.g. an ENSv1 name pre-migrated by the BatchRegistrar. The ETH Registrar can neither register nor renew it.",
  },
  grace: {
    label: "Grace period",
    tone: "warning",
    description: "Expired but still renewable by anyone (base price only); not yet available for registration.",
  },
  "expired-reservation": {
    label: "Expired reservation (grace)",
    tone: "neutral",
    description: "A reservation expired less than GRACE_PERIOD ago: not available (in grace) and not renewable (no previous owner).",
  },
  premium: {
    label: "Temporary premium",
    tone: "warning",
    description: "Available, but a decaying premium is added to the registration price until PREMIUM_PERIOD after the grace period.",
  },
  available: { label: "Available", tone: "success", description: "Expired long enough ago that no premium applies." },
};

/**
 * The phase the registrar sees, using the same comparisons as
 * ETHRegistrar._checkGrace / _availablePeriod and the oracle's premium window.
 */
export function namePhase(
  state: Pick<NameState, "status" | "expiry" | "latestOwner">,
  now: bigint,
  gracePeriod: bigint,
  premiumPeriod: bigint,
): { phase: Phase; graceEnd?: bigint; premiumEnd?: bigint } {
  const { status, expiry, latestOwner } = state;
  if (status === Status.REGISTERED) return { phase: "registered", graceEnd: expiry + gracePeriod, premiumEnd: expiry + gracePeriod + premiumPeriod };
  if (status === Status.RESERVED) return { phase: "reserved" };
  if (expiry === 0n) return { phase: "never" };
  const graceEnd = expiry + gracePeriod;
  const premiumEnd = graceEnd + premiumPeriod;
  if (now < graceEnd) return { phase: latestOwner !== zeroAddress ? "grace" : "expired-reservation", graceEnd, premiumEnd };
  if (now < premiumEnd) return { phase: "premium", graceEnd, premiumEnd };
  return { phase: "available", graceEnd, premiumEnd };
}

// --- Event history ----------------------------------------------------------

/**
 * Block window per eth_getLogs request. The public Sepolia RPC times out on
 * 50k-block windows for the (busy) registrar, 10k is reliable.
 */
export const LOG_CHUNK = 10_000n;
