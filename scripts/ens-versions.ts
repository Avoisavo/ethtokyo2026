/**
 * Registers every tree version as a real subname under the tree name, and
 * writes the tree name's own records.
 *
 *   npm run ens:versions
 *
 * Each version becomes `v<n>.<tree>.petri.eth` in the tree's UserRegistry:
 * owned by the server wallet, with no roles (nobody can transfer it), and no
 * expiry of its own. The tree name gets `petri.tree` (the title), `petri.count`
 * and one `petri.v<n>` record per version, holding that version's id, so
 * anyone can see which version `v3` is.
 *
 * A re-run only registers the versions that are new. Records are written only
 * when they differ. Needs PETRI_ENS_PRIVATE_KEY in .env.local.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { type Address, type Hex, createWalletClient, encodeFunctionData, http, parseAbi, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { PermissionedResolverImplAbi } from "@/app/ens/_lib/ens/abis/PermissionedResolverImpl";
import { explorerTx } from "@/app/ens/_lib/ens/contracts";
import { formatError } from "@/app/ens/_lib/ens/errors";
import { dnsEncode, labelId } from "@/app/ens/_lib/ens/names";
import { TREE_NAME, ensNames, versionLabel } from "@/lib/ens/name";

class Fail extends Error {}

const NEVER = (1n << 64n) - 1n;
const TREE_TITLE = "Petri harness v1 × Claude Sonnet 5 (Coding)";

const registryAbi = parseAbi([
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))",
]);

type Deployment = { owner: Address; resolver: Address; registry: Address; tree: { name: string; registry: Address } };

async function main() {
  const envFile = path.join(process.cwd(), ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const { TREES, loadTreeEntry } = await import("@/lib/trees");
  const { resolveRecords, sepoliaClient, SEPOLIA_RPC_URL: rpcUrl } = await import("@/lib/ens/resolve");

  const file = path.join(process.cwd(), "lib", "ens", "deployment.json");
  if (!existsSync(file)) throw new Fail("No lib/ens/deployment.json. Run npm run ens:setup first.");
  const dep = JSON.parse(readFileSync(file, "utf8")) as Deployment;
  if (dep.tree.name !== TREE_NAME) throw new Fail(`deployment.json is for ${dep.tree.name}, but the code names ${TREE_NAME}.`);

  const key = process.env.PETRI_ENS_PRIVATE_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Fail("Set PETRI_ENS_PRIVATE_KEY (0x + 64 hex) in .env.local.");
  const account = privateKeyToAccount(key as Hex);
  const client = sepoliaClient(rpcUrl);
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });

  const send = async (label: string, tx: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => {
    try {
      const { request } = await client.simulateContract({ ...tx, account } as never);
      const hash = await wallet.writeContract(request as never);
      console.log(`  ${label}: ${explorerTx(hash)}`);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Fail(`${label} reverted: ${explorerTx(hash)}`);
    } catch (e) {
      if (e instanceof Fail) throw e;
      throw new Fail(`${label} failed: ${formatError(e)}`);
    }
  };

  const entry = TREES.find((t) => t.source === "real");
  if (!entry) throw new Fail("No real tree in lib/trees.ts.");
  const tree = await loadTreeEntry(entry);
  if (!tree.ok) throw new Fail(`Could not load the tree: ${tree.error}`);
  const nodes = [...tree.data.nodes].sort((a, b) => a.seq - b.seq);
  const names = ensNames(nodes);

  // 1. One real subname per version, in the tree's registry.
  console.log(`${nodes.length} versions under ${TREE_NAME}\n`);
  let registered = 0;
  for (const [i, n] of nodes.entries()) {
    const label = versionLabel(i + 1);
    const state = await client.readContract({ address: dep.tree.registry, abi: registryAbi, functionName: "getState", args: [labelId(label)] });
    if (state.status === 2) continue;
    await send(`register ${names.get(n.id)} (${n.short})`, {
      address: dep.tree.registry, abi: registryAbi, functionName: "register",
      args: [label, dep.owner, zeroAddress, dep.resolver, 0n, NEVER],
    });
    registered++;
  }
  console.log(registered === 0 ? "Every version is already a subname." : `Registered ${registered} new subnames.`);

  // 2. The tree name's records.
  const want: Record<string, string> = { "petri.tree": TREE_TITLE, "petri.count": String(nodes.length) };
  nodes.forEach((n, i) => (want[`petri.${versionLabel(i + 1)}`] = n.id));
  const [have] = await resolveRecords([TREE_NAME], { keys: Object.keys(want), rpcUrl });
  if (have.error) throw new Fail(`Could not read ${TREE_NAME}: ${have.error}`);
  const changed = Object.keys(want).filter((k) => (have.texts[k] ?? "") !== want[k]);
  if (changed.length === 0) {
    console.log("The tree records are up to date.");
    return;
  }
  const calls = changed.map((k) =>
    encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "setText", args: [dnsEncode(TREE_NAME), k, want[k]] }),
  );
  await send(`write ${changed.length} tree records`, { address: dep.resolver, abi: PermissionedResolverImplAbi, functionName: "multicall", args: [calls] });
  console.log("Done.");
}

main().catch((e) => {
  console.error(e instanceof Fail ? e.message : `Unexpected error: ${formatError(e)}`);
  process.exit(1);
});
