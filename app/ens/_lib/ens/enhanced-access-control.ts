// Enhanced Access Control helpers for the EAC playground page. Mirrors the
// logic of contracts-v2@71a3b73:
//   src/access-control/EnhancedAccessControl.sol (+ EACBaseRolesLib)
//   src/registry/PermissionedRegistry.sol / WrapperRegistry.sol (hook overrides)
//   src/resolver/PermissionedResolver.sol (+ PermissionedResolverLib resources)

import {
  type Address,
  type Hex,
  type PublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  isHex,
  keccak256,
  parseAbi,
  parseAbiItem,
  toHex,
  zeroAddress,
} from "viem";

import { ETHRegistryAbi } from "./abis/ETHRegistry";
import { PermissionedResolverImplAbi } from "./abis/PermissionedResolverImpl";
import { ENSV2_SEPOLIA } from "./deployments";
import { formatError } from "./errors";
import { parseUint256 } from "./names";
import {
  ADMIN_ROLES,
  ALL_ROLES,
  REGISTRY_ROLE_TABLE,
  RESOLVER_ROLE_TABLE,
  ROOT_RESOURCE,
  RegistryRoles,
  ResolverRoles,
  type RoleInfo,
  type RoleScope,
  nybbleAt,
  toHex256,
} from "./roles";

// --- ABI --------------------------------------------------------------------

/**
 * IEnhancedAccessControl (selector 0x0132e43d), identical on every EAC
 * contract. Each signature exists in the deployed ETHRegistry,
 * PermissionedResolverImpl, StandardRentPriceOracle and PermissionedAddressSet ABIs.
 */
export const eacAbi = parseAbi([
  "function ROOT_RESOURCE() view returns (uint256)",
  "function roles(uint256 resource, address account) view returns (uint256)",
  "function roleCount(uint256 resource) view returns (uint256)",
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function getAssigneeCount(uint256 resource, uint256 roleBitmap) view returns (uint256 counts, uint256 mask)",
  "function hasAssignees(uint256 resource, uint256 roleBitmap) view returns (bool)",
  "function isOnlyAssignee(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  "function grantRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)",
  "function revokeRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)",
  "function grantRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error EACCannotRevokeRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error EACRootResourceNotAllowed()",
  "error EACMaxAssignees(uint256 resource, uint256 role)",
  "error EACMinAssignees(uint256 resource, uint256 role)",
  "error EACInvalidRoleBitmap(uint256 roleBitmap)",
  "error EACInvalidAccount()",
]);

export const EAC_ROLES_CHANGED = parseAbiItem(
  "event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap)",
);

/** ERC-165 interface IDs from the contracts-v2 NatSpec ("Interface selector"). */
export const INTERFACE_IDS = {
  eac: "0x0132e43d",
  permissionedRegistry: "0xc18bd555",
  wrapperRegistry: "0xf5586a0b",
  permissionedResolver: "0x8c2427cc",
  addressSet: "0x3d140d21",
  rentPriceOracle: "0x480851dc",
} as const satisfies Record<string, Hex>;

// --- Contract kinds & role tables ---------------------------------------------

export type ContractKind = "registry" | "wrapper-registry" | "resolver" | "oracle" | "address-set" | "eac" | "not-eac";

export const KIND_LABEL: Record<ContractKind, string> = {
  registry: "PermissionedRegistry",
  "wrapper-registry": "WrapperRegistry",
  resolver: "PermissionedResolver",
  oracle: "StandardRentPriceOracle",
  "address-set": "PermissionedAddressSet",
  eac: "EnhancedAccessControl",
  "not-eac": "not EAC",
};

export const isRegistryKind = (k: ContractKind) => k === "registry" || k === "wrapper-registry";

const role = (name: string, nybble: number, scope: RoleScope, description: string): RoleInfo => ({
  name,
  value: 1n << BigInt(nybble * 4),
  nybble,
  scope,
  description,
});

// src/registrar/StandardRentPriceOracle.sol
export const ORACLE_ROLE_TABLE: RoleInfo[] = [
  role("ROLE_UPDATE_TOKEN", 0, "root", "Add or update payment tokens and their exchange rates"),
  role("ROLE_DISABLE_TOKEN", 1, "root", "Disable payment tokens"),
  role("ROLE_CAN_NAME", 2, "root", "Contract naming"),
];

