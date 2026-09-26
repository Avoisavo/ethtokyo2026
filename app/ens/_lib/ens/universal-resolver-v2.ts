// Helpers for the Universal Resolver V2 playground: resolver calldata
// builders/decoders, DNS wire-format parsing, ENSIP-19 reverse names,
// contenthash decoding and Universal Resolver error decoding.

import {
  type Address,
  type Hex,
  bytesToHex,
  bytesToString,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  isHex,
  parseAbi,
  size,
  toFunctionSelector,
  toHex,
} from "viem";
import { toCoinType } from "viem/ens";

import { UniversalResolverV2Abi } from "./abis/UniversalResolverV2";
import { decodeEnsError } from "./errors";

// --- Resolver profiles ------------------------------------------------------

/** Standard resolver profile functions, as called through UniversalResolver.resolve(). */
export const resolverProfileAbi = parseAbi([
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
  "function contenthash(bytes32 node) view returns (bytes)",
  "function name(bytes32 node) view returns (string)",
  "function multicall(bytes[] data) returns (bytes[] results)",
]);

export const COIN_TYPE_ETH = 60n;
/** ENSIP-19 default EVM coin type (applies to every EVM chain without a specific record). */
export const COIN_TYPE_DEFAULT = 0x80000000n;

export const COIN_TYPE_PRESETS: { label: string; value: bigint }[] = [
  { label: "ETH (60)", value: COIN_TYPE_ETH },
  { label: "Default EVM (0x80000000)", value: COIN_TYPE_DEFAULT },
  { label: "Base Sepolia (84532)", value: toCoinType(84532) },
  { label: "OP Sepolia (11155420)", value: toCoinType(11155420) },
  { label: "Arbitrum Sepolia (421614)", value: toCoinType(421614) },
  { label: "Linea Sepolia (59141)", value: toCoinType(59141) },
  { label: "Scroll Sepolia (534351)", value: toCoinType(534351) },
  { label: "Base (8453)", value: toCoinType(8453) },
  { label: "OP Mainnet (10)", value: toCoinType(10) },
  { label: "Bitcoin (0, SLIP-44)", value: 0n },
];

export function coinTypeLabel(coinType: bigint): string {
  const preset = COIN_TYPE_PRESETS.find((p) => p.value === coinType);
  if (preset) return preset.label;
  if (coinType > COIN_TYPE_DEFAULT && coinType < 0x100000000n) return `EVM chain ${coinType - COIN_TYPE_DEFAULT}`;
  return coinType.toString();
}

export const isEvmCoinType = (coinType: bigint) =>
  coinType === COIN_TYPE_ETH || (coinType >= COIN_TYPE_DEFAULT && coinType < 0x100000000n);

export type RecordQuery =
  | { kind: "addr" }
  | { kind: "addrCoin"; coinType: bigint }
  | { kind: "text"; key: string }
  | { kind: "contenthash" }
  | { kind: "name" }
  | { kind: "raw"; data: Hex };

export function describeQuery(q: RecordQuery): string {
  switch (q.kind) {
    case "addr":
      return "addr(node)";
    case "addrCoin":
      return `addr(node, ${q.coinType})`;
    case "text":
      return `text(node, "${q.key}")`;
    case "contenthash":
      return "contenthash(node)";
    case "name":
      return "name(node)";
    case "raw":
      return `raw ${q.data.slice(0, 10)}`;
  }
}

export function encodeRecordCall(q: RecordQuery, node: Hex): Hex {
  switch (q.kind) {
    case "addr":
      return encodeFunctionData({ abi: resolverProfileAbi, functionName: "addr", args: [node] });
    case "addrCoin":
      return encodeFunctionData({ abi: resolverProfileAbi, functionName: "addr", args: [node, q.coinType] });
    case "text":
      return encodeFunctionData({ abi: resolverProfileAbi, functionName: "text", args: [node, q.key] });
    case "contenthash":
      return encodeFunctionData({ abi: resolverProfileAbi, functionName: "contenthash", args: [node] });
    case "name":
      return encodeFunctionData({ abi: resolverProfileAbi, functionName: "name", args: [node] });
    case "raw":
      return q.data;
  }
}

export const encodeMulticall = (calls: Hex[]): Hex =>
  encodeFunctionData({ abi: resolverProfileAbi, functionName: "multicall", args: [calls] });

export const decodeMulticall = (data: Hex): readonly Hex[] =>
  decodeFunctionResult({ abi: resolverProfileAbi, functionName: "multicall", data });

export type DecodedRecord =
  | { ok: true; empty: boolean; display: string; value: unknown }
  | { ok: false; error: UrError | null; raw: Hex };

