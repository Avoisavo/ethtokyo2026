// Verifiable Factory page helpers (see /ensv2/verifiable-factory), on top of
// app/ens/_lib/ens/factory.ts: the proxy's own interface (UUPSProxyLogic), byte-level
// parsing of the 77-byte clone runtime, off-chain re-verification, salt
// scheme detection and chunked log scans.
//
// Mirrors ensdomains/verifiable-factory as vendored by contracts-v2@71a3b73:
// CloneProxyBytecode.sol, UUPSProxyLogic.sol, VerifiableFactory.sol.

import {
  type Address,
  type Hex,
  type PublicClient,
  concat,
  encodeAbiParameters,
  getAddress,
  getCreate2Address,
  hexToNumber,
  isAddressEqual,
  keccak256,
  parseAbi,
  size,
  slice,
} from "viem";

import { ENSV2_SEPOLIA } from "./deployments";
import { VERIFIABLE_FACTORY, registrySalt, resolverSalt } from "./factory";
import { namehash } from "./names";

/** `keccak256("eip1967.proxy.implementation") - 1`, where UUPSProxyLogic stores the implementation. */
export const EIP1967_IMPLEMENTATION_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** 10-byte creation stub: copies the next 0x4d (77) bytes to memory and returns them as runtime code. */
export const CREATION_STUB: Hex = "0x3d604d80600a3d3981f3";
/** EIP-1167 runtime before the 20-byte target (ends with PUSH20). */
export const EIP1167_PREFIX: Hex = "0x363d3d373d3d3d363d73";
/** EIP-1167 runtime after the target: DELEGATECALL, copy returndata, return or revert. */
export const EIP1167_SUFFIX: Hex = "0x5af43d82803e903d91602b57fd5bf3";

export const EIP1167_SIZE = 45;
export const PROXY_RUNTIME_SIZE = 77;
export const PROXY_CREATION_SIZE = 87;

export const FACTORY_DEPLOY_BLOCK = ENSV2_SEPOLIA.VerifiableFactory.deployBlock;

/** Live Sepolia examples (checked 2026-09-26 against ProxyDeployed events). */
export const EXAMPLES = {
  /** EOA that deployed a PermissionedResolver with the OwnedResolver salt, version 0, plus two UserRegistries. */
  resolverOwner: "0x3999FF89d09AF0fb45DF243D7a4a3c9299e5c69B" as Address,
  resolverProxy: "0x90A4f86f4C54Ca91EC8930C7c2352D195280Bc16" as Address,
  /** UserRegistry for soapay.eth deployed with the UserRegistry salt, version 0. */
  registryName: "soapay.eth",
  registryDeployer: "0xC33FcD38117b76CC05dab2F3DD2d9B71111358dB" as Address,
  registryProxy: "0x7403C470a91B21AB77B4E246a39c1Adfcc317969" as Address,
  /** StandaloneSingleOwnerHCA proxy deployed by StandaloneHCAFactory. */
  hcaProxy: "0x3038380c1D8c70eF4489CDCf7e8A84174B6528bD" as Address,
};

/** IUUPSProxy errors. They are not in app/ens/_lib/ens/abis/errors.ts, so calls pass them explicitly. */
export const proxyErrorsAbi = parseAbi([
  "error ImplementationCannotBeZeroAddress()",
  "error AlreadyInitialized()",
  "error ImplementationNotSet()",
  "error InvalidUpgradeTarget(address currentImplementation, address newImplementation)",
  "error UpgradeNotAllowedInContext()",
  "error UnexpectedUpgrade()",
  "error ERC1967InvalidImplementation(address implementation)",
  "error ERC1967NonPayable()",
]);

/**
 * Functions every factory proxy answers itself (UUPSProxyLogic / IUUPSProxy),
 * plus the UUPS upgrade entry point and the errors they can raise.
 */
