// Helpers for the Mutable Token IDs playground (see /ensv2/mutable-token-ids).
//
// Source of truth: PermissionedRegistry.sol @ contracts-v2 71a3b73.
//   _entry(anyId)            = _entries[anyId ^ uint32(anyId)]
//   _constructTokenId(id, e) = withVersion(id, e.tokenVersionId)
//   _constructResource(id,e) = withVersion(id, expired ? e.eacVersionId + 1 : e.eacVersionId)

import {
  type Address,
  type Hex,
  type Log,
  type LogTopic,
  type PublicClient,
  bytesToHex,
  formatLog,
  getAddress,
  keccak256,
  numberToHex,
  parseEventLogs,
  slice,
  toEventSelector,
  toHex,
  zeroAddress,
} from "viem";

import { ETHRegistryAbi } from "./abis/ETHRegistry";
import { ENSV2_SEPOLIA } from "./deployments";
import { canonicalId, versionOf, withVersion } from "./names";
import { REGISTRY_ROLE_TABLE, type RoleInfo, toHex256 } from "./roles";

// --- State decoding ---------------------------------------------------------

export const STATUS_NAMES = ["AVAILABLE", "RESERVED", "REGISTERED"] as const;

export type NameState = {
  status: number;
  expiry: bigint;
  latestOwner: Address;
  tokenId: bigint;
  resource: bigint;
};

export type Counters = {
  canonical: bigint;
  tokenVersionId: number;
  /** Stored counter. getState().resource is one ahead of it while the name is expired. */
  eacVersionId: number;
  /** Version encoded in getState().resource. */
  resourceVersion: number;
  /** status == AVAILABLE, i.e. block.timestamp >= expiry (or never registered). */
  expired: boolean;
};

export function decodeCounters(state: NameState): Counters {
  const expired = state.status === 0;
  const resourceVersion = versionOf(state.resource);
  return {
    canonical: canonicalId(state.tokenId),
    tokenVersionId: versionOf(state.tokenId),
    eacVersionId: expired ? resourceVersion - 1 : resourceVersion,
    resourceVersion,
    expired,
  };
}

/** 64 hex chars split into the shared upper 224 bits and the versioned lower 32 bits. */
export function splitId(id: bigint): { upper: string; lower: string } {
  const hex = id.toString(16).padStart(64, "0");
  return { upper: hex.slice(0, 56), lower: hex.slice(56) };
}