// src/utils/interfaces/IPermissionedAddressSet.sol (HCAUpgradeSet, PublicResolverSet, RegistryUpgradeSet)
export const ADDRESS_SET_ROLE_TABLE: RoleInfo[] = [
  role("ROLE_APPROVE", 0, "root", "Add or remove addresses from the set"),
  role("ROLE_CAN_NAME", 1, "root", "Contract naming"),
];

export type RoleTableKey = "registry" | "resolver" | "oracle" | "addressSet";

export const ROLE_TABLES: Record<RoleTableKey, { label: string; table: RoleInfo[]; source: string }> = {
  registry: { label: "Registry", table: REGISTRY_ROLE_TABLE, source: "RegistryRolesLib.sol" },
  resolver: { label: "Resolver", table: RESOLVER_ROLE_TABLE, source: "PermissionedResolverLib.sol" },
  oracle: { label: "Price oracle", table: ORACLE_ROLE_TABLE, source: "StandardRentPriceOracle.sol" },
  addressSet: { label: "Address set", table: ADDRESS_SET_ROLE_TABLE, source: "IPermissionedAddressSet.sol" },
};

export function tableForKind(kind: ContractKind | undefined): RoleTableKey {
  switch (kind) {
    case "resolver":
      return "resolver";
    case "oracle":
      return "oracle";
    case "address-set":
      return "addressSet";
    default:
      return "registry";
  }
}

// --- Bitmap math (EACBaseRolesLib / EnhancedAccessControl) ---------------------

export const MAX_UINT256 = (1n << 256n) - 1n;
export const REGULAR_ROLES = ALL_ROLES & ~ADMIN_ROLES;
export { toHex256 };

/** Regular roles are discarded and admin roles imply their regular roles. */
export function withAdminRolesApplied(bitmap: bigint): bigint {
  const admins = bitmap >> 128n;
  return (admins << 128n) | admins;
}

/** Roles bitmap with a bit for every nybble whose assignee count is > 0. */
export const fromCounts = (counts: bigint): bigint => (counts | (counts >> 1n) | (counts >> 2n) | (counts >> 3n)) & ALL_ROLES;

/** `_roleBitmapToMask`: 0xF in every nybble that has a role bit. */
export function roleBitmapToMask(bitmap: bigint): bigint {
  let mask = bitmap | (bitmap << 1n);
  mask |= mask << 2n;
  return mask & MAX_UINT256;
}

/** Bits that `_checkRoleBitmap` rejects (anything but bit 0 of a nybble). */
export const invalidBits = (bitmap: bigint): bigint => bitmap & ~ALL_ROLES & MAX_UINT256;

/** The 64 nybble values, index = nybble number. */
export const nybbles = (value: bigint): number[] => Array.from({ length: 64 }, (_, i) => nybbleAt(value, i));

/** Role name for any nybble 0-63 in `table`, or null if no role is defined there. */
export function roleNameAt(table: RoleInfo[], nybble: number): string | null {
  const admin = nybble >= 32;
  const r = table.find((x) => x.nybble === (admin ? nybble - 32 : nybble));
  if (!r) return null;
  // ROLE_CAN_TRANSFER exists only as an admin role; ROLE_WAS_RESERVED has no admin.
  if (!admin && r.name === "ROLE_CAN_TRANSFER") return null;
  if (admin && r.name === "ROLE_WAS_RESERVED") return null;
  return admin ? `${r.name}_ADMIN` : r.name;
}

export type NybbleEntry = { nybble: number; value: number; name: string | null; admin: boolean };

/** Non-zero nybbles of `value`, lowest first. */
export function describeNybbles(value: bigint, table: RoleInfo[]): NybbleEntry[] {
  const out: NybbleEntry[] = [];
  for (let i = 0; i < 64; i++) {
    const v = nybbleAt(value, i);
    if (v) out.push({ nybble: i, value: v, name: roleNameAt(table, i), admin: i >= 32 });
  }
  return out;
}

/** Solidity-style expression, e.g. `ROLE_SET_RESOLVER | ROLE_SET_RESOLVER_ADMIN`. */
export function bitmapExpression(bitmap: bigint, table: RoleInfo[], lang: "sol" | "ts" = "sol"): string {
  if (bitmap === 0n) return "0";
  if (invalidBits(bitmap)) return toHex256(bitmap);
  return describeNybbles(bitmap, table)
    .sort((a, b) => (a.admin === b.admin ? a.nybble - b.nybble : a.admin ? 1 : -1))
    .map((e) => e.name ?? (lang === "ts" ? `(1n << ${e.nybble * 4}n)` : `(1 << ${e.nybble * 4})`))
    .join(" | ");
}

