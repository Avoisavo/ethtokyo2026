import { type Hex, type PublicClient, createPublicClient, decodeFunctionResult, getAddress, http, size } from "viem";
import { sepolia } from "viem/chains";

import { UniversalResolverV2Abi } from "../../app/ens/_lib/ens/abis/UniversalResolverV2";
import { UNIVERSAL_RESOLVER_PROXY } from "../../app/ens/_lib/ens/contracts";
import { dnsEncode, namehash, tryNormalize } from "../../app/ens/_lib/ens/names";
import {
  decodeMulticall, decodeUrError, encodeMulticall, encodeRecordCall, isZero, resolverProfileAbi, shortError,
} from "../../app/ens/_lib/ens/universal-resolver-v2";
import { ENS_SUFFIX } from "./name";
import { ALL_RECORD_KEYS, type EnsLookup } from "./records";

/**
 * Reads a version's text records through the ENSv2 Universal Resolver on Sepolia.
 *
 * One UR call per name: resolve(name, multicall(text(node, key)…)). The UR
 * finds the nearest resolver (for a version name that is the one on petri.eth,
 * called as a wildcard) and returns every answer at once.
 *
 * The client packs the calls that are in flight together into one Multicall3
 * eth_call. The public RPC rate-limits parallel requests: 8 separate eth_calls
 * fail about half the time, one aggregate does not. Each call still gets its
 * own result or revert data back.
 *
 * Plain module, no "server-only": the /api/ens/records route and the publish
 * script both import it.
 */

/** Same default as the /ens pages (app/ens/_lib/wagmi.ts), which this cannot import: it pulls in wagmi. */
export const SEPOLIA_RPC_URL = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

const clients = new Map<string, PublicClient>();

/** A read client for Sepolia, one per RPC URL. */
export function sepoliaClient(rpcUrl = SEPOLIA_RPC_URL): PublicClient {
  let client = clients.get(rpcUrl);
  if (!client) {
    client = createPublicClient({
      chain: sepolia,
      // Room for CONCURRENCY names of ALL_RECORD_KEYS (about 4 KB of calldata each) in one aggregate.
      batch: { multicall: { batchSize: 64 * 1024 } },
      // viem's default 3 retries back off on a rate-limit answer.
      transport: http(rpcUrl, { timeout: 15_000 }),
    }) as PublicClient;
    clients.set(rpcUrl, client);
  }
  return client;
}

/** UR reverts that mean the name has no resolver on its path: nothing is published there. */
const NO_RESOLVER = new Set(["ResolverNotFound", "ResolverNotContract"]);
/** UR reverts that mean the resolver did not take the batch, so each key is read on its own. */
const NO_BATCH = new Set(["UnsupportedResolverProfile", "ResolverError"]);

const MAX_NAMES = 64;
const MAX_NAME_LENGTH = 255;
const CONCURRENCY = 8;

const inSuffix = (name: string) => name === ENS_SUFFIX || name.endsWith(`.${ENS_SUFFIX}`);

/**
 * Validates `?names=a,b,c` for the route. Only names under the suffix pass,
 * so the route cannot be used as an open ENS proxy.
 */
