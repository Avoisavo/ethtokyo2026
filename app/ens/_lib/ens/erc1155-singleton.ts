// Helpers for the ERC1155Singleton playground (see /ensv2/erc1155-singleton).
// Mirrors contracts-v2@71a3b73:
//   src/erc1155/ERC1155Singleton.sol, src/erc1155/interfaces/IERC1155Singleton.sol
//   src/registry/PermissionedRegistry.sol (ownerOf/_update/unsafeTransfer overrides)

import { type Address, type Hex, toFunctionSelector, zeroAddress } from "viem";

import { ENSV2_SEPOLIA } from "./deployments";
import { labelId, parseUint256, tryNormalize } from "./names";
import { ALL_ROLES, REGISTRY_ROLE_TABLE, RegistryRoles, nybbleAt } from "./roles";

// --- ERC-165 interface IDs --------------------------------------------------

/**
 * `type(I).interfaceId`: XOR of the selectors declared in the interface body.
 * Inherited functions do not count, which is why IERC1155Singleton's ID is
 * just the `ownerOf(uint256)` selector.
 */
export function interfaceIdOf(signatures: readonly string[]): Hex {
  let id = 0;
  for (const s of signatures) id ^= parseInt(toFunctionSelector(s).slice(2), 16);
  return `0x${(id >>> 0).toString(16).padStart(8, "0")}`;
}

export type InterfaceSpec = {
  name: string;
  signatures: readonly string[];
  /** Whether a PermissionedRegistry is expected to report support. */
  expected: boolean;
  note: string;
};

export const INTERFACES: InterfaceSpec[] = [
  { name: "IERC165", signatures: ["supportsInterface(bytes4)"], expected: true, note: "Interface detection itself." },
  {
    name: "IERC1155",
    signatures: [
      "balanceOf(address,uint256)",
      "balanceOfBatch(address[],uint256[])",
      "setApprovalForAll(address,bool)",
      "isApprovedForAll(address,address)",
      "safeTransferFrom(address,address,uint256,uint256,bytes)",
      "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)",
    ],
    expected: true,
    note: "What wallets, marketplaces and indexers look for.",
  },
  {
    name: "IERC1155MetadataURI",
    signatures: ["uri(uint256)"],
    expected: true,
    note: "uri() is abstract in ERC1155Singleton; PermissionedRegistry implements it.",
  },
  {
    name: "IERC1155Singleton",
    signatures: ["ownerOf(uint256)"],
    expected: true,
    note: "Declares only ownerOf; the IERC1155 functions it inherits are excluded from its ID.",
  },
  {
    name: "IUnsafeTransferable",
    signatures: ["unsafeTransfer(address,uint256,bytes)", "unsafeBatchTransfer(address,uint256[],bytes)"],
    expected: true,
    note: "Added by PermissionedRegistry, not by the ERC1155Singleton base.",
  },
  {
    name: "IERC721",
    signatures: [
      "balanceOf(address)",
      "ownerOf(uint256)",
      "safeTransferFrom(address,address,uint256,bytes)",
      "safeTransferFrom(address,address,uint256)",
      "transferFrom(address,address,uint256)",
      "approve(address,uint256)",
      "setApprovalForAll(address,bool)",
      "getApproved(uint256)",
      "isApprovedForAll(address,address)",
    ],
    expected: false,
    note: "Names are not ERC721 tokens, even though ownerOf shares ERC721's selector.",
  },
];

export const IERC1155_SINGLETON_ID = interfaceIdOf(["ownerOf(uint256)"]);

/** Receivers that are contracts must implement this or safe/unsafe transfers to them revert. */
export const IERC1155_RECEIVER_ID = interfaceIdOf([
  "onERC1155Received(address,address,uint256,uint256,bytes)",
  "onERC1155BatchReceived(address,address,uint256[],uint256[],bytes)",
]);

// --- Registries -------------------------------------------------------------

export const KNOWN_REGISTRIES = [
  { name: "ETHRegistry", address: ENSV2_SEPOLIA.ETHRegistry.address, deployBlock: ENSV2_SEPOLIA.ETHRegistry.deployBlock },
  { name: "RootRegistry", address: ENSV2_SEPOLIA.RootRegistry.address, deployBlock: ENSV2_SEPOLIA.RootRegistry.deployBlock },
] as const;

/** No ENSv2 registry can predate the deployment itself. */
export const ENSV2_START_BLOCK: bigint = (Object.values(ENSV2_SEPOLIA) as { deployBlock?: bigint }[]).reduce<bigint>(
  (min, d) => (d.deployBlock !== undefined && d.deployBlock < min ? d.deployBlock : min),
  ENSV2_SEPOLIA.ETHRegistry.deployBlock,
);