/** Parses a bitmap: decimal, 0x-hex, or role names from `table` joined by `|`, `,` or spaces. */
export function parseBitmapInput(input: string, table: RoleInfo[]): { value: bigint } | { error: string } {
  const s = input.trim();
  if (!s) return { error: "Enter a bitmap" };
  const n = parseUint256(s);
  if (n !== null) return { value: n };
  let value = 0n;
  for (const tok of s.split(/[\s|,+]+/).filter(Boolean)) {
    let hit: bigint | null = null;
    for (let i = 0; i < 64; i++) if (roleNameAt(table, i) === tok) hit = 1n << BigInt(i * 4);
    if (hit === null) return { error: `Unknown role "${tok}" in this table (or not a uint256)` };
    value |= hit;
  }
  return { value };
}

// --- Resources ----------------------------------------------------------------

export type SetterArgType = "text" | "data" | "coinType" | "contentType" | "interfaceId";

export const SETTER_ARGS: Record<
  SetterArgType,
  { label: string; setter: string; role: bigint; roleName: string; placeholder: string; formula: string }
> = {
  text: {
    label: "Text key",
    setter: "setText",
    role: ResolverRoles.ROLE_SET_TEXT,
    roleName: "ROLE_SET_TEXT",
    placeholder: "description",
    formula: "keccak256(bytes(key))",
  },
  data: {
    label: "Data key",
    setter: "setData",
    role: ResolverRoles.ROLE_SET_DATA,
    roleName: "ROLE_SET_DATA",
    placeholder: "my-data",
    formula: "keccak256(bytes(key))",
  },
  coinType: {
    label: "Coin type",
    setter: "setAddress",
    role: ResolverRoles.ROLE_SET_ADDRESS,
    roleName: "ROLE_SET_ADDRESS",
    placeholder: "60",
    formula: "keccak256(abi.encodePacked(uint256 coinType))",
  },
  contentType: {
    label: "ABI content type",
    setter: "setABI",
    role: ResolverRoles.ROLE_SET_ABI,
    roleName: "ROLE_SET_ABI",
    placeholder: "1",
    formula: "keccak256(abi.encodePacked(uint256 contentType))",
  },
  interfaceId: {
    label: "Interface ID",
    setter: "setInterface",
    role: ResolverRoles.ROLE_SET_INTERFACE,
    roleName: "ROLE_SET_INTERFACE",
    placeholder: "0x3b3b57de",
    formula: "keccak256(abi.encodePacked(bytes4 interfaceId))",
  },
};

export type SetterArg = {
  type: SetterArgType;
  /** The raw argument bytes the resolver hashes (and emits in ResourceArgument). */
  arg: Hex;
  resource: bigint;
  role: bigint;
  /**
   * Setter calldata with a placeholder name and empty value, as taken by
   * grantSetterRoles/decodeSetter (only selector + argument matter).
   */
  setterCalldata: Hex;
  /** The same setter against a real name, for simulating a gated write. */
  probeCalldata: (dnsName: Hex) => Hex;
};

/** PermissionedResolverLib.resource(<argument>) and matching setter calldata. */
export function parseSetterArg(type: SetterArgType, input: string): SetterArg | { error: string } {
  const role = SETTER_ARGS[type].role;
  const abi = PermissionedResolverImplAbi;
  if (type === "text" || type === "data") {
    const key = input;
    const arg = toHex(key);
    const build = (name: Hex) =>
      type === "text"
        ? encodeFunctionData({ abi, functionName: "setText", args: [name, key, ""] })
        : encodeFunctionData({ abi, functionName: "setData", args: [name, key, "0x"] });
    return { type, arg, resource: BigInt(keccak256(arg)), role, setterCalldata: build("0x00"), probeCalldata: build };
  }
  if (type === "coinType" || type === "contentType") {
    const value = parseUint256(input);
    if (value === null) return { error: "Enter a uint256 (decimal or 0x-hex)" };
    const arg = encodeAbiParameters([{ type: "uint256" }], [value]);
    const build = (name: Hex) =>
      type === "coinType"
        ? encodeFunctionData({ abi, functionName: "setAddress", args: [name, value, "0x"] })
        : encodeFunctionData({ abi, functionName: "setABI", args: [name, value, "0x"] });
    return { type, arg, resource: BigInt(keccak256(arg)), role, setterCalldata: build("0x00"), probeCalldata: build };
  }
  const id = input.trim();
  if (!isHex(id) || id.length !== 10) return { error: "Enter a bytes4 interface ID, e.g. 0x3b3b57de" };
  const interfaceId = id.toLowerCase() as Hex;
  const build = (name: Hex) => encodeFunctionData({ abi, functionName: "setInterface", args: [name, interfaceId, zeroAddress] });
  return { type, arg: interfaceId, resource: BigInt(keccak256(interfaceId)), role, setterCalldata: build("0x00"), probeCalldata: build };
}