export const uupsProxyAbi = parseAbi([
  "function initialize(address implementation, bytes data) payable",
  "function getVerifiableProxyData() view returns (bytes32 salt, address implementation)",
  "function verifiableProxyFactory() view returns (address)",
  "function upgradeToAndCall(address newImplementation, bytes data) payable",
  "event Upgraded(address indexed implementation)",
  "error ImplementationCannotBeZeroAddress()",
  "error AlreadyInitialized()",
  "error ImplementationNotSet()",
  "error InvalidUpgradeTarget(address currentImplementation, address newImplementation)",
  "error UpgradeNotAllowedInContext()",
  "error UnexpectedUpgrade()",
  "error ERC1967InvalidImplementation(address implementation)",
  "error ERC1967NonPayable()",
  "error UUPSUnauthorizedCallContext()",
  "error UUPSUnsupportedProxiableUUID(bytes32 slot)",
  "error UpgradeTargetNotApproved(address implementation)",
  "error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error OwnableUnauthorizedAccount(address account)",
]);

/** Checks run against a candidate implementation before an upgrade. */
export const upgradeTargetAbi = parseAbi([
  "function canUpgradeFrom(address previousImplementation) view returns (bool)",
  "function proxiableUUID() view returns (bytes32)",
  "function UPGRADE_INTERFACE_VERSION() view returns (string)",
]);

/** EAC reads shared by PermissionedResolver, UserRegistry and WrapperRegistry. */
export const eacAbi = parseAbi([
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function roles(uint256 resource, address account) view returns (uint256)",
  "function getAssigneeCount(uint256 resource, uint256 roleBitmap) view returns (uint256 counts, uint256 mask)",
]);

/** Upgrade gates that live on WrapperRegistry and StandaloneSingleOwnerHCA. */
export const upgradeSetAbi = parseAbi([
  "function UPGRADE_SET() view returns (address)",
  "function includes(address) view returns (bool)",
  "function owner() view returns (address)",
  "function getWrappedNode() view returns (bytes32)",
  "function getParent() view returns (address parent, string label)",
]);

// --- Implementations --------------------------------------------------------

export type ImplFamily = "resolver" | "user-registry" | "wrapper-registry" | "hca";

export type KnownImplementation = {
  key: keyof typeof ENSV2_SEPOLIA;
  label: string;
  address: Address;
  family: ImplFamily;
  saltScheme: string;
  deployer: string;
  initializer: string;
  upgradeAuth: string;
  inDocTable: boolean;
};

export const KNOWN_IMPLEMENTATIONS: KnownImplementation[] = [
  {
    key: "PermissionedResolverImpl",
    label: "PermissionedResolver",
    address: ENSV2_SEPOLIA.PermissionedResolverImpl.address,
    family: "resolver",
    saltScheme: 'keccak256(abi.encode(keccak256("OwnedResolver"), owner, version))',
    deployer: "Any account, on demand (one resolver per owner + version)",
    initializer: "initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)",
    upgradeAuth: "ROLE_UPGRADE on ROOT_RESOURCE",
    inDocTable: true,
  },
  {
    key: "UserRegistryImpl",
    label: "UserRegistry",
    address: ENSV2_SEPOLIA.UserRegistryImpl.address,
    family: "user-registry",
    saltScheme: 'keccak256(abi.encode(keccak256("UserRegistry"), namehash, version))',
    deployer: "Name owners, on demand (one subname registry per name + version)",
    initializer: "initialize((address account, uint256 roleBitmap)[] grants)",
    upgradeAuth: "ROLE_UPGRADE on ROOT_RESOURCE",
    inDocTable: true,
  },
  {
    key: "WrapperRegistryImpl",
    label: "WrapperRegistry",
    address: ENSV2_SEPOLIA.WrapperRegistryImpl.address,
    family: "wrapper-registry",
    saltScheme: "uint256(namehash) of the wrapped v1 name",
    deployer: "LockedMigrationController (2LDs) or the parent WrapperRegistry, when a locked v1 name migrates",
    initializer: "initialize(bytes32 node, address parentRegistry, string childLabel, uint256 roleBitmap)",
    upgradeAuth: "ROLE_UPGRADE on ROOT_RESOURCE + target in UPGRADE_SET",
    inDocTable: true,
  },
  {
    key: "StandaloneHCAImplementation",
    label: "StandaloneSingleOwnerHCA",
    address: ENSV2_SEPOLIA.StandaloneHCAImplementation.address,
    family: "hca",
    saltScheme: "keccak256(abi.encode(userSalt, owner, implementation))",
    deployer: "StandaloneHCAFactory.deploy(owner, implementation, userSalt)",
    initializer: "initializeAccount(bytes initData)",
    upgradeAuth: "owner() + target in UPGRADE_SET",
    inDocTable: false,
  },
];

