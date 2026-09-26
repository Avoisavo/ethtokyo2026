// Read/verify helpers for the Registry Hierarchy playground
// (/ensv2/registry-hierarchy). Everything takes a viem PublicClient so the UI
// and .scratch checks share one code path. With wagmi's default
// `batch: { multicall: true }`, the concurrent readContract calls below are
// aggregated into a few multicalls.

import {
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
  bytesToString,
  getAddress,
  hexToBytes,
  isAddressEqual,
  parseAbi,
  zeroAddress,
} from "viem";

import { ENSV1ResolverAbi } from "./abis/ENSV1Resolver";
import { ETHRegistryAbi } from "./abis/ETHRegistry";
import { LabelStoreAbi } from "./abis/LabelStore";
import { UniversalHelperAbi } from "./abis/UniversalHelper";
import { UniversalResolverV2Abi } from "./abis/UniversalResolverV2";
import { addresses } from "./contracts";
import { ENSV2_SEPOLIA } from "./deployments";
import { formatError } from "./errors";
import { type Hop, ROOT_REGISTRY, iRegistryAbi, walkHierarchy } from "./hierarchy";
import { canonicalId, dnsEncode, labelId, namehash, splitLabels } from "./names";
import { ROOT_RESOURCE, RegistryRoles, nybbleAt } from "./roles";

/** ETHRegistry is a PermissionedRegistry; its ABI fits RootRegistry and every UserRegistry proxy. */
export const permissionedRegistryAbi = ETHRegistryAbi;

export const IREGISTRY_INTERFACE_ID = "0x51f67f40";
export const IEXTENDED_RESOLVER_INTERFACE_ID = "0x9061b923";
export const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const erc165Abi = parseAbi(["function supportsInterface(bytes4 interfaceId) view returns (bool)"]);

export const STATUS = ["AVAILABLE", "RESERVED", "REGISTERED"] as const;

/** eth_getLogs range limit of the public Sepolia RPC. */
export const LOG_CHUNK = 50_000n;

/** No ENSv2 registry event can predate the RootRegistry deployment. */
export const EVENTS_FLOOR = ENSV2_SEPOLIA.RootRegistry.deployBlock;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export async function attempt<T>(p: Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, error: formatError(e) };
  }
}

export const valueOr = <T, D>(r: Result<T> | null | undefined, fallback: D): T | D => (r && r.ok ? r.value : fallback);

const orNull = (a: Address) => (a === zeroAddress ? null : a);

// --- Known deployments ------------------------------------------------------

const KNOWN = new Map<string, string>(
  Object.entries(ENSV2_SEPOLIA).map(([name, d]) => [d.address.toLowerCase(), name]),
);

/** Deployment name for a known ENSv2 Sepolia address, e.g. "ETHRegistry". */
export const knownDeployment = (address: string | null | undefined) =>
  (address && KNOWN.get(address.toLowerCase())) || null;

export const sameAddress = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export type ResolverKind = "v1-mirror" | "v2-mirror" | "dns" | "v2";

/** How a resolver address serves names, from the deployment it matches. */
export function resolverKind(resolver: Address): ResolverKind {
  const known = knownDeployment(resolver);
  if (known === "ENSV1Resolver") return "v1-mirror";
  if (known === "ENSV2Resolver") return "v2-mirror";
  if (known?.startsWith("DNS")) return "dns";
  return "v2";
}

// --- DNS names ----------------------------------------------------------------

/**
 * Decodes DNS wire format to a dotted name. `0x` (empty) means "no name" and
 * returns null; `0x00` is the root name "".
 */
export function decodeDnsName(data: Hex): string | null {
  const bytes = hexToBytes(data);
  if (bytes.length === 0) return null;
  const labels: string[] = [];
  for (let i = 0; i < bytes.length && bytes[i] !== 0; i += 1 + bytes[i]) {
    labels.push(bytesToString(bytes.slice(i + 1, i + 1 + bytes[i])));
  }
  return labels.join(".");
}

/** The ancestor of `name` that starts at byte `offset` of its DNS encoding (UR/UniversalHelper offsets). */
export function nameAtOffset(name: string, offset: bigint): string {
  const bytes = hexToBytes(dnsEncode(name));
  const tail = bytes.slice(Number(offset));
  const labels: string[] = [];
  for (let i = 0; i < tail.length && tail[i] !== 0; i += 1 + tail[i]) {
    labels.push(bytesToString(tail.slice(i + 1, i + 1 + tail[i])));
  }
  return labels.join(".");
}