// --- Presets --------------------------------------------------------------------

export type ResourceMode = "root" | "name" | "anyId" | "setter";

export type EacPreset = {
  key: string;
  label: string;
  address: Address;
  kind: ContractKind;
  mode: ResourceMode;
  name?: string;
  setter?: { type: SetterArgType; value: string };
  /** Account that holds interesting roles here, used when no wallet is connected. */
  account?: Address;
  accountLabel?: string;
  bitmap: bigint;
  deployBlock?: bigint;
  note: string;
};

/** Constructor `rootAccount` of the Sepolia deployment (holds the root admin roles). */
export const DEPLOYER: Address = "0x84D3a426D4E12E955d1DF95db0B24fe26afE39D3";

/**
 * A user-deployed PermissionedResolver proxy on Sepolia whose "description"
 * text key has two argument-scoped ROLE_SET_TEXT holders (checked 2026-09-26).
 */
export const EXAMPLE_RESOLVER: Address = "0x90d4AcC78d32aD0a9fCE6E5B4C45745b8f433FBe";
export const EXAMPLE_RESOLVER_HOLDER: Address = "0xc0d86456F6f2930b892f3DAD007CDBE32c081FE6";

const d = ENSV2_SEPOLIA;

export const EAC_PRESETS: EacPreset[] = [
  {
    key: "ETHRegistry",
    label: "ETHRegistry",
    address: d.ETHRegistry.address,
    kind: "registry",
    mode: "name",
    name: "workflow.eth",
    bitmap: RegistryRoles.ROLE_SET_RESOLVER,
    deployBlock: d.ETHRegistry.deployBlock,
    note: "Holds every .eth second-level name. Resources are per name (labelhash + eacVersionId).",
  },
  {
    key: "RootRegistry",
    label: "RootRegistry",
    address: d.RootRegistry.address,
    kind: "registry",
    mode: "name",
    name: "eth",
    bitmap: RegistryRoles.ROLE_SET_SUBREGISTRY,
    deployBlock: d.RootRegistry.deployBlock,
    note: "Holds TLDs. The eth token's admin roles were revoked after deployment.",
  },
  {
    key: "ExampleResolver",
    label: "PermissionedResolver (example proxy)",
    address: EXAMPLE_RESOLVER,
    kind: "resolver",
    mode: "setter",
    setter: { type: "text", value: "description" },
    account: EXAMPLE_RESOLVER_HOLDER,
    accountLabel: "argument-scoped holder",
    bitmap: ResolverRoles.ROLE_SET_TEXT,
    deployBlock: 11783874n,
    note: "A user's resolver proxy with argument-scoped grants on the \"description\" text key and coin type 60.",
  },
  {
    key: "StandardRentPriceOracle",
    label: "StandardRentPriceOracle",
    address: d.StandardRentPriceOracle.address,
    kind: "oracle",
    mode: "root",
    account: DEPLOYER,
    accountLabel: "root admin",
    bitmap: 1n,
    deployBlock: d.StandardRentPriceOracle.deployBlock,
    note: "Payment-token management, root roles only.",
  },
  ...(["PublicResolverSet", "RegistryUpgradeSet", "HCAUpgradeSet"] as const).map(
    (k): EacPreset => ({
      key: k,
      label: k,
      address: d[k].address,
      kind: "address-set",
      mode: "root",
      account: DEPLOYER,
      accountLabel: "root admin",
      bitmap: 1n,
      deployBlock: d[k].deployBlock,
      note: "PermissionedAddressSet: ROLE_APPROVE adds or removes members. Root roles only.",
    }),
  ),
  ...(["UserRegistryImpl", "WrapperRegistryImpl", "PermissionedResolverImpl"] as const).map(
    (k): EacPreset => ({
      key: k,
      label: k,
      address: d[k].address,
      kind: k === "PermissionedResolverImpl" ? "resolver" : k === "WrapperRegistryImpl" ? "wrapper-registry" : "registry",
      mode: "root",
      account: DEPLOYER,
      accountLabel: "namer",
      bitmap: k === "PermissionedResolverImpl" ? ResolverRoles.ROLE_CAN_NAME : RegistryRoles.ROLE_CAN_NAME,
      deployBlock: d[k].deployBlock,
      note: "Implementation behind the factory proxies. Its constructor grants only ROLE_CAN_NAME (+ admin) to the namer.",
    }),
  ),
];