export function parseNamesParam(raw: string | null | undefined): { ok: true; names: string[] } | { ok: false; error: string } {
  const names = [...new Set((raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (names.length === 0) return { ok: false, error: "names is required: a comma-separated list of ENS names" };
  if (names.length > MAX_NAMES) return { ok: false, error: `at most ${MAX_NAMES} names per request` };
  for (const name of names) {
    if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `name longer than ${MAX_NAME_LENGTH} characters` };
    // Checked again after normalization, which is what the lookup uses.
    const normalized = tryNormalize(name);
    if (!inSuffix(name) || (normalized !== null && !inSuffix(normalized))) {
      return { ok: false, error: `${name} is not under ${ENS_SUFFIX}` };
    }
  }
  return { ok: true, names };
}

/** One text answer. An unset key, a failed inner call or an undecodable answer all read as unset. */
function textOf(data: Hex | undefined): string | null {
  // An answer of 4 + 32n bytes is revert data, not an ABI-encoded string (which is always 32n).
  if (!data || data === "0x" || size(data) % 32 === 4) return null;
  try {
    const s = decodeFunctionResult({ abi: resolverProfileAbi, functionName: "text", data });
    return s === "" ? null : s;
  } catch {
    return null;
  }
}

const unset = (keys: readonly string[]): Record<string, string | null> => Object.fromEntries(keys.map((k) => [k, null]));

type UrAnswer = { ok: true; data: Hex; resolver: string | null } | { ok: false; error: unknown };
type Reader = Pick<PublicClient, "readContract">;

async function urResolve(client: Reader, name: string, data: Hex): Promise<UrAnswer> {
  try {
    const [result, resolver] = await client.readContract({
      address: UNIVERSAL_RESOLVER_PROXY,
      abi: UniversalResolverV2Abi,
      functionName: "resolve",
      args: [dnsEncode(name), data],
    });
    return { ok: true, data: result, resolver: isZero(resolver) ? null : getAddress(resolver) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** The UR's custom error name, or null for anything else (RPC down, timeout, bad response). */
const urErrorName = (e: unknown): string | null => decodeUrError(e)?.name ?? null;

async function lookup(client: Reader, input: string, keys: readonly string[]): Promise<EnsLookup> {
  const name = tryNormalize(input);
  if (name === null) return { name: input, resolver: null, texts: {}, error: "invalid name" };
  const node = namehash(name);
  const calls = keys.map((key) => encodeRecordCall({ kind: "text", key }, node));

  const batch = await urResolve(client, name, encodeMulticall(calls));
  if (batch.ok) {
    try {
      const answers = decodeMulticall(batch.data);
      if (answers.length === keys.length) {
        return { name: input, resolver: batch.resolver, texts: Object.fromEntries(keys.map((k, i) => [k, textOf(answers[i])])) };
      }
    } catch {
      // Not a bytes[]: the resolver answered the batch in its own way. Read each key below.
    }
  } else {
    const err = urErrorName(batch.error);
    if (err !== null && NO_RESOLVER.has(err)) return { name: input, resolver: null, texts: unset(keys) };
    if (err === null || !NO_BATCH.has(err)) return { name: input, resolver: null, texts: {}, error: shortError(batch.error) };
  }

  // Fallback: one resolve() per key.
  const texts: Record<string, string | null> = {};
  let resolver: string | null = null;
  for (const [i, key] of keys.entries()) {
    const one = await urResolve(client, name, calls[i]);
    if (one.ok) {
      resolver ??= one.resolver;
      texts[key] = textOf(one.data);
      continue;
    }
    const err = urErrorName(one.error);
    if (err !== null && NO_RESOLVER.has(err)) return { name: input, resolver: null, texts: unset(keys) };
    if (err === null) return { name: input, resolver: null, texts: {}, error: shortError(one.error) };
    texts[key] = null;
  }
  return { name: input, resolver, texts };
}

/**
 * Text records for each name, in input order. A name with no resolver on its
 * path comes back with `resolver: null` and every key unset: nothing is
 * published there yet. A failed RPC comes back with `error` and empty `texts`.
 */
export async function resolveRecords(
  names: string[],
  /** `client` replaces the Sepolia client, for tests. It only needs readContract. */
  opts: { keys?: readonly string[]; rpcUrl?: string; client?: Reader } = {},
): Promise<EnsLookup[]> {
  const client = opts.client ?? sepoliaClient(opts.rpcUrl);
  const keys = opts.keys ?? ALL_RECORD_KEYS;
  const out = new Array<EnsLookup>(names.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < names.length; i = next++) out[i] = await lookup(client, names[i], keys);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, worker));
  return out;
}