export function knownRegistry(address: string) {
  return KNOWN_REGISTRIES.find((r) => r.address.toLowerCase() === address.toLowerCase()) ?? null;
}

/** Log queries start at the registry's deploy block when known, else at the ENSv2 deployment. */
export const historyStartBlock = (registry: string) => knownRegistry(registry)?.deployBlock ?? ENSV2_START_BLOCK;

/** Registry `Status` enum. */
export const STATUS = ["AVAILABLE", "RESERVED", "REGISTERED"] as const;
export const statusTone = (s: number) => (s === 2 ? "success" : s === 1 ? "warning" : "neutral") as "success" | "warning" | "neutral";

// --- Examples verified on Sepolia (2026-09-26) ------------------------------

export const EXAMPLES = [
  { name: "ens-demo.eth", note: "regenerated (v1), other role assignees" },
  { name: "ensforge.eth", note: "owner is the sole assignee" },
  { name: "tester.pandas.eth", note: "UserRegistry, not emancipated" },
  { name: "holdmuclrjhv.workflow.eth", note: "owner lacks ROLE_CAN_TRANSFER_ADMIN" },
  { name: "eth", note: "the .eth token in RootRegistry" },
  { name: "nick.eth", note: "RESERVED: no token owner" },
] as const;

// --- Token ID inputs --------------------------------------------------------

/**
 * One entry of a token list: a label (resolved to the current token ID via
 * getTokenId) or a raw uint256 (used verbatim, so stale IDs can be tried).
 * `parentSuffix` (e.g. ".eth") lets users type full names in the same registry.
 */
export type TokenRef = { input: string; label: string | null; raw: bigint | null; error: string | null };

export function parseTokenRef(input: string, parentSuffix: string | null): TokenRef {
  const s = input.trim();
  const raw = parseUint256(s);
  if (raw !== null) return { input: s, label: null, raw, error: null };
  let label = s;
  if (s.includes(".")) {
    if (!parentSuffix || !s.endsWith(parentSuffix) || s.slice(0, -parentSuffix.length).includes(".")) {
      return { input: s, label: null, raw: null, error: "Use a label or token ID in this registry" };
    }
    label = s.slice(0, -parentSuffix.length);
  }
  const normalized = tryNormalize(label);
  if (!normalized) return { input: s, label: null, raw: null, error: "Invalid label" };
  return { input: s, label: normalized, raw: null, error: null };
}

export const parseTokenRefs = (text: string, parentSuffix: string | null) =>
  text
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => parseTokenRef(l, parentSuffix));

/** The anyId to feed getTokenId for a label ref (labelhash). */
export const refAnyId = (ref: TokenRef): bigint | null => (ref.raw ?? (ref.label !== null ? labelId(ref.label) : null));

// --- Metadata ---------------------------------------------------------------

/** EIP-1155 `{id}` substitution: lowercase hex, zero-padded to 64 chars, no 0x. */
export const substituteId = (uri: string, tokenId: bigint) => uri.replaceAll("{id}", tokenId.toString(16).padStart(64, "0"));

// --- Roles ------------------------------------------------------------------

export const hasCanTransferAdmin = (roles: bigint) => (roles & RegistryRoles.ROLE_CAN_TRANSFER_ADMIN) !== 0n;

/** Mirrors EnhancedAccessControl.isOnlyAssignee(resource, ALL_ROLES, account). */
export const isOnlyAssignee = (counts: bigint, accountRoles: bigint) => counts !== 0n && counts === (accountRoles & ALL_ROLES);

const nybbleName = (n: number) => {
  const regular = REGISTRY_ROLE_TABLE.find((r) => r.nybble === n);
  if (regular) return regular.name;
  const admin = REGISTRY_ROLE_TABLE.find((r) => r.nybble + 32 === n);
  return admin ? `${admin.name}_ADMIN` : `nybble ${n}`;
};

/** Roles on a resource held by accounts other than `account`, with how many. */
export function otherAssignees(counts: bigint, accountRoles: bigint): { role: string; others: number }[] {
  const out: { role: string; others: number }[] = [];
  for (let n = 0; n < 64; n++) {
    const others = nybbleAt(counts, n) - nybbleAt(accountRoles, n);
    if (others > 0) out.push({ role: nybbleName(n), others });
  }
  return out;
}

// --- Transfer pre-flight ----------------------------------------------------

