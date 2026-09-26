// Pure helpers for the Permissioned Resolver playground, mirrored from
// contracts-v2@71a3b73:
//   src/resolver/PermissionedResolver.sol
//   src/resolver/AbstractRecordResolver.sol
//   src/resolver/libraries/PermissionedResolverLib.sol
//   src/access-control/libraries/EACBaseRolesLib.sol

import {
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type RpcLog,
  bytesToHex,
  bytesToString,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  formatLog,
  hexToBytes,
  isHex,
  keccak256,
  parseAbi,
  parseEventLogs,
  stringToHex,
  toEventSelector,
  toHex,
} from "viem";

import { PermissionedResolverImplAbi } from "./abis/PermissionedResolverImpl";
import { ENSV2_SEPOLIA } from "./deployments";
import { ROOT_RESOURCE, ResolverRoles } from "./roles";

export const resolverAbi = PermissionedResolverImplAbi;

/** ERC-165 id of IPermissionedResolver (from the interface's NatSpec). */
export const IPERMISSIONED_RESOLVER_ID: Hex = "0x8c2427cc";
/** ERC-7996 feature: resolve(name, multicall([...])) answers each inner call. */
export const RESOLVE_MULTICALL_FEATURE: Hex = "0x96b62db8";

export const COIN_TYPE_ETH = 60n;
/** ENSIP-19 default EVM coin type (1 << 31): fallback for every EVM chain. */
export const COIN_TYPE_DEFAULT = 0x80000000n;

/** Resolver proxies cannot predate the factory, so log scans start here. */
export const RESOLVER_LOGS_FROM = ENSV2_SEPOLIA.VerifiableFactory.deployBlock;

// --- Resources (PermissionedResolverLib.resource) ------------------------

/** resource(string) = keccak256(bytes(s)). */
export const keyResource = (key: string): bigint => BigInt(keccak256(stringToHex(key)));
/** resource(uint256) = keccak256 of the 32-byte word. */
export const uintResource = (value: bigint): bigint =>
  BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }], [value])));
/** resource(bytes4) = keccak256 of exactly 4 bytes. */
export const bytes4Resource = (id: Hex): bigint => BigInt(keccak256(id));

/** EACBaseRolesLib.withAdminRolesApplied: admin roles imply their regular role. */
export const withAdminRolesApplied = (bitmap: bigint): bigint => {
  const admins = bitmap >> 128n;
  return (admins << 128n) | admins;
};

/** Mirrors ENSIP19.chainFromCoinType. */
export const chainFromCoinType = (coinType: bigint): number => {
  if (coinType === COIN_TYPE_ETH) return 1;
  const x = coinType ^ COIN_TYPE_DEFAULT;
  return x < COIN_TYPE_DEFAULT ? Number(x) : 0;
};

/** Mirrors ENSIP19.isEVMCoinType: setAddress enforces 0 or 20 bytes for these. */
export const isEvmCoinType = (coinType: bigint) => coinType === COIN_TYPE_DEFAULT || chainFromCoinType(coinType) > 0;

// --- Setters ---------------------------------------------------------------

export type SetterKind = "address" | "text" | "contenthash" | "abi" | "interface" | "data" | "name";
/** Setters whose first non-name argument scopes the role (decodeSetter accepts these). */
export type ScopedKind = "address" | "text" | "abi" | "interface" | "data";

export const SETTERS: Record<
  SetterKind,
  { fn: string; role: bigint; roleName: string; argument: string | null; label: string }
> = {
  address: { fn: "setAddress", role: ResolverRoles.ROLE_SET_ADDRESS, roleName: "ROLE_SET_ADDRESS", argument: "uint256 coinType", label: "Address" },
  text: { fn: "setText", role: ResolverRoles.ROLE_SET_TEXT, roleName: "ROLE_SET_TEXT", argument: "string key", label: "Text" },
  contenthash: { fn: "setContenthash", role: ResolverRoles.ROLE_SET_CONTENTHASH, roleName: "ROLE_SET_CONTENTHASH", argument: null, label: "Contenthash" },
  abi: { fn: "setABI", role: ResolverRoles.ROLE_SET_ABI, roleName: "ROLE_SET_ABI", argument: "uint256 contentType", label: "ABI" },
  interface: { fn: "setInterface", role: ResolverRoles.ROLE_SET_INTERFACE, roleName: "ROLE_SET_INTERFACE", argument: "bytes4 interfaceId", label: "Interface" },
  data: { fn: "setData", role: ResolverRoles.ROLE_SET_DATA, roleName: "ROLE_SET_DATA", argument: "string key", label: "Data" },
  name: { fn: "setName", role: ResolverRoles.ROLE_SET_NAME, roleName: "ROLE_SET_NAME", argument: null, label: "Name (reverse)" },
};