export const findPresetByAddress = (address: string) =>
  EAC_PRESETS.find((p) => p.address.toLowerCase() === address.toLowerCase());

/** Oldest ENSv2 deployment block: no EAC event on an ENSv2 contract predates it. */
export const ENSV2_FLOOR_BLOCK = Object.values(ENSV2_SEPOLIA).reduce<bigint>(
  (min, x) => (x.deployBlock !== undefined && x.deployBlock < min ? x.deployBlock : min),
  ENSV2_SEPOLIA.RootRegistry.deployBlock,
);

// --- Chain reads ------------------------------------------------------------------

/** Detects the EAC flavour of `address` via ERC-165. */
export async function detectKind(client: PublicClient, address: Address): Promise<ContractKind> {
  const ids = [
    INTERFACE_IDS.eac,
    INTERFACE_IDS.wrapperRegistry,
    INTERFACE_IDS.permissionedRegistry,
    INTERFACE_IDS.permissionedResolver,
    INTERFACE_IDS.rentPriceOracle,
    INTERFACE_IDS.addressSet,
  ] as const;
  const res = await client.multicall({
    contracts: ids.map((id) => ({ address, abi: eacAbi, functionName: "supportsInterface" as const, args: [id] as const })),
    allowFailure: true,
  });
  const yes = res.map((r) => r.status === "success" && r.result === true);
  if (!yes[0]) return "not-eac";
  if (yes[1]) return "wrapper-registry";
  if (yes[2]) return "registry";
  if (yes[3]) return "resolver";
  if (yes[4]) return "oracle";
  if (yes[5]) return "address-set";
  return "eac";
}

export type RegistryNameState = {
  status: number;
  expiry: bigint;
  latestOwner: Address;
  tokenId: bigint;
  resource: bigint;
};

export const STATUS_LABEL = ["AVAILABLE", "RESERVED", "REGISTERED"] as const;

export async function readNameState(client: PublicClient, registry: Address, anyId: bigint): Promise<RegistryNameState> {
  return client.readContract({ address: registry, abi: ETHRegistryAbi, functionName: "getState", args: [anyId] });
}

export type Inspection = {
  /** roles(anyId, account): the `_getRoles` hook for this resource only. */
  roles: bigint;
  /** roles(ROOT_RESOURCE, account). */
  rootRoles: bigint;
  /** What role checks use: root | resource. */
  effective: bigint;
  roleCount: bigint;
  rootRoleCount: bigint;
  hasRoles: boolean | null;
  hasRootRoles: boolean | null;
  assignee: { counts: bigint; mask: bigint } | null;
  hasAssignees: boolean | null;
  isOnlyAssignee: boolean | null;
  errors: string[];
};

/**
 * One multicall for everything the inspector shows. `anyId` is passed as-is:
 * PermissionedRegistry maps it through getResource(), other contracts use it
 * as the resource.
 */
