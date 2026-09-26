/**
 * Every write the market makes to ENSv2 on Sepolia, from the server wallet.
 * Server only. Each function checks the chain first, so a repeat is safe.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { PermissionedResolverImplAbi } from "@/app/ens/_lib/ens/abis/PermissionedResolverImpl";
import {
  USER_REGISTRY_IMPL,
  VERIFIABLE_FACTORY,
  allRolesTo,
  encodeRegistryInit,
  predictProxyAddress,
  registrySalt,
  verifiableFactoryAbi,
} from "@/app/ens/_lib/ens/factory";
import { dnsEncode, labelId, namehash, splitFirst } from "@/app/ens/_lib/ens/names";
import { keyResource } from "@/app/ens/_lib/ens/permissioned-resolver";
import { ResolverRoles } from "@/app/ens/_lib/ens/roles";
import { SEPOLIA_RPC_URL, resolveRecords } from "@/lib/ens/resolve";

export type Deployment = {
  owner: Address;
  resolver: Address;
  registry: Address;
  tree: { name: string; label: string; registry: Address };
};

/** The largest uint64: no expiry of its own. */
export const NEVER = (1n << 64n) - 1n;

const registryAbi = parseAbi([
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function unregister(uint256 anyId)",
  "function setSubregistry(uint256 anyId, address registry)",
  "function getSubregistry(string label) view returns (address)",
  "function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))",
]);

export function loadDeployment(): Deployment {
  const file = path.join(process.cwd(), "lib", "ens", "deployment.json");
  if (!existsSync(file)) throw new Error("No lib/ens/deployment.json. Run npm run ens:setup first.");
  return JSON.parse(readFileSync(file, "utf8")) as Deployment;
}

function account() {
  const key = process.env.PETRI_ENS_PRIVATE_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("PETRI_ENS_PRIVATE_KEY is not set. The server cannot write to ENS.");
  return privateKeyToAccount(key as Hex);
}

const publicClient = () => createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) });

/** Sends one write and waits for it. Throws on a revert. */
async function send(tx: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<Hex> {
  const acct = account();
  const client = publicClient();
  const wallet = createWalletClient({ account: acct, chain: sepolia, transport: http(SEPOLIA_RPC_URL) });
  const { request } = await client.simulateContract({ ...tx, account: acct } as never);
  const hash = await wallet.writeContract(request as never);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return hash;
}

/** About 750 gas per stored byte, so one transaction carries at most this many bytes of values. */
const BYTES_PER_TX = 8_000;

/**
 * Writes the records that differ from what the name holds now, a few
 * kilobytes per transaction. Returns the tx hashes; none when nothing changed.
 */
export async function writeTexts(name: string, records: Record<string, string>): Promise<Hex[]> {
  const dep = loadDeployment();
  const keys = Object.keys(records);
  const [have] = await resolveRecords([name], { keys, rpcUrl: SEPOLIA_RPC_URL });
  const changed = have.error ? keys : keys.filter((k) => (have.texts[k] ?? "") !== records[k]);
  const batches: string[][] = [];
  let size = 0;
  for (const k of changed) {
    const n = records[k].length + k.length;
    if (batches.length === 0 || size + n > BYTES_PER_TX) { batches.push([]); size = 0; }
    batches[batches.length - 1].push(k);
    size += n;
  }
  const txs: Hex[] = [];
  for (const batch of batches) {
    const calls = batch.map((k) =>
      encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "setText", args: [dnsEncode(name), k, records[k]] }),
    );
    txs.push(await send({ address: dep.resolver, abi: PermissionedResolverImplAbi, functionName: "multicall", args: [calls] }));
  }
  return txs;
}