/** "" -> "<root>" for display. */
export const displayName = (name: string) => (name === "" ? "<root>" : name);

export async function canonicalNameOf(client: PublicClient, registry: Address): Promise<string | null> {
  const bytes = await client.readContract({
    address: addresses.UniversalHelper,
    abi: UniversalHelperAbi,
    functionName: "findCanonicalName",
    args: [registry],
  });
  return decodeDnsName(bytes);
}

export type Position = "canonical" | "alias" | "unanchored";

/**
 * Relationship between where a registry was reached (`reachedAt`) and its
 * canonical name: the same spot, an alias of another spot, or no verified
 * parent chain at all.
 */
export function classifyPosition(canonical: string | null, reachedAt: string): Position {
  if (canonical === null) return "unanchored";
  return canonical === reachedAt ? "canonical" : "alias";
}

// --- Name exploration ---------------------------------------------------------

export type EntryState = {
  status: number;
  expiry: bigint;
  latestOwner: Address;
  tokenId: bigint;
  resource: bigint;
};

export type ExploredHop = Hop & {
  index: number;
  /** Name at which `registry` was reached ("" for the RootRegistry). */
  reachedAt: string;
  /** Canonical name of `registry` per UniversalHelper.findCanonicalName (null = none). */
  registryCanonical: Result<string | null>;
  /** PermissionedRegistry.getState(labelhash) for `label` in `registry`. */
  state: Result<EntryState>;
  /** findOwner(label): current owner, zero when expired, reserved or unregistered. */
  owner: Result<Address>;
};

export type Exploration = {
  name: string;
  dns: Hex;
  node: Hex;
  labels: string[];
  hops: ExploredHop[];
  complete: boolean;
  /** When the walk ended early: the name with no subregistry, and the labels never looked up. */
  stoppedAt: string | null;
  unvisited: string[];
  /** The name's own subregistry (where its subnames live), when the walk is complete. */
  leafSubregistry: { address: Address; canonical: Result<string | null> } | null;
  resolver: Address | null;
  resolverName: string | null;
  resolverIndex: number | null;
  /** ERC-165 IExtendedResolver support of `resolver` (required when it was found at an ancestor). */
  resolverExtended: Result<boolean> | null;
  ur: {
    find: Result<{ resolver: Address; node: Hex; offset: bigint }>;
    require: Result<{ resolver: Address; offset: bigint; extended: boolean }>;
  };
  helper: {
    parentRegistry: Result<Address>;
    exactRegistry: Result<Address>;
    canonicalRegistry: Result<Address>;
    registries: Result<readonly Address[]>;
  };
  /** For names served by the ENSv1 mirror: the v1 resolver ENSV1Resolver delegates to. */
  v1: Result<{ resolver: Address | null; offchain: boolean }> | null;
};