export async function inspectRoles(
  client: PublicClient,
  { address, anyId, account, bitmap }: { address: Address; anyId: bigint; account: Address; bitmap: bigint },
): Promise<Inspection> {
  const c = { address, abi: eacAbi } as const;
  const res = await client.multicall({
    allowFailure: true,
    contracts: [
      { ...c, functionName: "roles", args: [anyId, account] },
      { ...c, functionName: "roles", args: [ROOT_RESOURCE, account] },
      { ...c, functionName: "roleCount", args: [anyId] },
      { ...c, functionName: "roleCount", args: [ROOT_RESOURCE] },
      { ...c, functionName: "hasRoles", args: [anyId, bitmap, account] },
      { ...c, functionName: "hasRootRoles", args: [bitmap, account] },
      { ...c, functionName: "getAssigneeCount", args: [anyId, bitmap] },
      { ...c, functionName: "hasAssignees", args: [anyId, bitmap] },
      { ...c, functionName: "isOnlyAssignee", args: [anyId, bitmap, account] },
    ],
  });
  const errors: string[] = [];
  const pick = <T>(i: number, label: string): T | null => {
    const r = res[i];
    if (r.status === "success") return r.result as T;
    errors.push(`${label}: ${formatError(r.error)}`);
    return null;
  };
  const roles = pick<bigint>(0, "roles") ?? 0n;
  const rootRoles = pick<bigint>(1, "roles(ROOT)") ?? 0n;
  const ac = pick<readonly [bigint, bigint]>(6, "getAssigneeCount");
  return {
    roles,
    rootRoles,
    effective: anyId === ROOT_RESOURCE ? rootRoles : roles | rootRoles,
    roleCount: pick<bigint>(2, "roleCount") ?? 0n,
    rootRoleCount: pick<bigint>(3, "roleCount(ROOT)") ?? 0n,
    hasRoles: pick<boolean>(4, "hasRoles"),
    hasRootRoles: pick<boolean>(5, "hasRootRoles"),
    assignee: ac ? { counts: ac[0], mask: ac[1] } : null,
    hasAssignees: pick<boolean>(7, "hasAssignees"),
    isOnlyAssignee: pick<boolean>(8, "isOnlyAssignee"),
    errors,
  };
}

// --- Grant / revoke pre-check ---------------------------------------------------------

export type RoleOp = "grantRoles" | "revokeRoles" | "grantRootRoles" | "revokeRootRoles" | "grantSetterRoles";

export const isGrantOp = (op: RoleOp) => op.startsWith("grant");
export const isRootOp = (op: RoleOp) => op === "grantRootRoles" || op === "revokeRootRoles";

/**
 * Roles `account` may grant on `resource` (`_getSettableRoles`), given its
 * effective roles (root | resource, as returned by the `_getRoles` hook).
 */
export function settableRoles(kind: ContractKind, resource: bigint, effective: bigint, nameHasOwner: boolean): bigint {
  let bitmap = withAdminRolesApplied(effective);
  if (isRegistryKind(kind)) {
    // PermissionedRegistry: nothing on unowned names; only regular roles on names.
    if (resource !== ROOT_RESOURCE && !nameHasOwner) return 0n;
    if (resource !== ROOT_RESOURCE) bitmap >>= 128n;
    // WrapperRegistry: root admin roles cannot be granted.
    if (kind === "wrapper-registry" && resource === ROOT_RESOURCE) bitmap >>= 128n;
  }
  return bitmap;
}

/** Roles `account` may revoke (`_getRevokableRoles`, not overridden by any deployed contract). */
export const revokableRoles = (effective: bigint): bigint => withAdminRolesApplied(effective);

export type Check = { ok: boolean; label: string; detail?: string };

export type Outcome =
  | { type: "revert"; error: string; args?: readonly unknown[]; why: string }
  | { type: "noop"; why: string }
  | { type: "change"; oldRoles: bigint; newRoles: bigint; regenerates: boolean; resourceArgument: boolean };

export type PrecheckInput = {
  kind: ContractKind;
  op: RoleOp;
  /** Resolved EAC resource (0 for root ops). */
  resource: bigint;
  bitmap: bigint;
  caller: Address;
  grantee: Address;
  /** Caller's roles(resource) and roles(ROOT). */
  callerRoles: bigint;
  callerRootRoles: bigint;
  /** Grantee's current roles on the resource (roles() hook value). */
  granteeRoles: bigint;
  /** roleCount(resource). */
  roleCount: bigint;
  /** Registry only: the name at `resource` is REGISTERED (getOwner != 0). */
  nameHasOwner: boolean;
};

/**
 * Replays the contract's checks for a grant/revoke in order and predicts the
 * outcome, so the UI can explain a failure before the user signs.
 */