/**
 * Decodes one resolver answer. Inside a multicall the Universal Resolver
 * returns failed calls inline (their revert data) instead of reverting.
 */
export function decodeRecordResult(q: RecordQuery, data: Hex): DecodedRecord {
  if (data === "0x") return { ok: false, error: null, raw: data };
  if (size(data) % 32 === 4) {
    const err = decodeUrErrorData(data);
    if (err) return { ok: false, error: err, raw: data };
  }
  try {
    switch (q.kind) {
      case "addr": {
        const a = decodeFunctionResult({ abi: resolverProfileAbi, functionName: "addr", args: ["0x"], data });
        const empty = BigInt(a) === 0n;
        return { ok: true, empty, display: empty ? "(no address)" : getAddress(a), value: a };
      }
      case "addrCoin": {
        const b = decodeFunctionResult({ abi: resolverProfileAbi, functionName: "addr", args: ["0x", 0n], data });
        if (b === "0x") return { ok: true, empty: true, display: "(no address)", value: b };
        const display = isEvmCoinType(q.coinType) && size(b) === 20 ? getAddress(b) : b;
        return { ok: true, empty: false, display, value: b };
      }
      case "text": {
        const s = decodeFunctionResult({ abi: resolverProfileAbi, functionName: "text", data });
        return { ok: true, empty: s === "", display: s === "" ? "(empty)" : s, value: s };
      }
      case "contenthash": {
        const b = decodeFunctionResult({ abi: resolverProfileAbi, functionName: "contenthash", data });
        if (b === "0x") return { ok: true, empty: true, display: "(no contenthash)", value: b };
        const decoded = decodeContenthash(b);
        return { ok: true, empty: false, display: decoded ? decoded.uri : b, value: { raw: b, ...decoded } };
      }
      case "name": {
        const s = decodeFunctionResult({ abi: resolverProfileAbi, functionName: "name", data });
        return { ok: true, empty: s === "", display: s === "" ? "(empty)" : s, value: s };
      }
      case "raw":
        return { ok: true, empty: false, display: data, value: data };
    }
  } catch {
    return { ok: true, empty: false, display: data, value: data };
  }
}

// --- DNS wire format ---------------------------------------------------------

export type DnsLabel = { offset: number; length: number; label: string };

/** Splits DNS wire-format bytes into labels with their byte offsets. Throws on malformed input. */
export function parseDnsName(dns: Hex): DnsLabel[] {
  const bytes = hexToBytes(dns);
  const labels: DnsLabel[] = [];
  let i = 0;
  for (;;) {
    if (i >= bytes.length) throw new Error("DNS name is missing its 0x00 terminator");
    const len = bytes[i];
    if (len === 0) {
      if (i !== bytes.length - 1) throw new Error("Trailing bytes after the 0x00 terminator");
      return labels;
    }
    if (i + 1 + len > bytes.length) throw new Error(`Label at offset ${i} overruns the input`);
    labels.push({ offset: i, length: len, label: bytesToString(bytes.slice(i + 1, i + 1 + len)) });
    i += 1 + len;
  }
}

/** DNS wire format -> dotted name ("" for the root). Returns null for empty or malformed input. */
export function dnsDecode(dns: Hex): string | null {
  if (dns === "0x") return null;
  try {
    return parseDnsName(dns)
      .map((l) => l.label)
      .join(".");
  } catch {
    return null;
  }
}

/** `name[offset:]` from the docs: the ancestor whose label boundary starts at `offset`. */
export function suffixAt(dns: Hex, offset: number | bigint): string | null {
  const o = Number(offset);
  const bytes = hexToBytes(dns);
  if (o < 0 || o >= bytes.length) return null;
  return dnsDecode(bytesToHex(bytes.slice(o)));
}

/** Byte offset of `suffix` inside the DNS encoding of `name` (the suffix must end the name). */
export function offsetOfSuffix(name: string, suffix: string): number {
  const nameLen = name === "" ? 1 : new TextEncoder().encode(name).length + 2;
  const suffixLen = suffix === "" ? 1 : new TextEncoder().encode(suffix).length + 2;
  return nameLen - suffixLen;
}

// --- ENSIP-19 reverse names ---------------------------------------------------

/** `<hex>.addr.reverse`, `<hex>.default.reverse` or `<hex>.<coinTypeHex>.reverse` (ENSIP-19). */
export function reverseName(lookupAddress: Hex, coinType: bigint): string {
  const hex = lookupAddress.slice(2).toLowerCase();
  const ns = coinType === COIN_TYPE_ETH ? "addr" : coinType === COIN_TYPE_DEFAULT ? "default" : coinType.toString(16);
  return `${hex}.${ns}.reverse`;
}