/** The registry that holds the subnames of `parent`, deployed and linked when missing. */
export async function subregistryOf(parent: string): Promise<Address> {
  const dep = loadDeployment();
  const client = publicClient();
  const [label, grand] = splitFirst(parent);
  const holder = grand === dep.tree.name ? dep.tree.registry : grand === "petri.eth" ? dep.registry : await subregistryOf(grand);
  const current = await client.readContract({ address: holder, abi: registryAbi, functionName: "getSubregistry", args: [label] });
  if (current !== zeroAddress) return current;

  const proxyLogic = await client.readContract({ address: VERIFIABLE_FACTORY, abi: verifiableFactoryAbi, functionName: "proxyLogic" });
  const salt = registrySalt(namehash(parent));
  const predicted = predictProxyAddress({ proxyLogic, deployer: dep.owner, salt });
  if (((await client.getCode({ address: predicted })) ?? "0x") === "0x") {
    await send({
      address: VERIFIABLE_FACTORY, abi: verifiableFactoryAbi, functionName: "deployProxy",
      args: [USER_REGISTRY_IMPL, salt, encodeRegistryInit(allRolesTo(dep.owner))],
    });
  }
  await send({ address: holder, abi: registryAbi, functionName: "setSubregistry", args: [labelId(label), predicted] });
  return predicted;
}

/** The registry that holds `name` itself, and the state of the name in it. */
async function stateOf(name: string) {
  const [label, parent] = splitFirst(name);
  const registry = await subregistryOf(parent);
  const state = await publicClient().readContract({ address: registry, abi: registryAbi, functionName: "getState", args: [labelId(label)] });
  return { label, registry, state };
}

/**
 * Registers `name` as a subname owned by the server wallet, with no roles, so
 * nobody can transfer it, and the platform resolver. Returns the tx, or null
 * when it exists.
 */
export async function registerSubname(name: string, expiry: bigint = NEVER): Promise<Hex | null> {
  const dep = loadDeployment();
  const { label, registry, state } = await stateOf(name);
  if (state.status === 2) return null;
  return send({ address: registry, abi: registryAbi, functionName: "register", args: [label, dep.owner, zeroAddress, dep.resolver, 0n, expiry] });
}

/**
 * Removes a subname, and unlinks its records so they stop resolving through
 * the parent's resolver. Returns the txs.
 */
export async function revokeSubname(name: string): Promise<Hex[]> {
  const dep = loadDeployment();
  const { label, registry, state } = await stateOf(name);
  const txs: Hex[] = [];
  if (state.status === 2) txs.push(await send({ address: registry, abi: registryAbi, functionName: "unregister", args: [labelId(label)] }));
  txs.push(await send({ address: dep.resolver, abi: PermissionedResolverImplAbi, functionName: "linkToRecord", args: [dnsEncode(name), 0n] }));
  return txs;
}

/** The setText call that scopes a role to one text key, for grantSetterRoles. */
const voteSetter = (key: string): Hex =>
  encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "setText", args: [dnsEncode("petri.eth"), key, ""] });

/** Lets `wallet` write the text key `key` on the platform resolver. */
export const grantTextKey = (wallet: Address, key: string): Promise<Hex> =>
  send({ address: loadDeployment().resolver, abi: PermissionedResolverImplAbi, functionName: "grantSetterRoles", args: [voteSetter(key), wallet] });

/** Takes that right back: the text role on that key's resource. */
export const revokeTextKey = (wallet: Address, key: string): Promise<Hex> =>
  send({ address: loadDeployment().resolver, abi: PermissionedResolverImplAbi, functionName: "revokeRoles", args: [keyResource(key), ResolverRoles.ROLE_SET_TEXT, wallet] });

/** Reads records of one name. Unset keys are "". */
export async function readTexts(name: string, keys: string[]): Promise<Record<string, string>> {
  const [have] = await resolveRecords([name], { keys, rpcUrl: SEPOLIA_RPC_URL });
  if (have.error) throw new Error(`Could not read ${name}: ${have.error}`);
  return Object.fromEntries(keys.map((k) => [k, have.texts[k] ?? ""]));
}