export function precheckRoleChange(p: PrecheckInput): { checks: Check[]; outcome: Outcome } {
  const checks: Check[] = [];
  const grant = isGrantOp(p.op);
  const resource = isRootOp(p.op) ? ROOT_RESOURCE : p.resource;
  const effective = resource === ROOT_RESOURCE ? p.callerRootRoles : p.callerRoles | p.callerRootRoles;
  const revert = (error: string, args: readonly unknown[] | undefined, why: string) => ({ checks, outcome: { type: "revert", error, args, why } as Outcome });

  if (p.op === "grantRoles" && p.kind === "resolver") {
    checks.push({ ok: false, label: "grantRoles is disabled on PermissionedResolver", detail: "Use grantSetterRoles (argument scope) or grantRootRoles." });
    return revert("EACCannotGrantRoles", [resource, p.bitmap, p.grantee], "PermissionedResolver.grantRoles() always reverts.");
  }

  const allowed = grant ? settableRoles(p.kind, resource, effective, p.nameHasOwner) : revokableRoles(effective);
  const missing = p.bitmap & ~allowed & MAX_UINT256;
  const registryName = isRegistryKind(p.kind) && resource !== ROOT_RESOURCE;
  let detail = `Caller may ${grant ? "grant" : "revoke"} ${toHex256(allowed)}.`;
  if (grant && registryName && !p.nameHasOwner) detail = "The name is not REGISTERED, so the registry returns no settable roles.";
  else if (grant && registryName) detail += " On registry names only regular roles are settable (admin roles are assigned at registration).";
  else if (grant && p.kind === "wrapper-registry" && resource === ROOT_RESOURCE) detail += " WrapperRegistry never lets root admin roles be granted.";
  if (invalidBits(p.bitmap)) detail += " The bitmap has bits outside ALL_ROLES; they are never settable, so this reverts here rather than with EACInvalidRoleBitmap.";
  checks.push({
    ok: missing === 0n,
    label: `Caller holds the admin role for every role in the bitmap (${grant ? "_getSettableRoles" : "_getRevokableRoles"})`,
    detail,
  });
  if (missing !== 0n) {
    return revert(
      grant ? "EACCannotGrantRoles" : "EACCannotRevokeRoles",
      [resource, p.bitmap, p.caller],
      `Missing authority for ${toHex256(missing)}.`,
    );
  }

  if ((p.op === "grantRoles" || p.op === "revokeRoles") && resource === ROOT_RESOURCE) {
    checks.push({ ok: false, label: "Resource is not ROOT_RESOURCE", detail: `Use ${grant ? "grantRootRoles" : "revokeRootRoles"} for contract-wide roles.` });
    return revert("EACRootResourceNotAllowed", [], "grantRoles/revokeRoles reject ROOT_RESOURCE as a guardrail.");
  }

  if (grant && p.bitmap === 0n) {
    checks.push({ ok: true, label: "Bitmap is non-zero", detail: "An empty grant returns false without checks." });
    return { checks, outcome: { type: "noop", why: "Empty bitmap: returns false." } };
  }
  if (grant && p.grantee === zeroAddress) {
    checks.push({ ok: false, label: "Account is not the zero address" });
    return revert("EACInvalidAccount", [], "Roles cannot be granted to address(0).");
  }

  const current = p.granteeRoles;
  const next = grant ? current | p.bitmap : current & ~p.bitmap;
  if (next === current) {
    checks.push({ ok: true, label: "Roles would change", detail: grant ? "Account already holds every role." : "Account holds none of these roles." });
    return { checks, outcome: { type: "noop", why: "Roles already in the desired state: returns false, no event." } };
  }

  const delta = grant ? p.bitmap & ~current : p.bitmap & current;
  const mask = roleBitmapToMask(delta);
  const counts = p.roleCount & mask;
  const full = describeNybbles(delta, []).filter((e) => nybbleAt(counts, e.nybble) === (grant ? 15 : 0));
  checks.push({
    ok: full.length === 0,
    label: grant ? "Fewer than 15 assignees for each newly added role" : "Assignee counts can be decremented",
    detail: full.length ? `Nybbles ${full.map((e) => e.nybble).join(", ")} are ${grant ? "full" : "empty"}.` : undefined,
  });
  if (full.length) return revert(grant ? "EACMaxAssignees" : "EACMinAssignees", [resource, delta], "Assignee count nybble would overflow.");

  return {
    checks,
    outcome: {
      type: "change",
      oldRoles: current,
      newRoles: next,
      regenerates: isRegistryKind(p.kind) && resource !== ROOT_RESOURCE && p.op !== "grantSetterRoles",
      resourceArgument: p.op === "grantSetterRoles" && p.roleCount === 0n,
    },
  };
}

export type GrantContext = {
  resource: bigint;
  nameHasOwner: boolean;
  callerRoles: bigint;
  callerRootRoles: bigint;
  granteeRoles: bigint;
  roleCount: bigint;
};

