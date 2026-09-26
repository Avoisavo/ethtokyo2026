/**
 * Puts the trees on Sepolia ENSv2, and keeps them there.
 *
 *   npm run ens:tree                 both trees: names, folders, versions, records
 *   npm run ens:tree -- --burn-old   also burns the names of the earlier flat layout
 *
 * For each tree in ONCHAIN_TREES:
 *   1. The levels: coding.petri.eth, petri-harness-v1.coding.petri.eth, the tree.
 *   2. The three folders under the tree: accepted, rejected, pending.
 *   3. Every version, in the folder of its status. A version that changed
 *      status since the last run is burned in its old folder and registered
 *      in the new one.
 *   4. The tree name's records: petri.v<n> = the version id, and a description.
 *   5. Every version's records, the ones that differ.
 *
 * Every registry names its parent, so explorer.ens.dev files it under the
 * right name. Needs PETRI_ENS_PRIVATE_KEY in .env.local.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { createPublicClient, formatEther, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { explorerTx } from "@/app/ens/_lib/ens/contracts";
import { formatError } from "@/app/ens/_lib/ens/errors";
import { labelId } from "@/app/ens/_lib/ens/names";
import { FOLDERS, ONCHAIN_TREES, folderName, moveName, treeLevels, treeName, versionLabels, ensNames } from "@/lib/ens/name";

class Fail extends Error {}

async function main() {
  const envFile = path.join(process.cwd(), ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const burnOld = process.argv.includes("--burn-old");

  const { TREES, loadTreeEntry } = await import("@/lib/trees");
  const { SEPOLIA_RPC_URL } = await import("@/lib/ens/resolve");
  const { nodeRecords } = await import("@/lib/ens/records");
  const { registerSubname, revokeSubname, setWriteLog, stateOf, writeTexts } = await import("@/lib/market/chain");
  setWriteLog((what, hash) => console.log(`  ${what}: ${explorerTx(hash)}`));

  const key = process.env.PETRI_ENS_PRIVATE_KEY?.trim();
  if (!key) throw new Fail("Set PETRI_ENS_PRIVATE_KEY in .env.local.");
  const client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) });
  const account = privateKeyToAccount(key as `0x${string}`);
  console.log(`Wallet ${account.address}: ${formatEther(await client.getBalance({ address: account.address }))} ETH\n`);

  if (burnOld) {
    // The earlier layout: v<n>.petriharnessv1-claudesonnet5-coding.petri.eth in its own registry.
    const dep = JSON.parse(readFileSync(path.join(process.cwd(), "lib", "ens", "deployment.json"), "utf8")) as { tree?: { name: string; registry: `0x${string}` } };
    if (dep.tree) {
      console.log(`Burning the old layout under ${dep.tree.name}`);
      const abi = parseAbi(["function getState(uint256) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))"]);
      for (let i = 1; i <= 40; i++) {
        const st = await client.readContract({ address: dep.tree.registry, abi, functionName: "getState", args: [labelId(`v${i}`)] });
        if (st.status === 2) await revokeSubname(`v${i}.${dep.tree.name}`);
      }
      await revokeSubname(dep.tree.name);
    }
  }

  for (const entry of TREES.filter((t) => ONCHAIN_TREES.includes(t.slug))) {
    const tree = await loadTreeEntry(entry);
    if (!tree.ok) throw new Fail(`Could not load ${entry.slug}: ${tree.error}`);
    const nodes = [...tree.data.nodes].sort((a, b) => a.seq - b.seq);
    const title = `${entry.harness.name} × ${entry.model.name} (${entry.domain.name})`;
    console.log(`\n== ${title}: ${nodes.length} versions → ${treeName(entry.slug)}`);

    // 1. The levels, 2. the folders.
    for (const name of treeLevels(entry.slug)) await registerSubname(name);
    for (const f of FOLDERS) await registerSubname(folderName(entry.slug, f));

    // 3. Every version, moved when its status changed.
    const names = ensNames(nodes, entry.slug);
    const labels = versionLabels(nodes);
    let moved = 0;
    for (const n of nodes) {
      const name = names.get(n.id)!;
      for (const f of FOLDERS) {
        const other = moveName(name, f);
        if (other === name) continue;
        if ((await stateOf(other)).exists) {
          console.log(`  ${labels.get(n.id)} moved to ${name.split(".")[1]}`);
          await revokeSubname(other);
          moved++;
        }
      }
      await registerSubname(name);
    }
    console.log(`  versions in place${moved ? `, ${moved} moved` : ""}`);

    // 4. The tree name's records.
    const treeRecords: Record<string, string> = {
      description: `${title}. ${nodes.length} versions. ${entry.source === "showcase" ? "Example data, never measured." : "Every score re-run by other keys."}`,
      "petri.count": String(nodes.length),
    };
    for (const n of nodes) treeRecords[`petri.${labels.get(n.id)}`] = n.id;
    await writeTexts(treeName(entry.slug), treeRecords);

    // 5. The version records.
    for (const n of nodes) {
      await writeTexts(names.get(n.id)!, nodeRecords(n, nodes, tree.data.bench.total, tree.data.policy.minVerifications));
    }
    console.log(`  records in place`);
  }
  console.log(`\nDone. ${formatEther(await client.getBalance({ address: account.address }))} ETH left.`);
}

main().catch((e) => {
  console.error(e instanceof Fail ? e.message : `Unexpected error: ${formatError(e)}`);
  process.exit(1);
});