export type Requirement = { role: bigint; roleName: string; resource: bigint; argLabel: string | null };

/**
 * The role a resolver call checks and the resource it checks it at (the
 * argument's resource, with ROOT_RESOURCE as fallback, or root only).
 */
export function requirementOf(data: Hex): Requirement | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi: resolverAbi, data });
    const a = args as readonly unknown[];
    switch (functionName) {
      case "setAddress":
        return { ...pick("address"), resource: uintResource(a[1] as bigint), argLabel: `coinType ${a[1]}` };
      case "setText":
        return { ...pick("text"), resource: keyResource(a[1] as string), argLabel: `key "${a[1]}"` };
      case "setData":
        return { ...pick("data"), resource: keyResource(a[1] as string), argLabel: `key "${a[1]}"` };
      case "setABI":
        return { ...pick("abi"), resource: uintResource(a[1] as bigint), argLabel: `contentType ${a[1]}` };
      case "setInterface":
        return { ...pick("interface"), resource: bytes4Resource(a[1] as Hex), argLabel: `interfaceId ${a[1]}` };
      case "setContenthash":
        return { ...pick("contenthash"), resource: ROOT_RESOURCE, argLabel: null };
      case "setName":
        return { ...pick("name"), resource: ROOT_RESOURCE, argLabel: null };
      case "linkToNode":
      case "linkToRecord":
        return { role: ResolverRoles.ROLE_LINK, roleName: "ROLE_LINK", resource: ROOT_RESOURCE, argLabel: null };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

const pick = (k: SetterKind) => ({ role: SETTERS[k].role, roleName: SETTERS[k].roleName });

/** One-line human summary of resolver calldata, e.g. setText(alice.eth, "avatar", "…"). */
export function describeCall(data: Hex): string {
  try {
    const { functionName, args } = decodeFunctionData({ abi: resolverAbi, data });
    const parts = (args as readonly unknown[] | undefined)?.map((a, i) => {
      if (i === 0 && typeof a === "string" && isHex(a) && functionName !== "multicallWithNodeCheck") return tryDnsDecode(a) ?? a;
      if (typeof a === "string") return a.length > 42 ? `"${a.slice(0, 40)}…"` : isHex(a) ? a : `"${a}"`;
      return String(a);
    });
    return `${functionName}(${(parts ?? []).join(", ")})`;
  } catch {
    return data.length > 20 ? `${data.slice(0, 18)}…` : data;
  }
}

// --- Read profiles (called through resolve(name, data)) --------------------

export const profileAbi = parseAbi([
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
  "function hasAddr(bytes32 node, uint256 coinType) view returns (bool)",
  "function text(bytes32 node, string key) view returns (string)",
  "function contenthash(bytes32 node) view returns (bytes)",
  "function name(bytes32 node) view returns (string)",
  "function ABI(bytes32 node, uint256 contentTypes) view returns (uint256, bytes)",
  "function interfaceImplementer(bytes32 node, bytes4 interfaceId) view returns (address)",
  "function data(bytes32 node, string key) view returns (bytes)",
]);

export const multicallAbi = parseAbi(["function multicall(bytes[] data) returns (bytes[] results)"]);

// --- DNS wire format ------------------------------------------------------

/** Decodes DNS wire-format bytes to a dotted name; the root name decodes to "". */
export function dnsDecode(hex: Hex): string {
  const b = hexToBytes(hex);
  const labels: string[] = [];
  let i = 0;
  while (i < b.length) {
    const len = b[i];
    if (len === 0) {
      if (i !== b.length - 1) throw new Error("trailing bytes after root label");
      return labels.join(".");
    }
    if (i + 1 + len > b.length) throw new Error("label overflows name");
    labels.push(bytesToString(b.slice(i + 1, i + 1 + len)));
    i += 1 + len;
  }
  throw new Error("missing root label");
}

export function tryDnsDecode(hex: Hex): string | null {
  try {
    const n = dnsDecode(hex);
    return n === "" ? "[root]" : n;
  } catch {
    return null;
  }
}

// --- Contenthash (ENSIP-7) --------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base58Encode(bytes: Uint8Array): string {
  let n = BigInt(bytesToHex(bytes) === "0x" ? 0 : bytesToHex(bytes));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error(`invalid base58 character "${ch}"`);
    n = n * 58n + BigInt(v);
  }
  const hex = n === 0n ? "" : n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0");
  const lead = s.match(/^1*/)![0].length;
  return new Uint8Array([...new Array(lead).fill(0), ...(hex ? hexToBytes(`0x${hex}`) : [])]);
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.toLowerCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error(`invalid base32 character "${ch}"`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

const base64UrlEncode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function readVarint(b: Uint8Array, offset = 0): [value: number, next: number] {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (; i < b.length; i++) {
    value += (b[i] & 0x7f) * 2 ** shift;
    shift += 7;
    if ((b[i] & 0x80) === 0) return [value, i + 1];
  }
  throw new Error("truncated varint");
}

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

const CODECS: Record<number, string> = {
  0xe3: "ipfs",
  0xe5: "ipns",
  0xe4: "swarm",
  0x1bc: "onion",
  0x1bd: "onion3",
  0xb19910: "skynet",
  0xb29910: "arweave",
};

export type DecodedContenthash = { protocol: string; text: string };

/** Decodes the known ENSIP-7 namespaces for display; null for empty or unknown values. */
export function decodeContenthash(hex: Hex): DecodedContenthash | null {
  if (!isHex(hex) || hex === "0x") return null;
  try {
    const b = hexToBytes(hex);
    const [codec, next] = readVarint(b);
    const protocol = CODECS[codec];
    if (!protocol) return null;
    const rest = b.slice(next);
    switch (protocol) {
      case "ipfs":
      case "ipns": {
        // CIDv1 dag-pb + sha2-256 has an equivalent CIDv0 (Qm…) form.
        if (protocol === "ipfs" && rest[0] === 1 && rest[1] === 0x70 && rest[2] === 0x12 && rest[3] === 0x20)
          return { protocol, text: `ipfs://${base58Encode(rest.slice(2))}` };
        return { protocol, text: `${protocol}://b${base32Encode(rest)}` };
      }
      case "swarm":
        // swarm-ns, CIDv1, swarm-manifest (0xfa), keccak-256 (0x1b), 32 bytes
        return { protocol, text: `bzz://${bytesToHex(rest.slice(-32)).slice(2)}` };
      case "arweave":
        return { protocol, text: `ar://${base64UrlEncode(rest)}` };
      case "skynet":
        return { protocol, text: `sia://${base64UrlEncode(rest)}` };
      default:
        return { protocol, text: `${protocol}://${bytesToString(rest)}` };
    }
  } catch {
    return null;
  }
}

/**
 * Encodes ipfs:// (CIDv0 Qm… or base32 CIDv1 b…), ipns:// (base32 CIDv1),
 * bzz:// (32-byte hex) and ar:// (base64url) URIs. Raw 0x hex passes through.
 */
export function encodeContenthash(input: string): Hex {
  const s = input.trim();
  if (s === "" || s === "0x") return "0x";
  if (isHex(s)) return s;
  const m = s.match(/^([a-z0-9]+):\/\/(.+)$/i);
  if (!m) throw new Error("expected 0x hex or a protocol://value URI");
  const [, proto, value] = m;
  switch (proto.toLowerCase()) {
    case "ipfs":
    case "ipns": {
      const codec = proto.toLowerCase() === "ipfs" ? 0xe3 : 0xe5;
      let cid: Uint8Array;
      if (value.startsWith("Qm")) cid = new Uint8Array([1, 0x70, ...base58Decode(value)]);
      else if (value.startsWith("b")) cid = base32Decode(value.slice(1));
      else throw new Error("only CIDv0 (Qm…) and base32 CIDv1 (b…) are supported");
      return bytesToHex(new Uint8Array([...varint(codec), ...cid]));
    }
    case "bzz": {
      const hash = value.startsWith("0x") ? value : `0x${value}`;
      if (!isHex(hash) || hash.length !== 66) throw new Error("bzz:// expects a 32-byte hex hash");
      return bytesToHex(new Uint8Array([...varint(0xe4), 0x01, 0xfa, 0x01, 0x1b, 0x20, ...hexToBytes(hash)]));
    }
    case "ar":
      return bytesToHex(new Uint8Array([...varint(0xb29910), ...base64UrlDecode(value)]));
    default:
      throw new Error(`unsupported protocol ${proto}`);
  }
}

// --- Presets ----------------------------------------------------------------

export const TEXT_KEY_PRESETS = ["avatar", "description", "url", "com.twitter", "com.github", "email", "header", "location"];

/** ABI content types (setABI requires exactly one bit). */
export const ABI_CONTENT_TYPES = [
  { value: 1n, label: "1 · JSON" },
  { value: 2n, label: "2 · zlib-compressed JSON" },
  { value: 4n, label: "4 · CBOR" },
  { value: 8n, label: "8 · URI" },
];

export const INTERFACE_PRESETS: { id: Hex; label: string }[] = [
  { id: "0x01ffc9a7", label: "ERC-165" },
  { id: "0x80ac58cd", label: "ERC-721" },
  { id: "0xd9b67a26", label: "ERC-1155" },
  { id: "0x36372b07", label: "ERC-20 (informal)" },
  { id: "0x3b3b57de", label: "addr(bytes32)" },
  { id: "0x9061b923", label: "IExtendedResolver" },
];

// --- Logs -------------------------------------------------------------------

/** Record events are keyed by recordId in topic 1 (Linked also has node in topic 2). */
export const RECORD_EVENT_NAMES = [
  "Linked",
  "AddressUpdated",
  "TextUpdated",
  "ContenthashUpdated",
  "NameUpdated",
  "ABIUpdated",
  "InterfaceUpdated",
  "DataUpdated",
] as const;

const recordEvents = resolverAbi.filter(
  (x): x is Extract<(typeof resolverAbi)[number], { type: "event" }> =>
    x.type === "event" && (RECORD_EVENT_NAMES as readonly string[]).includes(x.name),
);

export const recordEventTopics: Hex[] = recordEvents.map((e) => toEventSelector(e as AbiEvent));

const MAX_RANGE = 50_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRateLimit(e: unknown) {
  const msg = String((e as { details?: string; message?: string })?.details ?? (e as Error)?.message ?? "");
  const code = (e as { code?: number })?.code;
  return code === -32005 || code === 429 || /rate limit|too many/i.test(msg);
}

/**
 * eth_getLogs over [fromBlock, latest] in <= 50k-block chunks, sequentially,
 * retrying rate-limited chunks with backoff (the public RPC is strict).
 */
export async function getLogsChunked(
  client: PublicClient,
  params: { address: Address; topics: (Hex | Hex[] | null)[]; fromBlock?: bigint },
  onProgress?: (done: number, total: number) => void,
): Promise<Log[]> {
  const latest = await client.getBlockNumber();
  const from = params.fromBlock ?? RESOLVER_LOGS_FROM;
  const ranges: [bigint, bigint][] = [];
  for (let b = from; b <= latest; b += MAX_RANGE) ranges.push([b, b + MAX_RANGE - 1n > latest ? latest : b + MAX_RANGE - 1n]);
  const out: Log[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const [f, t] = ranges[i];
    for (let attempt = 0; ; attempt++) {
      try {
        const logs = (await client.request({
          method: "eth_getLogs",
          params: [{ address: params.address, topics: params.topics, fromBlock: toHex(f), toBlock: toHex(t) }],
        })) as RpcLog[];
        out.push(...logs.map((l) => formatLog(l)));
        break;
      } catch (e) {
        if (attempt < 4 && isRateLimit(e)) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
    onProgress?.(i + 1, ranges.length);
  }
  return out;
}

/** Decodes raw logs against the resolver ABI, oldest first. */
export function parseResolverLogs(logs: Log[]) {
  return parseEventLogs({ abi: resolverAbi, logs }).sort((a, b) =>
    a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : (a.blockNumber ?? 0n) < (b.blockNumber ?? 0n) ? -1 : 1,
  );
}

export type ParsedResolverLog = ReturnType<typeof parseResolverLogs>[number];

/** Replays Linked events into the current node -> { recordId, name } map. */
export function replayLinks(logs: ParsedResolverLog[]) {
  const map = new Map<Hex, { recordId: bigint; name: string }>();
  for (const l of logs) {
    if (l.eventName !== "Linked") continue;
    const { recordId, node, name } = l.args;
    map.set(node, { recordId, name: tryDnsDecode(name) ?? name });
  }
  return map;
}

/** Replays EACRolesChanged into the current (resource, account) -> bitmap map, dropping empty entries. */
export function replayRoles(logs: ParsedResolverLog[]) {
  const map = new Map<string, { resource: bigint; account: Address; bitmap: bigint }>();
  const args = new Map<bigint, Hex>();
  for (const l of logs) {
    if (l.eventName === "EACRolesChanged") {
      const { resource, account, newRoleBitmap } = l.args;
      const key = `${resource}:${account.toLowerCase()}`;
      if (newRoleBitmap === 0n) map.delete(key);
      else map.set(key, { resource, account, bitmap: newRoleBitmap });
    } else if (l.eventName === "ResourceArgument") {
      args.set(l.args.resource, l.args.arg);
    }
  }
  return { holders: [...map.values()], resourceArgs: args };
}

/** Builds setter calldata for the doc's "only the selector and argument matter" grants. */
export function setterForGrant(kind: ScopedKind, arg: string): Hex {
  switch (kind) {
    case "text":
      return encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: ["0x", arg, ""] });
    case "data":
      return encodeFunctionData({ abi: resolverAbi, functionName: "setData", args: ["0x", arg, "0x"] });
    case "address":
      return encodeFunctionData({ abi: resolverAbi, functionName: "setAddress", args: ["0x", BigInt(arg), "0x"] });
    case "abi":
      return encodeFunctionData({ abi: resolverAbi, functionName: "setABI", args: ["0x", BigInt(arg), "0x"] });
    case "interface":
      return encodeFunctionData({
        abi: resolverAbi,
        functionName: "setInterface",
        args: ["0x", arg as Hex, "0x0000000000000000000000000000000000000000"],
      });
  }
}

/** Local mirror of decodeSetter's resource derivation, to cross-check the contract. */
export function localResource(kind: ScopedKind, arg: string): bigint {
  switch (kind) {
    case "text":
    case "data":
      return keyResource(arg);
    case "address":
    case "abi":
      return uintResource(BigInt(arg));
    case "interface":
      return bytes4Resource(arg as Hex);
  }
}

const UINT_ROLES = ResolverRoles.ROLE_SET_ADDRESS | ResolverRoles.ROLE_SET_ABI;
const KEY_ROLES = ResolverRoles.ROLE_SET_TEXT | ResolverRoles.ROLE_SET_DATA;

/**
 * Human-readable form of a ResourceArgument `arg`. `roleBitmap` (roles held at
 * that resource) disambiguates a 32-byte key from a coin type / content type.
 */
export function describeArg(arg: Hex, roleBitmap = 0n): string {
  const b = hexToBytes(arg);
  const regular = withAdminRolesApplied(roleBitmap) | roleBitmap;
  if (regular & ResolverRoles.ROLE_SET_INTERFACE && b.length === 4) return `interfaceId ${arg}`;
  if (regular & UINT_ROLES && b.length === 32) return `${regular & ResolverRoles.ROLE_SET_ABI ? "contentType" : "coinType"} ${BigInt(arg)}`;
  if (regular & KEY_ROLES || b.length !== 32) {
    try {
      return `key "${new TextDecoder("utf-8", { fatal: true }).decode(b)}"`;
    } catch {
      return arg;
    }
  }
  return `${arg} (uint ${BigInt(arg)})`;
}