/** Reads everything precheckRoleChange needs for `op` (one getState + one multicall). */
export async function readGrantContext(
  client: PublicClient,
  { address, kind, op, anyId, caller, grantee }: { address: Address; kind: ContractKind; op: RoleOp; anyId: bigint; caller: Address; grantee: Address },
): Promise<GrantContext> {
  const root = isRootOp(op) || anyId === ROOT_RESOURCE;
  const id = root ? ROOT_RESOURCE : anyId;
  let resource = id;
  let nameHasOwner = false;
  if (isRegistryKind(kind) && !root) {
    const s = await readNameState(client, address, id);
    resource = s.resource;
    nameHasOwner = s.status === 2;
  }
  const c = { address, abi: eacAbi } as const;
  const [callerRoles, callerRootRoles, granteeRoles, roleCount] = await client.multicall({
    allowFailure: false,
    contracts: [
      { ...c, functionName: "roles", args: [id, caller] },
      { ...c, functionName: "roles", args: [ROOT_RESOURCE, caller] },
      { ...c, functionName: "roles", args: [id, grantee] },
      { ...c, functionName: "roleCount", args: [id] },
    ],
  });
  return { resource, nameHasOwner, callerRoles, callerRootRoles, granteeRoles, roleCount };
}

// --- Event history ----------------------------------------------------------------------

export type RoleChangeEvent = {
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
  resource: bigint;
  account: Address;
  oldRoleBitmap: bigint;
  newRoleBitmap: bigint;
};

/**
 * Scans EACRolesChanged newest-first in <= 50k block chunks (public RPC limit)
 * until `maxEvents` are found or `floor` is reached.
 */
export async function scanRoleEvents(
  client: PublicClient,
  {
    address,
    resource,
    account,
    toBlock,
    floor,
    maxEvents = 25,
    chunk = 50_000n,
  }: { address: Address; resource: bigint; account?: Address; toBlock: bigint; floor: bigint; maxEvents?: number; chunk?: bigint },
): Promise<{ events: RoleChangeEvent[]; nextTo: bigint; done: boolean }> {
  const events: RoleChangeEvent[] = [];
  let to = toBlock;
  while (to >= floor && events.length < maxEvents) {
    const from = to - chunk + 1n > floor ? to - chunk + 1n : floor;
    const logs = await client.getLogs({
      address,
      event: EAC_ROLES_CHANGED,
      args: account ? { resource, account } : { resource },
      fromBlock: from,
      toBlock: to,
    });
    for (const l of [...logs].reverse()) {
      events.push({
        blockNumber: l.blockNumber,
        transactionHash: l.transactionHash,
        logIndex: l.logIndex,
        resource: l.args.resource!,
        account: l.args.account!,
        oldRoleBitmap: l.args.oldRoleBitmap!,
        newRoleBitmap: l.args.newRoleBitmap!,
      });
    }
    to = from - 1n;
  }
  return { events, nextTo: to, done: to < floor };
}

// --- Errors ---------------------------------------------------------------------------------

/** IEnhancedAccessControl errors, selectors from the interface NatSpec. */
export const EAC_ERRORS: { name: string; selector: Hex; when: string }[] = [
  {
    name: "EACCannotGrantRoles(resource, roleBitmap, account)",
    selector: "0xd1a3b355",
    when: "Caller lacks the admin role for a role being granted (incl. invalid bits); PermissionedResolver.grantRoles always; registry names: unowned name or admin roles.",
  },
  {
    name: "EACCannotRevokeRoles(resource, roleBitmap, account)",
    selector: "0xa604e318",
    when: "Caller lacks the admin role for a role being revoked.",
  },
  {
    name: "EACUnauthorizedAccountRoles(resource, roleBitmap, account)",
    selector: "0x4b27a133",
    when: "A function gated by onlyRoles/onlyRootRoles was called by an account without the role on the resource or ROOT_RESOURCE.",
  },
  { name: "EACRootResourceNotAllowed()", selector: "0xc2842458", when: "grantRoles/revokeRoles called with ROOT_RESOURCE (checked after the admin check)." },
  { name: "EACInvalidRoleBitmap(roleBitmap)", selector: "0x2a7b2d20", when: "Bits outside bit 0 of each nybble, e.g. in getAssigneeCount/hasAssignees/isOnlyAssignee." },
  { name: "EACMaxAssignees(resource, role)", selector: "0xf9165348", when: "A 16th account would receive a role on the same resource." },
  { name: "EACMinAssignees(resource, role)", selector: "0x1f80c19b", when: "Assignee count underflow (defensive; unreachable through the public API)." },
  { name: "EACInvalidAccount()", selector: "0xec3fc592", when: "Granting to address(0)." },
];
