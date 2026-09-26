/**
 * Publishes the Petri tree to ENS: each version's record as text records on
 * its name, written to the one resolver on petri.eth (Sepolia ENSv2).
 *
 *   npm run ens:publish -- --dry-run          what would be written; needs no key
 *   npm run ens:publish                       write it (PETRI_ENS_PRIVATE_KEY)
 *   npm run ens:publish -- --only ecc7cdb0    one version
 *   npm run ens:publish -- --chunk 30         setText calls per transaction (default 60)
 *
 * Only records that differ from what ENS returns now are written, so a re-run
 * after new checks sends just the keys that changed.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { type Address, type Hex, createWalletClient, encodeFunctionData, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { ETHRegistryAbi } from "@/app/ens/_lib/ens/abis/ETHRegistry";
import { PermissionedResolverImplAbi } from "@/app/ens/_lib/ens/abis/PermissionedResolverImpl";
import { explorerAddress, explorerTx } from "@/app/ens/_lib/ens/contracts";
import { formatError } from "@/app/ens/_lib/ens/errors";
import { walkHierarchy } from "@/app/ens/_lib/ens/hierarchy";
import { dnsEncode, labelId } from "@/app/ens/_lib/ens/names";
import { ResolverRoles } from "@/app/ens/_lib/ens/roles";
import { ENS_SUFFIX } from "@/lib/ens-name";
import { ALL_RECORD_KEYS, ENS_CHAIN_ID, type PlannedName, type RecordKey, changedKeys, treePlan } from "@/lib/ens-records";

/** An expected failure: printed as is, without a stack trace. */
class Fail extends Error {}

const DEFAULT_CHUNK = 60;
const CLIP = 72;

const SETUP = `Set it up once in the ENS playground (npm run dev, then http://localhost:3000/ens),
with the wallet whose key is PETRI_ENS_PRIVATE_KEY:
  1. Mint test USDC and deploy your resolver (section 1).
  2. Register petri.eth (section 2).
  3. Point petri.eth at your resolver (section 3: type petri.eth as the name, then "Use my resolver for this name").
Then run npm run ens:publish again. Section 8 of the playground can also publish from the browser.`;