export const formatExpiry = (expiry: bigint) =>
  expiry === 0n
    ? "never set"
    : expiry >= 0xffffffffffffffffn - 0x100000000n
      ? "≈ max uint64 (never expires)"
      : new Date(Number(expiry) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";

// --- Roles ------------------------------------------------------------------

/** Regular roles that can be granted on a token resource (admin roles only at registration). */
export const TOKEN_GRANTABLE_ROLES: RoleInfo[] = REGISTRY_ROLE_TABLE.filter(
  (r) => r.scope === "root-or-token" && r.name !== "ROLE_CAN_TRANSFER",
);

/**
 * PermissionedRegistry._getSettableRoles on a token resource: the regular roles
 * whose admin role the caller holds (token roles OR root roles), and only while
 * the name is registered. Revocable roles use the same admin bits.
 */
export const canAdminister = (effectiveRoles: bigint, role: bigint) => ((effectiveRoles >> 128n) & role) === role;

/** Deterministic, keyless address to use as a throwaway grantee. */
export function throwawayAddress(seed: string): Address {
  return getAddress(slice(keccak256(toHex(`ensv2-playground:throwaway:${seed}`)), 12));
}

export function randomAddress(): Address {
  return getAddress(bytesToHex(crypto.getRandomValues(new Uint8Array(20))));
}

// --- History ----------------------------------------------------------------

const parseRegistryLogs = (logs: Log[]) => parseEventLogs({ abi: ETHRegistryAbi, logs, strict: true });

export type RegistryLog = ReturnType<typeof parseRegistryLogs>[number];

type RegistryEventName = RegistryLog["eventName"];

type RegistryEventItem = Extract<(typeof ETHRegistryAbi)[number], { type: "event" }>;

const sel = (name: RegistryEventName): Hex => {
  const item = ETHRegistryAbi.find((x): x is RegistryEventItem => x.type === "event" && x.name === name);
  if (!item) throw new Error(`Unknown event ${name}`);
  return toEventSelector(item);
};

/** Events whose first indexed topic is the token ID (or resource for EACRolesChanged). */
const TOPIC1_ID_EVENTS: RegistryEventName[] = [
  "LabelRegistered",
  "LabelReserved",
  "LabelUnregistered",
  "TokenRegenerated",
  "TokenResource",
  "ExpiryUpdated",
  "ResolverUpdated",
  "SubregistryUpdated",
  "EACRolesChanged",
];

/** Canonical-ID match for any registry log; TransferSingle/Batch carry the ID in data. */
export function logMatches(log: RegistryLog, canonical: bigint): boolean {
  switch (log.eventName) {
    case "LabelRegistered":
    case "LabelReserved":
    case "LabelUnregistered":
    case "TokenResource":
    case "ExpiryUpdated":
    case "ResolverUpdated":
    case "SubregistryUpdated":
      return canonicalId(log.args.tokenId) === canonical;
    case "TokenRegenerated":
      return canonicalId(log.args.oldTokenId) === canonical;
    case "EACRolesChanged":
      return log.args.resource !== 0n && canonicalId(log.args.resource) === canonical;
    case "TransferSingle":
      return canonicalId(log.args.id) === canonical;
    case "TransferBatch":
      return log.args.ids.some((id) => canonicalId(id) === canonical);
    default:
      return false;
  }
}

export type HistoryMode = "scan" | "topics";

/** RPC topic-OR lists get rejected when huge; beyond this we fall back to scanning. */
export const MAX_TOPIC_IDS = 100;

export const MAX_LOG_RANGE = 50_000n;

const MIN_DEPLOY_BLOCK = Object.values(ENSV2_SEPOLIA).reduce<bigint>(
  (min, d) => (d.deployBlock !== undefined && d.deployBlock < min ? d.deployBlock : min),
  ENSV2_SEPOLIA.ETHRegistry.deployBlock,
);

/** Deploy block of a known registry, else the earliest ENSv2 deploy block. */
export function defaultFromBlock(registry: Address): bigint {
  const d = Object.values(ENSV2_SEPOLIA).find((x) => x.address.toLowerCase() === registry.toLowerCase());
  return d?.deployBlock ?? MIN_DEPLOY_BLOCK;
}

export type HistoryQuery = {
  registry: Address;
  labelhash: bigint;
  /** Current tokenVersionId; every token ID/resource ever used is withVersion(canonical, 0..n). */
  tokenVersionId: number;
  mode: HistoryMode;
  /** scan mode: also fetch EACRolesChanged / ResolverUpdated / SubregistryUpdated (large). */
  includeRoleEvents: boolean;
  /** Fetch ERC1155 TransferSingle/TransferBatch (ID in data, always filtered client-side). */
  includeTransfers: boolean;
  fromBlock: bigint;
  toBlock: bigint;
};

export type HistoryProgress = { done: bigint; total: bigint; received: number; requests: number };

export type HistoryResult = {
  logs: RegistryLog[];
  /** Logs returned by the RPC before client-side canonicalId filtering. */
  received: number;
  requests: number;
  mode: HistoryMode;
  filters: string[];
};

type Filter = { label: string; topics: LogTopic[] };

function planFilters(q: HistoryQuery): { mode: HistoryMode; filters: Filter[] } {
  const canonical = canonicalId(q.labelhash);
  const filters: Filter[] = [];
  let mode = q.mode;
  if (mode === "topics" && q.tokenVersionId + 1 > MAX_TOPIC_IDS) mode = "scan";

  if (mode === "topics") {
    const ids = Array.from({ length: q.tokenVersionId + 1 }, (_, v) => toHex256(withVersion(canonical, v)) as Hex);
    filters.push({
      label: `topic0 ∈ {${TOPIC1_ID_EVENTS.length} events}, topic1 ∈ {withVersion(canonical, 0..${q.tokenVersionId})}`,
      topics: [TOPIC1_ID_EVENTS.map(sel), ids],
    });
  } else {
    const scanned: RegistryEventName[] = ["TokenRegenerated", "TokenResource", "LabelUnregistered", "ExpiryUpdated"];
    if (q.includeRoleEvents) scanned.push("EACRolesChanged", "ResolverUpdated", "SubregistryUpdated");
    filters.push({ label: `topic0 ∈ {${scanned.join(", ")}}, filtered client-side`, topics: [scanned.map(sel)] });
    filters.push({
      label: "LabelRegistered / LabelReserved with topic2 = labelhash",
      topics: [[sel("LabelRegistered"), sel("LabelReserved")], null, toHex256(q.labelhash) as Hex],
    });
  }
  if (q.includeTransfers) {
    filters.push({ label: "TransferSingle / TransferBatch, filtered client-side", topics: [[sel("TransferSingle"), sel("TransferBatch")]] });
  }
  return { mode, filters };
}

const isTooLarge = (e: unknown) =>
  /exceed|limit|too many|too large|response size|more than|range/i.test(
    `${(e as { details?: string })?.details ?? ""} ${(e as Error)?.message ?? ""}`,
  );

async function getLogsAdaptive(
  client: PublicClient,
  address: Address,
  topics: LogTopic[],
  from: bigint,
  to: bigint,
  stats: { requests: number },
): Promise<RegistryLog[]> {
  try {
    stats.requests++;
    const raw = await client.request({
      method: "eth_getLogs",
      params: [{ address, topics, fromBlock: numberToHex(from), toBlock: numberToHex(to) }],
    });
    return parseRegistryLogs(raw.map((l) => formatLog(l)));
  } catch (e) {
    // Public RPCs cap the number of logs per response: bisect the range.
    if (to - from >= 256n && isTooLarge(e)) {
      const mid = (from + to) / 2n;
      const left = await getLogsAdaptive(client, address, topics, from, mid, stats);
      const right = await getLogsAdaptive(client, address, topics, mid + 1n, to, stats);
      return [...left, ...right];
    }
    throw e;
  }
}

/**
 * Loads every registry log for one canonical ID in <= 50k-block chunks.
 * "scan" mimics an indexer that keys by canonical ID (fetch by event type,
 * filter client-side); "topics" uses the live counters to enumerate every
 * token ID / resource the name ever had and filters on the RPC.
 */
export async function loadHistory(
  client: PublicClient,
  q: HistoryQuery,
  onProgress?: (p: HistoryProgress) => void,
  signal?: AbortSignal,
): Promise<HistoryResult> {
  const canonical = canonicalId(q.labelhash);
  const { mode, filters } = planFilters(q);
  const stats = { requests: 0 };
  const seen = new Set<string>();
  const kept: RegistryLog[] = [];
  let received = 0;
  const total = q.toBlock - q.fromBlock + 1n;

  for (let from = q.fromBlock; from <= q.toBlock; from += MAX_LOG_RANGE) {
    if (signal?.aborted) throw new Error("Cancelled");
    const to = from + MAX_LOG_RANGE - 1n > q.toBlock ? q.toBlock : from + MAX_LOG_RANGE - 1n;
    for (const f of filters) {
      const logs = await getLogsAdaptive(client, q.registry, f.topics, from, to, stats);
      received += logs.length;
      for (const log of logs) {
        const key = `${log.transactionHash}:${log.logIndex}`;
        if (seen.has(key) || !logMatches(log, canonical)) continue;
        seen.add(key);
        kept.push(log);
      }
    }
    onProgress?.({ done: to - q.fromBlock + 1n, total, received, requests: stats.requests });
  }

  kept.sort((a, b) =>
    a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : a.blockNumber! < b.blockNumber! ? -1 : 1,
  );
  return { logs: kept, received, requests: stats.requests, mode, filters: filters.map((f) => f.label) };
}

// --- Timeline ---------------------------------------------------------------

export type TimelineKind =
  | "registered"
  | "reserved"
  | "unregistered"
  | "regenerated"
  | "transferred"
  | "renewed"
  | "pointer"
  | "roles"
  | "other";

export type TimelineEntry = {
  txHash: Hex;
  blockNumber: bigint;
  kind: TimelineKind;
  logs: RegistryLog[];
  /** Stored counters after this transaction (null = not derivable from the loaded logs). */
  tokenVersionId: number | null;
  eacVersionId: number | null;
  tokenChanged: boolean;
  resourceChanged: boolean;
  /** True if a token exists after this transaction. */
  hasToken: boolean | null;
};

const KIND_PRIORITY: TimelineKind[] = [
  "registered",
  "reserved",
  "unregistered",
  "regenerated",
  "transferred",
  "renewed",
  "pointer",
  "roles",
  "other",
];

function kindOf(log: RegistryLog): TimelineKind {
  switch (log.eventName) {
    case "LabelRegistered":
      return "registered";
    case "LabelReserved":
      return "reserved";
    case "LabelUnregistered":
      return "unregistered";
    case "TokenRegenerated":
      return "regenerated";
    case "TransferSingle":
    case "TransferBatch":
      return log.args.from !== zeroAddress && log.args.to !== zeroAddress ? "transferred" : "other";
    case "ExpiryUpdated":
      return "renewed";
    case "ResolverUpdated":
    case "SubregistryUpdated":
      return "pointer";
    case "EACRolesChanged":
      return "roles";
    default:
      return "other";
  }
}

/** Groups logs by transaction and replays the version counters. */
export function buildTimeline(logs: RegistryLog[]): TimelineEntry[] {
  const groups: RegistryLog[][] = [];
  for (const log of logs) {
    const last = groups[groups.length - 1];
    if (last && last[0].transactionHash === log.transactionHash) last.push(log);
    else groups.push([log]);
  }

  let tokenV: number | null = null;
  let eacV: number | null = null;
  let hasToken: boolean | null = null;
  const out: TimelineEntry[] = [];

  for (const group of groups) {
    const prevToken = tokenV;
    const prevEac = eacV;
    let kind: TimelineKind = "other";
    for (const log of group) {
      const k = kindOf(log);
      if (KIND_PRIORITY.indexOf(k) < KIND_PRIORITY.indexOf(kind)) kind = k;
      switch (log.eventName) {
        case "LabelRegistered":
          tokenV = versionOf(log.args.tokenId);
          hasToken = true;
          break;
        case "LabelReserved":
          tokenV = versionOf(log.args.tokenId);
          // A fresh entry starts with both counters at 0.
          if (eacV === null && tokenV === 0) eacV = 0;
          hasToken = false;
          break;
        case "TokenResource":
          eacV = versionOf(log.args.resource);
          break;
        case "TokenRegenerated":
          tokenV = versionOf(log.args.newTokenId);
          hasToken = true;
          break;
        case "LabelUnregistered": {
          const burnSeen = group.some((l) => l.eventName === "TransferSingle" && l.args.id === log.args.tokenId);
          if (hasToken || burnSeen) {
            // unregister() burns the token and bumps both counters.
            tokenV = versionOf(log.args.tokenId) + 1;
            eacV = eacV === null ? null : eacV + 1;
          } else if (hasToken === null) {
            tokenV = null;
            eacV = null;
          }
          hasToken = false;
          break;
        }
        case "ExpiryUpdated":
        case "ResolverUpdated":
        case "SubregistryUpdated":
          tokenV = versionOf(log.args.tokenId);
          break;
        case "EACRolesChanged":
          eacV = versionOf(log.args.resource);
          break;
      }
    }
    out.push({
      txHash: group[0].transactionHash!,
      blockNumber: group[0].blockNumber!,
      kind,
      logs: group,
      tokenVersionId: tokenV,
      eacVersionId: eacV,
      tokenChanged: prevToken !== null && tokenV !== null && prevToken !== tokenV,
      resourceChanged: prevEac !== null && eacV !== null && prevEac !== eacV,
      hasToken,
    });
  }
  return out;
}