export function identifyImplementation(address?: string | null): KnownImplementation | undefined {
  if (!address) return undefined;
  return KNOWN_IMPLEMENTATIONS.find((i) => i.address.toLowerCase() === address.toLowerCase());
}

/** Deployment name for any ENSv2 Sepolia address (e.g. "LockedMigrationController"). */
export function deploymentName(address?: string | null): string | undefined {
  if (!address) return undefined;
  const hit = Object.entries(ENSV2_SEPOLIA).find(([, d]) => d.address.toLowerCase() === address.toLowerCase());
  return hit?.[0];
}

// --- Bytecode ---------------------------------------------------------------

export type ProxyRuntime = {
  prefix: Hex;
  logic: Address;
  suffix: Hex;
  outerSalt: Hex;
  prefixOk: boolean;
  suffixOk: boolean;
};

/** Splits 77-byte factory proxy runtime into its parts; null for any other length. */
export function parseProxyRuntime(code: Hex | undefined): ProxyRuntime | null {
  if (!code || size(code) !== PROXY_RUNTIME_SIZE) return null;
  const prefix = slice(code, 0, 10);
  const suffix = slice(code, 30, EIP1167_SIZE);
  return {
    prefix,
    logic: getAddress(slice(code, 10, 30)),
    suffix,
    outerSalt: slice(code, EIP1167_SIZE, PROXY_RUNTIME_SIZE),
    prefixOk: prefix.toLowerCase() === EIP1167_PREFIX,
    suffixOk: suffix.toLowerCase() === EIP1167_SUFFIX,
  };
}

/** CloneProxyBytecode.creationCode(logic, outerSalt): 87 bytes of init code. */
export const proxyCreationCode = (logic: Address, outerSalt: Hex): Hex =>
  concat([CREATION_STUB, EIP1167_PREFIX, logic, EIP1167_SUFFIX, outerSalt]);

/** The CREATE2 salt the factory derives: keccak256(abi.encode(msg.sender, salt)). */
export const outerSaltOf = (deployer: Address, salt: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [deployer, salt]));

/** Off-chain replay of VerifiableFactory._verifyContract: the address implied by an outerSalt. */
export const addressFromOuterSalt = ({
  logic,
  outerSalt,
  factory = VERIFIABLE_FACTORY,
}: {
  logic: Address;
  outerSalt: Hex;
  factory?: Address;
}): Address => getCreate2Address({ from: factory, salt: outerSalt, bytecodeHash: keccak256(proxyCreationCode(logic, outerSalt)) });

export const sameAddress = (a?: string | null, b?: string | null) =>
  !!a && !!b && /^0x[0-9a-fA-F]{40}$/.test(a) && /^0x[0-9a-fA-F]{40}$/.test(b) && isAddressEqual(a as Address, b as Address);

/** The address stored in a raw 32-byte storage word. */
export const slotToAddress = (word?: Hex | null): Address | null =>
  word && size(word) === 32 ? getAddress(slice(word, 12, 32)) : null;

// --- Disassembly ------------------------------------------------------------

const OPCODES: Record<number, [name: string, note?: string]> = {
  0x36: ["CALLDATASIZE"],
  0x3d: ["RETURNDATASIZE"],
  0x37: ["CALLDATACOPY", "copy calldata to memory 0"],
  0x39: ["CODECOPY", "copy runtime from code into memory"],
  0x3e: ["RETURNDATACOPY", "copy the delegatecall result to memory"],
  0x5a: ["GAS"],
  0xf4: ["DELEGATECALL", "run proxyLogic in the proxy's storage context"],
  0x80: ["DUP1"],
  0x81: ["DUP2"],
  0x82: ["DUP3"],
  0x90: ["SWAP1"],
  0x91: ["SWAP2"],
  0x57: ["JUMPI", "jump to RETURN on success"],
  0x5b: ["JUMPDEST"],
  0xfd: ["REVERT", "bubble up the revert data"],
  0xf3: ["RETURN"],
};

export type Instruction = { pc: number; hex: Hex; op: string; arg?: Hex; note?: string };