export type TokenReads = {
  ref: string;
  /** The ID that would be passed to the contract. */
  tokenId: bigint;
  /** getTokenId(tokenId): the name's current token ID. */
  currentTokenId?: bigint;
  /** latestOwnerOf(tokenId): raw `_owners[id]`, what ERC1155Singleton._update compares against. */
  rawOwner?: Address;
  /** roles(tokenId, from): what PermissionedRegistry._update checks for ROLE_CAN_TRANSFER_ADMIN. */
  fromRoles?: bigint;
  /** roleCount(tokenId): per-role assignee counts on the token's current resource. */
  counts?: bigint;
};

export type CheckState = "ok" | "fail" | "skip" | "pending";

export type Check = { title: string; state: CheckState; detail?: string; error?: string };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

type Common = {
  caller?: Address;
  to?: Address;
  /** isApprovedForAll(owner, caller) */
  approved?: boolean;
  tokens: TokenReads[];
  toIsContract?: boolean;
  toSupportsReceiver?: boolean;
  /** Token refs are still resolving to IDs. */
  loading?: boolean;
};

function tokenChecks(from: Address | undefined, tokens: TokenReads[], value: bigint, safe: boolean, emancipated?: boolean) {
  const out: Check[] = [];
  for (const t of tokens) {
    const tag = tokens.length > 1 ? `[${t.ref}] ` : "";
    if (value === 0n) {
      out.push({ title: `${tag}Ownership (skipped for value 0)`, state: "skip", detail: "ERC1155Singleton only checks the owner when value > 0." });
    } else if (t.rawOwner === undefined || !from) {
      out.push({ title: `${tag}from owns the token ID`, state: "pending" });
    } else {
      const stale = t.currentTokenId !== undefined && t.currentTokenId !== t.tokenId;
      out.push({
        title: `${tag}from owns this exact token ID`,
        state: same(t.rawOwner, from) ? "ok" : "fail",
        detail:
          t.rawOwner === zeroAddress
            ? stale
              ? "Stale ID: it was burned when the token regenerated or the name was re-registered."
              : "No token with this ID exists (never minted or burned)."
            : `latestOwnerOf = ${short(t.rawOwner)}`,
        error: same(t.rawOwner, from) ? undefined : "ERC1155InsufficientBalance(from, 0, value, id)",
      });
    }
    if (value > 1n) {
      out.push({ title: `${tag}value ≤ 1`, state: "fail", detail: "A singleton holds at most one unit.", error: "ERC1155InsufficientBalance(from, 1, value, id)" });
    }
  }
  if (safe) {
    out.push({
      title: "Registry is emancipated",
      state: emancipated === undefined ? "pending" : emancipated ? "ok" : "fail",
      detail: "Checked on every safe transfer: no account may hold a dangerous role on ROOT_RESOURCE.",
      error: emancipated === false ? "TransferUnsafeUntilRegistryIsEmancipated()" : undefined,
    });
  }
  for (const t of tokens) {
    const tag = tokens.length > 1 ? `[${t.ref}] ` : "";
    if (t.fromRoles === undefined || !from) {
      out.push({ title: `${tag}Owner holds ROLE_CAN_TRANSFER_ADMIN`, state: "pending" });
    } else {
      const ok = hasCanTransferAdmin(t.fromRoles);
      out.push({
        title: `${tag}Owner holds ROLE_CAN_TRANSFER_ADMIN`,
        state: ok ? "ok" : "fail",
        detail: "Always checked against the token's owner, whoever sends the transaction.",
        error: ok ? undefined : "TransferDisallowed(tokenId, from)",
      });
    }
    if (!safe) continue;
    if (t.counts === undefined || t.fromRoles === undefined) {
      out.push({ title: `${tag}Owner is the only role assignee`, state: "pending" });
    } else {
      const ok = isOnlyAssignee(t.counts, t.fromRoles);
      const others = otherAssignees(t.counts, t.fromRoles);
      out.push({
        title: `${tag}Owner is the only role assignee`,
        state: ok ? "ok" : "fail",
        detail: ok
          ? "roleCount(token) equals the owner's roles, so nobody else controls part of the name."
          : others.length
            ? `Held by other accounts: ${others.map((o) => `${o.role}×${o.others}`).join(", ")}`
            : "The owner holds no roles on the token.",
        error: ok ? undefined : "TransferUnsafeWithMultipleAssignees(tokenId, from)",
      });
    }
  }
  return out;
}