// --- Contenthash (ENSIP-7) ----------------------------------------------------

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base58(bytes: Uint8Array): string {
  let n = BigInt(bytesToHex(bytes));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readVarint(bytes: Uint8Array, start: number): [value: number, next: number] {
  let value = 0;
  let shift = 0;
  let i = start;
  for (; i < bytes.length; i++) {
    value += (bytes[i] & 0x7f) * 2 ** shift;
    shift += 7;
    if ((bytes[i] & 0x80) === 0) return [value, i + 1];
  }
  throw new Error("bad varint");
}

/** Decodes the common ENSIP-7 contenthash codecs; returns null for unknown ones. */
export function decodeContenthash(hex: Hex): { protocol: string; uri: string } | null {
  try {
    const bytes = hexToBytes(hex);
    const [codec, next] = readVarint(bytes, 0);
    const rest = bytes.slice(next);
    switch (codec) {
      case 0xe3: {
        // ipfs-ns: CIDv0 (bare sha2-256 multihash) or CIDv1
        if (rest[0] === 0x12 && rest[1] === 0x20) return { protocol: "ipfs", uri: `ipfs://${base58(rest)}` };
        return { protocol: "ipfs", uri: `ipfs://b${base32(rest)}` };
      }
      case 0xe5:
        return { protocol: "ipns", uri: `ipns://b${base32(rest)}` };
      case 0xe4:
        return { protocol: "swarm", uri: `bzz://${bytesToHex(rest.slice(-32)).slice(2)}` };
      case 0xb29910:
        return { protocol: "arweave", uri: `ar://${base64url(rest)}` };
      case 0x01bc:
        return { protocol: "onion", uri: `onion://${bytesToString(rest)}` };
      case 0x01bd:
        return { protocol: "onion3", uri: `onion3://${bytesToString(rest)}` };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// --- Selectors ----------------------------------------------------------------

const knownSelectors = new Map<Hex, string>();
for (const item of [...UniversalResolverV2Abi, ...resolverProfileAbi]) {
  if (item.type !== "function") continue;
  const sel = toFunctionSelector(item);
  if (!knownSelectors.has(sel)) knownSelectors.set(sel, `${item.name}(${item.inputs.map((i) => i.type).join(",")})`);
}
knownSelectors.set(toFunctionSelector("function resolve(bytes,bytes)"), "resolve(bytes,bytes) (IExtendedResolver)");
// Gateway request formats seen in OffchainLookup.callData.
knownSelectors.set(toFunctionSelector("function query((address,string[],bytes)[])"), "query((address,string[],bytes)[]) (batch gateway request)");
knownSelectors.set(toFunctionSelector("function resolve(bytes,uint16)"), "resolve(bytes name, uint16 qtype) (DNSSEC oracle request)");

/** Human name for a 4-byte selector of a UR or resolver-profile function. */
export const selectorName = (sel: Hex): string | undefined => knownSelectors.get(sel.slice(0, 10).toLowerCase() as Hex);

const xorSelectors = (sigs: string[]): Hex =>
  toHex(
    sigs.map((s) => BigInt(toFunctionSelector(s))).reduce((a, b) => a ^ b, 0n),
    { size: 4 },
  );

/** ERC-165 interface IDs advertised by UniversalResolverV2 (see its supportsInterface). */
export const UR_INTERFACES: { name: string; id: Hex; note: string }[] = [
  {
    name: "IUniversalResolver",
    id: xorSelectors(["function resolve(bytes,bytes)", "function reverse(bytes,uint256)", "function findResolver(bytes)"]),
    note: "resolve, reverse, findResolver (shared with URv1)",
  },
  { name: "IUniversalResolverExtended", id: "0x9e2af83e", note: "requireResolver, resolveWithResolver, *WithGateways" },
  { name: "INormalizedUniversalResolver", id: "0xfe0badd6", note: "*WithNormalization, normalize, isENSv2" },
  { name: "INormalizedUniversalResolverExtended", id: "0x17cd12d9", note: "*WithGatewaysAndNormalization" },
  { name: "IContractNamer", id: "0x6f3ff726", note: "isContractNamer (delegated to CONTRACT_NAMER)" },
  { name: "IERC165", id: "0x01ffc9a7", note: "supportsInterface" },
];

export const IEXTENDED_RESOLVER_ID: Hex = "0x9061b923";

// --- Errors -------------------------------------------------------------------

/** Explanations for every custom error in the UniversalResolverV2 ABI (plus a few resolvers raise inside ResolverError). */
export const UR_ERROR_INFO: Record<string, string> = {
  ResolverNotFound:
    "No resolver on the path, or the nearest one was found at a parent (offset ≠ 0) and does not support IExtendedResolver (ENSIP-10 wildcard), so it may only serve exact matches.",
  ResolverNotContract:
    "The resolver matched exactly (offset 0), is not an IExtendedResolver and has no code (e.g. an EOA was set as resolver).",
  UnsupportedResolverProfile:
    "The resolver returned no data for this selector: it does not implement the requested profile (e.g. an unknown function).",
  ResolverError:
    "The resolver itself reverted. The wrapped errorData is the resolver's own revert payload, decoded below when recognized.",
  ReverseAddressMismatch:
    "Reverse resolution found a primary name, but forward-resolving that name for the same coin type returned a different (or empty) address, so the claim is rejected onchain.",
  NormalizationChangedName:
    "A *WithNormalization call got a non-normalized name. The error carries the normalized name and the result for it.",
  PrimaryNameNotNormalized: "A *WithNormalization reverse call found a primary name that is not ENSIP-15 normalized.",
  HttpError: "A CCIP-Read gateway answered with an HTTP error (surfaced through the batch gateway).",
  DNSDecodingFailed: "The `name` bytes are not valid DNS wire format (bad length prefix or missing 0x00 terminator).",
  DNSEncodingFailed: "A dotted name could not be DNS-encoded (e.g. a primary name containing an empty or >255-byte label).",
  EmptyAddress: "reverse() was called with an empty lookupAddress.",
  InvalidBatchGatewayResponse: "The batch gateway response could not be decoded.",
  UnsafeBatchGatewayResponse: "The batch gateway response failed the Universal Resolver's safety checks.",
  LabelIsEmpty: "A label in the name is empty (e.g. `a..eth`).",
  LabelIsTooLong: "A label is longer than 255 bytes.",
  OffsetOutOfBoundsError: "An internal offset ran past the end of the input bytes.",
  OffchainLookup:
    "EIP-3668 CCIP-Read request, not a failure: the client must query the listed gateway URLs and call the callback. viem does this automatically.",
  UnreachableName:
    "Raised by the DNS resolvers (inside ResolverError): the DNS name has no usable ENS1 TXT record / DNSSEC proof, or the TXT target cannot be reached.",
  CannotNormalize: "The ENSIP-15 normalizer rejected a label.",
  EACUnauthorizedAccountRoles: "Access control check failed (not a UR error, but common when writing records).",
};

export type UrError = {
  name: string;
  args: readonly unknown[];
  message: string;
  data: Hex;
  explanation?: string;
  /** Decoded payload of ResolverError(bytes), when present. */
  inner?: UrError | { unknown: Hex };
};

/** Decodes raw revert data against the UR ABI and every ENSv2 error; unwraps ResolverError. */
export function decodeUrErrorData(data: Hex, depth = 0): UrError | null {
  const decoded = decodeEnsError(data);
  if (!decoded) return null;
  const err: UrError = {
    name: decoded.name,
    args: decoded.args ?? [],
    message: decoded.message,
    data,
    explanation: UR_ERROR_INFO[decoded.name],
  };
  if (decoded.name === "ResolverError" && depth < 3) {
    const inner = err.args[0] as Hex;
    err.inner = inner === "0x" ? { unknown: "0x" } : (decodeUrErrorData(inner, depth + 1) ?? { unknown: inner });
  }
  return err;
}

/**
 * Finds revert data anywhere in a viem error chain. Duck-typed on purpose so
 * it works even if the error class came from another viem bundle.
 */
export function extractRevertData(e: unknown): Hex | null {
  let cur: unknown = e;
  for (let i = 0; cur && i < 12; i++) {
    const o = cur as { raw?: unknown; data?: unknown; cause?: unknown };
    if (typeof o.raw === "string" && isHex(o.raw) && o.raw.length >= 10) return o.raw;
    if (typeof o.data === "string" && isHex(o.data) && o.data.length >= 10) return o.data;
    const nested = o.data as { data?: unknown } | undefined;
    if (nested && typeof nested === "object" && typeof nested.data === "string" && isHex(nested.data) && nested.data.length >= 10)
      return nested.data;
    cur = o.cause;
  }
  return null;
}

export function decodeUrError(e: unknown): UrError | null {
  const data = extractRevertData(e);
  return data ? decodeUrErrorData(data) : null;
}

/** Short message for any error, preferring decoded ENS custom errors. */
export function shortError(e: unknown): string {
  const decoded = decodeUrError(e);
  if (decoded) {
    const inner = decoded.inner && "name" in decoded.inner ? ` → ${decoded.inner.message}` : "";
    return `${decoded.message}${inner}`;
  }
  const o = e as { shortMessage?: string; message?: string } | null;
  return o?.shortMessage ?? o?.message ?? String(e);
}

export const isZero = (a: Address | string | null | undefined) => !a || /^0x0{40}$/i.test(a);