export async function exploreName(client: PublicClient, name: string): Promise<Exploration> {
  const walk = await walkHierarchy(client, name);
  const labels = splitLabels(name);
  const dns = dnsEncode(name);
  const leafSub = walk.complete ? walk.hops[walk.hops.length - 1].subregistry : null;
  const helper = { address: addresses.UniversalHelper, abi: UniversalHelperAbi } as const;
  const ur = { address: addresses.UniversalResolverV2, abi: UniversalResolverV2Abi } as const;

  const [canon, leafCanon, states, owners, find, req, parentRegistry, exactRegistry, canonicalRegistry, registries, ext, v1] =
    await Promise.all([
      Promise.all(walk.hops.map((h) => attempt(canonicalNameOf(client, h.registry)))),
      leafSub ? attempt(canonicalNameOf(client, leafSub)) : null,
      Promise.all(
        walk.hops.map((h) =>
          attempt(
            client.readContract({
              address: h.registry,
              abi: permissionedRegistryAbi,
              functionName: "getState",
              args: [labelId(h.label)],
            }),
          ),
        ),
      ),
      Promise.all(
        walk.hops.map((h) =>
          attempt(client.readContract({ address: h.registry, abi: permissionedRegistryAbi, functionName: "findOwner", args: [h.label] })),
        ),
      ),
      attempt(client.readContract({ ...ur, functionName: "findResolver", args: [dns] })),
      attempt(client.readContract({ ...ur, functionName: "requireResolver", args: [dns] })),
      attempt(client.readContract({ ...helper, functionName: "findParentRegistry", args: [dns] })),
      attempt(client.readContract({ ...helper, functionName: "findExactRegistry", args: [dns] })),
      attempt(client.readContract({ ...helper, functionName: "findCanonicalRegistry", args: [dns] })),
      attempt(client.readContract({ ...helper, functionName: "findRegistries", args: [dns] })),
      walk.resolver
        ? attempt(
            client.readContract({
              address: walk.resolver,
              abi: erc165Abi,
              functionName: "supportsInterface",
              args: [IEXTENDED_RESOLVER_INTERFACE_ID],
            }),
          )
        : null,
      walk.resolver && resolverKind(walk.resolver) === "v1-mirror"
        ? attempt(client.readContract({ address: walk.resolver, abi: ENSV1ResolverAbi, functionName: "getResolver", args: [dns] }))
        : null,
    ]);

  const hops: ExploredHop[] = walk.hops.map((h, i) => ({
    ...h,
    index: i,
    reachedAt: i === 0 ? "" : walk.hops[i - 1].name,
    registryCanonical: canon[i],
    state: states[i],
    owner: owners[i],
  }));
  const resolverIndex = walk.resolverName === null ? null : hops.findIndex((h) => h.name === walk.resolverName);
  const stoppedAt = !walk.complete && hops.length > 0 ? hops[hops.length - 1].name : null;

  return {
    name,
    dns,
    node: namehash(name),
    labels,
    hops,
    complete: walk.complete,
    stoppedAt,
    unvisited: labels.slice(0, labels.length - hops.length),
    leafSubregistry: leafSub && leafCanon ? { address: leafSub, canonical: leafCanon } : null,
    resolver: walk.resolver,
    resolverName: walk.resolverName,
    resolverIndex,
    resolverExtended: ext,
    ur: {
      find: find.ok ? { ok: true, value: { resolver: find.value[0], node: find.value[1], offset: find.value[2] } } : find,
      require: req.ok
        ? { ok: true, value: { resolver: req.value.resolver, offset: req.value.offset, extended: req.value.extended } }
        : req,
    },
    helper: { parentRegistry, exactRegistry, canonicalRegistry, registries },
    v1: v1 ? (v1.ok ? { ok: true, value: { resolver: orNull(v1.value[0]), offchain: v1.value[1] } } : v1) : null,
  };
}

// --- Canonical walk (upward) ----------------------------------------------------

export type UpStep = {
  registry: Address;
  /** getParent() of `registry`; null when unset. */
  parent: Address | null;
  label: string;
  /** parent.getSubregistry(label): must point back at `registry`. */
  back: Address | null;
};

export type UpWalk = {
  steps: UpStep[];
  outcome: "root" | "no-parent" | "wrong-child" | "cycle" | "error" | "too-deep";
  /** Reconstructed canonical name when outcome is "root". */
  name: string | null;
  error?: string;
};

/**
 * Mirrors LibResolution.findCanonicalName step by step: follow getParent()
 * up to the RootRegistry, checking at each level that the parent's forward
 * pointer (getSubregistry) points back.
 */
export async function walkUp(client: PublicClient, registry: Address, root: Address = ROOT_REGISTRY, maxSteps = 16): Promise<UpWalk> {
  const steps: UpStep[] = [];
  const labels: string[] = [];
  const seen = new Set<string>();
  let current = registry;
  for (let i = 0; i < maxSteps; i++) {
    if (isAddressEqual(current, root)) return { steps, outcome: "root", name: labels.join(".") };
    if (seen.has(current.toLowerCase())) return { steps, outcome: "cycle", name: null };
    seen.add(current.toLowerCase());
    const p = await attempt(client.readContract({ address: current, abi: iRegistryAbi, functionName: "getParent" }));
    if (!p.ok) return { steps, outcome: "error", name: null, error: p.error };
    const [parent, label] = p.value;
    if (parent === zeroAddress) {
      steps.push({ registry: current, parent: null, label, back: null });
      return { steps, outcome: "no-parent", name: null };
    }
    const b = await attempt(client.readContract({ address: parent, abi: iRegistryAbi, functionName: "getSubregistry", args: [label] }));
    if (!b.ok) {
      steps.push({ registry: current, parent, label, back: null });
      return { steps, outcome: "error", name: null, error: b.error };
    }
    steps.push({ registry: current, parent, label, back: orNull(b.value) });
    if (!isAddressEqual(b.value, current)) return { steps, outcome: "wrong-child", name: null };
    labels.push(label);
    current = parent;
  }
  return { steps, outcome: "too-deep", name: null };
}