function receiverCheck(to: Address | undefined, isContract?: boolean, supports?: boolean): Check {
  if (!to) return { title: "Receiver accepts ERC1155", state: "pending" };
  if (isContract === undefined) return { title: "Receiver accepts ERC1155", state: "pending" };
  if (!isContract) return { title: "Receiver accepts ERC1155", state: "ok", detail: "Recipient is an EOA; no acceptance hook." };
  return {
    title: "Receiver accepts ERC1155",
    state: supports ? "ok" : "fail",
    detail: supports
      ? "Contract reports IERC1155Receiver; it must still return the magic value."
      : "Contract recipient does not report IERC1155Receiver (0x4e2312e0); the acceptance call will likely revert.",
    error: supports ? undefined : "ERC1155InvalidReceiver(to)",
  };
}

/** Checks for safeTransferFrom / safeBatchTransferFrom, in the order the contract evaluates them. */
export function safeTransferChecks(p: Common & { from?: Address; value: bigint; emancipated?: boolean }): Check[] {
  const checks: Check[] = [];
  const approvalOk = !!p.caller && !!p.from && (same(p.caller, p.from) || p.approved === true);
  checks.push({
    title: "Caller is from, or an approved operator",
    state: !p.caller || !p.from || (!same(p.caller, p.from) && p.approved === undefined) ? "pending" : approvalOk ? "ok" : "fail",
    error: approvalOk ? undefined : "ERC1155MissingApprovalForAll(caller, from)",
  });
  checks.push({
    title: "to is not the zero address",
    state: !p.to ? "pending" : p.to === zeroAddress ? "fail" : "ok",
    error: p.to === zeroAddress ? "ERC1155InvalidReceiver(0x0)" : undefined,
  });
  checks.push({
    title: "from is not the zero address",
    state: !p.from ? "pending" : p.from === zeroAddress ? "fail" : "ok",
    error: p.from === zeroAddress ? "ERC1155InvalidSender(0x0)" : undefined,
  });
  checks.push(...tokenChecks(p.from, p.tokens, p.value, true, p.emancipated));
  checks.push(receiverCheck(p.to, p.toIsContract, p.toSupportsReceiver));
  return checks;
}

/**
 * Checks for unsafeTransfer / unsafeBatchTransfer. `owner` is ownerOf(ids[0]),
 * the expiry- and version-aware owner the contract derives itself.
 */
export function unsafeTransferChecks(p: Common & { owner?: Address; emancipated?: boolean; ownerIsOnly?: boolean }): Check[] {
  const checks: Check[] = [];
  checks.push({
    title: "to is not the zero address",
    state: !p.to ? "pending" : p.to === zeroAddress ? "fail" : "ok",
    error: p.to === zeroAddress ? "ERC1155InvalidReceiver(0x0)" : undefined,
  });
  checks.push({
    title: "At least one token ID",
    state: p.tokens.length ? "ok" : p.loading ? "pending" : "fail",
    error: p.tokens.length || p.loading ? undefined : "ERC1155InvalidSender(0x0)",
  });
  const ownerKnown = p.owner !== undefined;
  const approvalOk = !!p.caller && ownerKnown && p.owner !== zeroAddress && (same(p.caller, p.owner) || p.approved === true);
  checks.push({
    title: "Caller is ownerOf(first ID), or an approved operator",
    state: !p.caller || !ownerKnown || (!same(p.caller, p.owner) && p.owner !== zeroAddress && p.approved === undefined) ? "pending" : approvalOk ? "ok" : "fail",
    detail:
      p.owner === zeroAddress
        ? "ownerOf(first ID) is 0x0 (stale ID, expired or unregistered), so nobody can pass the approval check."
        : p.owner
          ? `ownerOf = ${short(p.owner)}`
          : undefined,
    error: approvalOk ? undefined : "ERC1155MissingApprovalForAll(caller, owner)",
  });
  checks.push(...tokenChecks(p.owner, p.tokens, 1n, false));
  checks.push({
    title: "Registry is emancipated",
    state: "skip",
    detail: p.emancipated === undefined ? "Not checked by unsafe transfers." : `Not checked by unsafe transfers (isEmancipated = ${p.emancipated}).`,
  });
  checks.push({
    title: "Owner is the only role assignee",
    state: "skip",
    detail:
      p.ownerIsOnly === undefined
        ? "Not checked by unsafe transfers."
        : `Not checked by unsafe transfers (${p.ownerIsOnly ? "owner is the only assignee" : "other accounts keep their roles"}).`,
  });
  checks.push(receiverCheck(p.to, p.toIsContract, p.toSupportsReceiver));
  return checks;
}

/** First failing check, i.e. the revert the contract would hit first. */
export const firstFailure = (checks: Check[]) => checks.find((c) => c.state === "fail") ?? null;
export const allPass = (checks: Check[]) => checks.every((c) => c.state === "ok" || c.state === "skip");