function options() {
  let values;
  try {
    ({ values } = parseArgs({
      options: { "dry-run": { type: "boolean" }, only: { type: "string" }, chunk: { type: "string" } },
    }));
  } catch (e) {
    throw new Fail(`${(e as Error).message}\nUsage: npm run ens:publish -- [--dry-run] [--only <short-id>] [--chunk N]`);
  }
  const chunk = values.chunk === undefined ? DEFAULT_CHUNK : Number(values.chunk);
  if (!Number.isInteger(chunk) || chunk < 1) throw new Fail(`--chunk must be a positive whole number, got ${values.chunk}`);
  return { dryRun: values["dry-run"] ?? false, only: values.only, chunk };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const clip = (s: string) => (s.length > CLIP ? `${s.slice(0, CLIP - 1)}…` : s).replace(/\n/g, " ");

/** One version with what ENS holds for it now and the keys to write. */
type Pending = PlannedName & { keys: RecordKey[] };

async function main() {
  const opts = options();

  // Load .env.local before the modules below, since they read the environment when they load.
  const envFile = path.join(process.cwd(), ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const { TREES, loadTreeEntry } = await import("@/lib/trees");
  const { resolveRecords, sepoliaClient, SEPOLIA_RPC_URL: rpcUrl } = await import("@/lib/ens-resolve");

  // Only the real tree is published. Showcase trees were never measured.
  const entry = TREES.find((t) => t.source === "real");
  if (!entry) throw new Fail("No real tree in lib/trees.ts.");
  const tree = await loadTreeEntry(entry);
  if (!tree.ok) throw new Fail(`Could not load the tree from ${tree.root}:\n${tree.error}`);
  const plan = treePlan(tree.data, entry.harness.key);

  let planned = plan.names;
  if (opts.only) {
    planned = planned.filter((n) => n.short === opts.only || n.id.startsWith(opts.only!));
    if (planned.length === 0) {
      throw new Fail(`No version ${opts.only} in the tree. Short ids: ${plan.names.map((n) => n.short).join(" ")}`);
    }
  }

  const read = async (): Promise<Pending[]> => {
    const names = planned.map((n) => n.name);
    const found = await resolveRecords(names, { keys: ALL_RECORD_KEYS, rpcUrl });
    // The public RPC rate-limits bursts, so failed names are read again, slower.
    for (let attempt = 1; attempt <= 3 && found.some((l) => l.error); attempt++) {
      await sleep(1_000 * attempt);
      const retry = found.flatMap((l, i) => (l.error ? [i] : []));
      const again = await resolveRecords(retry.map((i) => names[i]), { keys: ALL_RECORD_KEYS, rpcUrl });
      retry.forEach((i, j) => (found[i] = again[j]));
    }
    const failed = found.filter((l) => l.error);
    if (failed.length > 0) {
      throw new Fail(
        `Could not read ENS for ${failed.length} name(s): ${failed[0].error}\n` +
          `RPC: ${rpcUrl}. Set NEXT_PUBLIC_SEPOLIA_RPC_URL in .env.local to use another one.`,
      );
    }
    return planned.map((n, i) => ({ ...n, keys: changedKeys(n.records, found[i].texts, ALL_RECORD_KEYS) as RecordKey[] }));
  };

  console.log(`Tree ${plan.tree}: ${planned.length} names under ${plan.suffix} on Sepolia (chain ${ENS_CHAIN_ID})\n`);
  const pending = await read();
  const total = pending.reduce((sum, p) => sum + p.keys.length, 0);

  const width = Math.max(4, ...pending.map((p) => p.name.length));
  console.log(`${"name".padEnd(width)}  ${"short".padEnd(8)}  to write`);
  for (const p of pending) console.log(`${p.name.padEnd(width)}  ${p.short.padEnd(8)}  ${p.keys.length}`);
  console.log(`\n${total} records to write, ${pending.filter((p) => p.keys.length === 0).length} of ${pending.length} names up to date.`);

  if (opts.dryRun) {
    for (const p of pending) {
      if (p.keys.length === 0) continue;
      console.log(`\n${p.name}`);
      for (const k of p.keys) console.log(`  ${k.padEnd(18)} ${p.records[k] === "" ? "(clear)" : clip(p.records[k])}`);
    }
    console.log("\nDry run: nothing was sent.");
    return;
  }
  if (total === 0) {
    console.log("Every record is up to date. Nothing to send.");
    return;
  }

  const key = process.env.PETRI_ENS_PRIVATE_KEY?.trim();
  if (!key) throw new Fail("Set PETRI_ENS_PRIVATE_KEY (0x + 64 hex) in .env.local, or run with --dry-run to only see the writes.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Fail("PETRI_ENS_PRIVATE_KEY must be 0x followed by 64 hex characters.");
  const account = privateKeyToAccount(key as Hex);
  const client = sepoliaClient(rpcUrl);

  // The resolver set on petri.eth itself. Every version name resolves through it as a wildcard.
  const walk = await walkHierarchy(client, ENS_SUFFIX);
  const hop = walk.hops.find((h) => h.name === ENS_SUFFIX);
  const state =
    hop &&
    (await client.readContract({
      address: hop.registry,
      abi: ETHRegistryAbi,
      functionName: "getState",
      args: [labelId(hop.label)],
    }));
  // Status 2 is REGISTERED. The registry already reports an expired name as available.
  if (!hop || !state || state.status !== 2) throw new Fail(`${ENS_SUFFIX} is not registered on Sepolia ENSv2.\n\n${SETUP}`);
  const resolver: Address | null = hop.resolver;
  if (!resolver) throw new Fail(`${ENS_SUFFIX} is registered to ${state.latestOwner} but has no resolver.\n\n${SETUP}`);

  const allowed = await client
    .readContract({
      address: resolver,
      abi: PermissionedResolverImplAbi,
      functionName: "hasRootRoles",
      args: [ResolverRoles.ROLE_SET_TEXT, account.address],
    })
    .catch((e: unknown) => {
      throw new Fail(`${ENS_SUFFIX}'s resolver ${resolver} is not a PermissionedResolver (${formatError(e)}).\n\n${SETUP}`);
    });
  if (!allowed) {
    throw new Fail(
      `${account.address} cannot set text records on ${ENS_SUFFIX}'s resolver ${resolver}.\n` +
        `Use the key of the account that deployed that resolver, or grant this account the text role in section 5 of /ens.`,
    );
  }
  const balance = await client.getBalance({ address: account.address });
  if (balance === 0n) throw new Fail(`${account.address} has no Sepolia ETH for gas. Get some from a Sepolia faucet.`);

  console.log(`\nResolver ${resolver} (${explorerAddress(resolver)})`);
  console.log(`Sender   ${account.address} (${formatEther(balance)} ETH)`);

  const calls: Hex[] = pending.flatMap((p) =>
    p.keys.map((k) =>
      encodeFunctionData({
        abi: PermissionedResolverImplAbi,
        functionName: "setText",
        args: [dnsEncode(p.name), k, p.records[k]],
      }),
    ),
  );
  const chunks: Hex[][] = [];
  for (let i = 0; i < calls.length; i += opts.chunk) chunks.push(calls.slice(i, i + opts.chunk));

  const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });
  for (const [i, chunk] of chunks.entries()) {
    const label = `Transaction ${i + 1} of ${chunks.length} (${chunk.length} records)`;
    try {
      const { request } = await client.simulateContract({
        account,
        address: resolver,
        abi: PermissionedResolverImplAbi,
        functionName: "multicall",
        args: [chunk],
      });
      const hash = await wallet.writeContract(request);
      console.log(`${label}: ${explorerTx(hash)}`);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Fail(`${label} reverted: ${explorerTx(hash)}`);
    } catch (e) {
      if (e instanceof Fail) throw e;
      throw new Fail(`${label} failed: ${formatError(e)}${chunks.length > 1 ? "\nRun again to send what is left; a smaller --chunk may help." : ""}`);
    }
  }

  // A load-balanced RPC can answer from a node a block behind, so a stale read gets one more try.
  let left = (await read()).reduce((sum, p) => sum + p.keys.length, 0);
  if (left > 0) {
    await sleep(5_000);
    left = (await read()).reduce((sum, p) => sum + p.keys.length, 0);
  }
  if (left > 0) throw new Fail(`\n${left} records still differ from the plan. Run again to send them.`);
  console.log(`\nDone: all ${pending.length} names hold their records.`);
}

main().catch((e) => {
  console.error(e instanceof Fail ? e.message : `Unexpected error: ${formatError(e)}`);
  process.exit(1);
});