// --- Registry inspection --------------------------------------------------------

export type RegistryInspection = {
  address: Address;
  known: string | null;
  isContract: boolean;
  /** ERC-1967 implementation (UserRegistry proxies from the VerifiableFactory). */
  implementation: Address | null;
  isRegistry: Result<boolean>;
  parent: Result<{ parent: Address | null; label: string }>;
  /** parent.getSubregistry(label): one-step check of the parent pointer. */
  back: Result<Address | null> | null;
  canonicalName: Result<string | null>;
  /** findCanonicalRegistry(canonicalName): should round-trip to `address`. */
  roundTrip: Result<Address> | null;
  emancipated: Result<boolean>;
  rootRoleCounts: Result<bigint>;
};

export async function inspectRegistry(client: PublicClient, registry: Address): Promise<RegistryInspection> {
  const reg = { address: registry, abi: permissionedRegistryAbi } as const;
  const [code, slot, isRegistry, parentRaw, canonicalName, emancipated, rootRoleCounts] = await Promise.all([
    client.getCode({ address: registry }),
    attempt(client.getStorageAt({ address: registry, slot: ERC1967_IMPLEMENTATION_SLOT })),
    attempt(client.readContract({ address: registry, abi: erc165Abi, functionName: "supportsInterface", args: [IREGISTRY_INTERFACE_ID] })),
    attempt(client.readContract({ address: registry, abi: iRegistryAbi, functionName: "getParent" })),
    attempt(canonicalNameOf(client, registry)),
    attempt(client.readContract({ ...reg, functionName: "isEmancipated" })),
    attempt(client.readContract({ ...reg, functionName: "roleCount", args: [ROOT_RESOURCE] })),
  ]);
  const parent: RegistryInspection["parent"] = parentRaw.ok
    ? { ok: true, value: { parent: orNull(parentRaw.value[0]), label: parentRaw.value[1] } }
    : parentRaw;
  const p = parent.ok ? parent.value : null;
  const canon = canonicalName.ok ? canonicalName.value : null;
  const [back, roundTrip] = await Promise.all([
    p?.parent
      ? attempt(client.readContract({ address: p.parent, abi: iRegistryAbi, functionName: "getSubregistry", args: [p.label] })).then(
          (r): Result<Address | null> => (r.ok ? { ok: true, value: orNull(r.value) } : r),
        )
      : null,
    canon !== null
      ? attempt(
          client.readContract({
            address: addresses.UniversalHelper,
            abi: UniversalHelperAbi,
            functionName: "findCanonicalRegistry",
            args: [dnsEncode(canon)],
          }),
        )
      : null,
  ]);
  const implWord = slot.ok ? slot.value : undefined;
  const implementation = implWord && BigInt(implWord) !== 0n ? getAddress(`0x${implWord.slice(-40)}`) : null;
  return {
    address: registry,
    known: knownDeployment(registry),
    isContract: !!code && code !== "0x",
    implementation,
    isRegistry,
    parent,
    back,
    canonicalName,
    roundTrip,
    emancipated,
    rootRoleCounts,
  };
}

/** Holders of ROLE_SET_PARENT / ROLE_SET_PARENT_ADMIN on ROOT_RESOURCE, from roleCount(ROOT_RESOURCE). */
export function setParentHolders(rootRoleCounts: bigint) {
  return { role: nybbleAt(rootRoleCounts, 2), admin: nybbleAt(rootRoleCounts, 2 + 32) };
}

export type LabelRow = {
  label: string;
  subregistry: Result<Address | null>;
  resolver: Result<Address | null>;
  state: Result<EntryState>;
  owner: Result<Address>;
};