/** Minimal disassembler for the clone code (handles PUSH1..PUSH32; other opcodes named when known). */
export function disassemble(code: Hex): Instruction[] {
  const bytes = code.slice(2);
  const out: Instruction[] = [];
  let pc = 0;
  let called = false;
  const n = bytes.length / 2;
  while (pc < n) {
    const byte = hexToNumber(`0x${bytes.slice(pc * 2, pc * 2 + 2)}`);
    if (byte >= 0x60 && byte <= 0x7f) {
      const len = byte - 0x5f;
      const arg = `0x${bytes.slice(pc * 2 + 2, pc * 2 + 2 + len * 2)}` as Hex;
      const note = byte === 0x73 ? "the shared UUPSProxyLogic" : undefined;
      out.push({ pc, hex: `0x${bytes.slice(pc * 2, pc * 2 + 2 + len * 2)}` as Hex, op: `PUSH${len}`, arg, note });
      pc += 1 + len;
    } else {
      const [name, fixedNote] = OPCODES[byte] ?? [`0x${byte.toString(16).padStart(2, "0")}`];
      // RETURNDATASIZE is the 2-gas way to push 0 until a call has returned.
      const note = byte === 0x3d ? (called ? "size of the returned data" : "pushes 0 (no call yet)") : fixedNote;
      if (byte === 0xf4) called = true;
      out.push({ pc, hex: `0x${bytes.slice(pc * 2, pc * 2 + 2)}` as Hex, op: name, note });
      pc += 1;
    }
  }
  return out;
}

// --- Salt schemes -----------------------------------------------------------

export const MAX_SCHEME_VERSION = 64n;

export type SaltMatch = { scheme: string; detail: string };

/**
 * Tries to explain a user salt from a ProxyDeployed event with the known
 * conventions. The factory does not enforce any of them: any uint256 works.
 */
export function matchSaltScheme({
  family,
  sender,
  salt,
  name,
  wrappedNode,
}: {
  family?: ImplFamily;
  sender: Address;
  salt: bigint;
  name?: string | null;
  wrappedNode?: Hex | null;
}): SaltMatch | null {
  if (family === "resolver" || family === undefined) {
    for (let v = 0n; v < MAX_SCHEME_VERSION; v++) {
      if (resolverSalt(sender, v) === salt) return { scheme: "OwnedResolver", detail: `owner = sender, version ${v}` };
    }
  }
  if ((family === "user-registry" || family === undefined) && name) {
    const node = namehash(name);
    for (let v = 0n; v < MAX_SCHEME_VERSION; v++) {
      if (registrySalt(node, v) === salt) return { scheme: "UserRegistry", detail: `namehash(${name}), version ${v}` };
    }
  }
  if (family === "wrapper-registry" && wrappedNode && BigInt(wrappedNode) === salt) {
    return { scheme: "WrapperRegistry", detail: "uint256(getWrappedNode())" };
  }
  return null;
}

// --- Logs -------------------------------------------------------------------

/** Public Sepolia RPCs cap eth_getLogs ranges at 50,000 blocks. */
export const LOG_CHUNK = 50_000n;

export type ScanProgress = { from: bigint; to: bigint; done: number; total: number };

/**
 * Runs `fetch` over [fromBlock, latest] in LOG_CHUNK windows, oldest first.
 * Stops early when `stop` returns true for the accumulated results.
 */
export async function scanChunks<T>(
  client: PublicClient,
  {
    fromBlock = FACTORY_DEPLOY_BLOCK,
    fetch,
    onProgress,
    stop,
  }: {
    fromBlock?: bigint;
    fetch: (from: bigint, to: bigint) => Promise<T[]>;
    onProgress?: (p: ScanProgress) => void;
    stop?: (acc: T[]) => boolean;
  },
): Promise<T[]> {
  const latest = await client.getBlockNumber();
  const total = Number((latest - fromBlock) / LOG_CHUNK) + 1;
  const acc: T[] = [];
  let done = 0;
  for (let from = fromBlock; from <= latest; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > latest ? latest : from + LOG_CHUNK - 1n;
    acc.push(...(await fetch(from, to)));
    done++;
    onProgress?.({ from, to, done, total });
    if (stop?.(acc)) break;
  }
  return acc;
}

export const shortHex = (h: string, head = 10, tail = 8) => (h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`);

export const toHex32 = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}`;