/** Per-label IRegistry lookups plus PermissionedRegistry state (fails gracefully on custom registries). */
export async function lookupLabels(client: PublicClient, registry: Address, labels: string[]): Promise<LabelRow[]> {
  const reg = { address: registry, abi: permissionedRegistryAbi } as const;
  const nullable = (r: Result<Address>): Result<Address | null> => (r.ok ? { ok: true, value: orNull(r.value) } : r);
  return Promise.all(
    labels.map(async (label) => {
      const [subregistry, resolver, state, owner] = await Promise.all([
        attempt(client.readContract({ address: registry, abi: iRegistryAbi, functionName: "getSubregistry", args: [label] })),
        attempt(client.readContract({ address: registry, abi: iRegistryAbi, functionName: "getResolver", args: [label] })),
        attempt(client.readContract({ ...reg, functionName: "getState", args: [labelId(label)] })),
        attempt(client.readContract({ ...reg, functionName: "findOwner", args: [label] })),
      ]);
      return { label, subregistry: nullable(subregistry), resolver: nullable(resolver), state, owner };
    }),
  );
}

// --- IRegistryEvents ------------------------------------------------------------

/** IRegistryEvents from contracts-v2 src/registry/interfaces/IRegistryEvents.sol. */
export const registryEventsAbi = parseAbi([
  "event RegistryCreated()",
  "event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)",
  "event LabelReserved(uint256 indexed tokenId, bytes32 indexed labelHash, string label, uint64 expiry, address indexed sender)",
  "event LabelUnregistered(uint256 indexed tokenId, address indexed sender)",
  "event ExpiryUpdated(uint256 indexed tokenId, uint64 indexed newExpiry, address indexed sender)",
  "event SubregistryUpdated(uint256 indexed tokenId, address indexed subregistry, address indexed sender)",
  "event ResolverUpdated(uint256 indexed tokenId, address indexed resolver, address indexed sender)",
  "event URIUpdated(string uri, address renderer, address indexed sender)",
  "event TokenRegenerated(uint256 indexed oldTokenId, uint256 indexed newTokenId)",
  "event ParentUpdated(address indexed parent, string label, address indexed sender)",
]);

export type RegistryEventName = (typeof registryEventsAbi)[number]["name"];

export const REGISTRY_EVENT_NAMES = registryEventsAbi.map((e) => e.name) as RegistryEventName[];

export type RegistryEventRow = {
  key: string;
  blockNumber: bigint;
  txHash: Hex;
  eventName: RegistryEventName;
  tokenId: bigint | null;
  /** Label of `tokenId` (from the event or the registry's LabelStore); for ParentUpdated, the registry's own label. */
  label: string | null;
  /** New subregistry / resolver / parent / owner, depending on the event. */
  target: Address | null;
  detail: string | null;
  sender: Address | null;
};

/** Loads IRegistryEvents emitted by `registry` in [fromBlock, toBlock] (caller keeps the range <= LOG_CHUNK). */
export async function fetchRegistryEvents(
  client: PublicClient,
  registry: Address,
  fromBlock: bigint,
  toBlock: bigint,
  names: RegistryEventName[],
): Promise<RegistryEventRow[]> {
  if (names.length === 0) return [];
  const events = registryEventsAbi.filter((e) => names.includes(e.name)) as AbiEvent[];
  const logs = await client.getLogs({ address: registry, events, fromBlock, toBlock });
  const rows: RegistryEventRow[] = logs.map((log) => {
    const args = (log.args ?? {}) as Record<string, unknown>;
    const eventName = log.eventName as RegistryEventName;
    const tokenId = (args.tokenId ?? args.newTokenId ?? null) as bigint | null;
    const addr = (k: string) => (typeof args[k] === "string" ? (args[k] as Address) : null);
    let target: Address | null = null;
    let detail: string | null = null;
    switch (eventName) {
      case "SubregistryUpdated":
        target = addr("subregistry");
        break;
      case "ResolverUpdated":
        target = addr("resolver");
        break;
      case "ParentUpdated":
        target = addr("parent");
        break;
      case "LabelRegistered":
        target = addr("owner");
        detail = `expiry ${args.expiry}`;
        break;
      case "LabelReserved":
        detail = `expiry ${args.expiry}`;
        break;
      case "ExpiryUpdated":
        detail = `new expiry ${args.newExpiry}`;
        break;
      case "TokenRegenerated":
        detail = `from 0x${(args.oldTokenId as bigint).toString(16)}`;
        break;
      case "URIUpdated":
        target = addr("renderer");
        detail = String(args.uri ?? "");
        break;
    }
    return {
      key: `${log.transactionHash}:${log.logIndex}`,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      eventName,
      tokenId,
      label: typeof args.label === "string" ? args.label : null,
      target,
      detail,
      sender: addr("sender"),
    };
  });
  await fillLabels(client, registry, rows);
  return rows.sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1));
}

/** Registries store labels in the shared LabelStore; resolve missing labels from token IDs in one batch. */
async function fillLabels(client: PublicClient, registry: Address, rows: { tokenId: bigint | null; label: string | null }[]) {
  const missing = rows.filter((r) => r.label === null && r.tokenId !== null);
  if (missing.length === 0) return;
  const store = valueOr(
    await attempt(client.readContract({ address: registry, abi: permissionedRegistryAbi, functionName: "LABEL_STORE" })),
    addresses.LabelStore,
  );
  const ids = [...new Set(missing.map((r) => canonicalId(r.tokenId!).toString()))];
  const labels = await Promise.all(
    ids.map((id) => attempt(client.readContract({ address: store, abi: LabelStoreAbi, functionName: "getLabel", args: [BigInt(id)] }))),
  );
  const byId = new Map(ids.map((id, i) => [id, valueOr(labels[i], "")]));
  for (const r of missing) r.label = byId.get(canonicalId(r.tokenId!).toString()) || null;
}

// --- Alias scan -------------------------------------------------------------------

export type AliasGroup = { subregistry: Address; labels: string[]; canonical: Result<string | null> };

/**
 * Finds labels in `registry` whose current subregistry is shared with another
 * label (namespace aliasing), from SubregistryUpdated history in
 * [fromBlock, toBlock], queried in LOG_CHUNK windows.
 */
export async function scanAliases(
  client: PublicClient,
  registry: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ pointers: number; labels: number; groups: AliasGroup[] }> {
  const event = registryEventsAbi.find((e) => e.name === "SubregistryUpdated")!;
  const tokenIds: bigint[] = [];
  for (let from = fromBlock; from <= toBlock; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > toBlock ? toBlock : from + LOG_CHUNK - 1n;
    const logs = await client.getLogs({ address: registry, event, fromBlock: from, toBlock: to });
    for (const l of logs) if (l.args.tokenId !== undefined) tokenIds.push(l.args.tokenId);
  }
  const rows = [...new Set(tokenIds.map((t) => canonicalId(t).toString()))].map((id) => ({
    tokenId: BigInt(id),
    label: null as string | null,
  }));
  await fillLabels(client, registry, rows);
  const labelled = rows.filter((r): r is { tokenId: bigint; label: string } => !!r.label);
  const current = await Promise.all(
    labelled.map((r) => attempt(client.readContract({ address: registry, abi: iRegistryAbi, functionName: "getSubregistry", args: [r.label] }))),
  );
  const bySub = new Map<string, { subregistry: Address; labels: string[] }>();
  labelled.forEach((r, i) => {
    const sub = valueOr(current[i], zeroAddress);
    if (sub === zeroAddress) return;
    const g = bySub.get(sub.toLowerCase()) ?? { subregistry: sub, labels: [] };
    g.labels.push(r.label);
    bySub.set(sub.toLowerCase(), g);
  });
  const shared = [...bySub.values()].filter((g) => g.labels.length > 1);
  const canon = await Promise.all(shared.map((g) => attempt(canonicalNameOf(client, g.subregistry))));
  return {
    pointers: bySub.size,
    labels: labelled.length,
    groups: shared.map((g, i) => ({ ...g, canonical: canon[i] })),
  };
}

// --- Write pre-checks -------------------------------------------------------------

export type SetSubregistryCheck = {
  state: Result<EntryState>;
  current: Result<Address | null>;
  access: { effective: Result<boolean>; tokenRoles: Result<bigint>; root: Result<boolean> } | null;
  target: { isContract: boolean; isRegistry: Result<boolean> | null; canonical: Result<string | null> | null };
  simulation: Result<true> | null;
};

/**
 * Everything setSubregistry(anyId, registry) checks, read up front:
 * the entry must be unexpired and the caller needs ROLE_SET_SUBREGISTRY on
 * the name's resource or on ROOT_RESOURCE (or be an approved operator of the
 * owner). Also simulates the call from `account`.
 */
export async function checkSetSubregistry(
  client: PublicClient,
  { registry, label, target, account }: { registry: Address; label: string; target: Address; account?: Address },
): Promise<SetSubregistryCheck> {
  const reg = { address: registry, abi: permissionedRegistryAbi } as const;
  const anyId = labelId(label);
  const role = RegistryRoles.ROLE_SET_SUBREGISTRY;
  const hasTarget = target !== zeroAddress;
  const [state, current, effective, tokenRoles, root, code, isRegistry, canonical, simulation] = await Promise.all([
    attempt(client.readContract({ ...reg, functionName: "getState", args: [anyId] })),
    attempt(client.readContract({ address: registry, abi: iRegistryAbi, functionName: "getSubregistry", args: [label] })),
    account ? attempt(client.readContract({ ...reg, functionName: "hasRoles", args: [anyId, role, account] })) : null,
    account ? attempt(client.readContract({ ...reg, functionName: "roles", args: [anyId, account] })) : null,
    account ? attempt(client.readContract({ ...reg, functionName: "hasRootRoles", args: [role, account] })) : null,
    hasTarget ? client.getCode({ address: target }) : undefined,
    hasTarget
      ? attempt(client.readContract({ address: target, abi: erc165Abi, functionName: "supportsInterface", args: [IREGISTRY_INTERFACE_ID] }))
      : null,
    hasTarget ? attempt(canonicalNameOf(client, target)) : null,
    account
      ? attempt(client.simulateContract({ ...reg, account, functionName: "setSubregistry", args: [anyId, target] })).then(
          (r): Result<true> => (r.ok ? { ok: true, value: true } : r),
        )
      : null,
  ]);
  return {
    state,
    current: current.ok ? { ok: true, value: orNull(current.value) } : current,
    access: effective && tokenRoles && root ? { effective, tokenRoles, root } : null,
    target: { isContract: !!code && code !== "0x", isRegistry, canonical },
    simulation,
  };
}

export type SetParentCheck = {
  current: Result<{ parent: Address | null; label: string }>;
  canSet: Result<boolean> | null;
  canLock: Result<boolean> | null;
  rootRoleCounts: Result<bigint>;
  /** newParent.getSubregistry(label): the forward pointer that must match for a canonical name. */
  forward: Result<Address | null> | null;
  canonicalNow: Result<string | null>;
  simulation: Result<true> | null;
  lockSimulation: Result<true> | null;
};

/** setParent requires ROLE_SET_PARENT on ROOT_RESOURCE; locking it requires ROLE_SET_PARENT_ADMIN. */
export async function checkSetParent(
  client: PublicClient,
  {
    registry,
    parent,
    label,
    account,
    lockAccount,
  }: { registry: Address; parent: Address; label: string; account?: Address; lockAccount?: Address },
): Promise<SetParentCheck> {
  const reg = { address: registry, abi: permissionedRegistryAbi } as const;
  const lockBits = RegistryRoles.ROLE_SET_PARENT | RegistryRoles.ROLE_SET_PARENT_ADMIN;
  const asTrue = (r: Result<unknown>): Result<true> => (r.ok ? { ok: true, value: true } : r);
  const [current, canSet, canLock, rootRoleCounts, forward, canonicalNow, simulation, lockSimulation] = await Promise.all([
    attempt(client.readContract({ address: registry, abi: iRegistryAbi, functionName: "getParent" })),
    account ? attempt(client.readContract({ ...reg, functionName: "hasRootRoles", args: [RegistryRoles.ROLE_SET_PARENT, account] })) : null,
    account
      ? attempt(client.readContract({ ...reg, functionName: "hasRootRoles", args: [RegistryRoles.ROLE_SET_PARENT_ADMIN, account] }))
      : null,
    attempt(client.readContract({ ...reg, functionName: "roleCount", args: [ROOT_RESOURCE] })),
    parent !== zeroAddress
      ? attempt(client.readContract({ address: parent, abi: iRegistryAbi, functionName: "getSubregistry", args: [label] }))
      : null,
    attempt(canonicalNameOf(client, registry)),
    account
      ? attempt(client.simulateContract({ ...reg, account, functionName: "setParent", args: [parent, label] })).then(asTrue)
      : null,
    account && lockAccount
      ? attempt(client.simulateContract({ ...reg, account, functionName: "revokeRootRoles", args: [lockBits, lockAccount] })).then(asTrue)
      : null,
  ]);
  return {
    current: current.ok ? { ok: true, value: { parent: orNull(current.value[0]), label: current.value[1] } } : current,
    canSet,
    canLock,
    rootRoleCounts,
    forward: forward ? (forward.ok ? { ok: true, value: orNull(forward.value) } : forward) : null,
    canonicalNow,
    simulation,
    lockSimulation,
  };
}
