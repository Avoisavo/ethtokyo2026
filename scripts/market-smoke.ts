/**
 * Runs the whole market once on Sepolia, from the terminal, with two test
 * verifier wallets. No World ID: the submit uses a made-up nullifier, which
 * only the server function accepts. Use it to check the chain writes work.
 *
 *   npm run market:smoke -- ae0acec3
 *
 * The version must be pending. At the end it is accepted, and its name has
 * moved from pending.… to accepted.…
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { type Hex, createPublicClient, createWalletClient, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { PermissionedResolverImplAbi } from "@/app/ens/_lib/ens/abis/PermissionedResolverImpl";
import { explorerTx } from "@/app/ens/_lib/ens/contracts";
import { dnsEncode } from "@/app/ens/_lib/ens/names";

async function main() {
  const envFile = path.join(process.cwd(), ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const id = process.argv[2] ?? "ae0acec3";

  const { SEPOLIA_RPC_URL } = await import("@/lib/ens/resolve");
  const { loadDeployment, readTexts, setWriteLog } = await import("@/lib/market/chain");
  const { newAccessKeyPair, openFileKey, decryptText } = await import("@/lib/market/crypto");
  const { ACCESS_KEYS, VERSION_KEYS, docKey } = await import("@/lib/market/records");
  const { accessMessage, closeRound, joinRound, pickRound, submitVersion } = await import("@/lib/market/service");
  setWriteLog((what, hash) => console.log(`     ${what}: ${explorerTx(hash)}`));

  const dep = loadDeployment();
  const client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) });
  const server = privateKeyToAccount(process.env.PETRI_ENS_PRIVATE_KEY as Hex);
  const serverWallet = createWalletClient({ account: server, chain: sepolia, transport: http(SEPOLIA_RPC_URL) });

  console.log("1. submit (free, test nullifier)");
  const sub = await submitVersion(id, { kind: "free", nullifier: `0xtest${Date.now()}` });
  console.log("   version", sub.name, "\n   round", sub.round.name);

  console.log("2. two test verifiers join");
  const people = [1, 2].map(() => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    return { wallet, access: newAccessKeyPair() };
  });
  for (const p of people) {
    const signature = await p.wallet.signMessage({ message: accessMessage(p.access.publicKey) });
    const joined = await joinRound(id, { wallet: p.wallet.address, accessKey: p.access.publicKey, signature });
    console.log("   pool", joined.pool.length);
  }

  console.log("3. pick (forced, the window is not over)");
  const picked = await pickRound(id, true);
  console.log("   seed", picked.seed.slice(0, 18), "block", picked.block);
  for (const v of picked.verifiers) console.log("  ", v.name, "→", v.wallet);

  console.log("4. each verifier opens the key, reads harness.md, and votes with its own wallet");
  for (const p of people) {
    const mine = picked.verifiers.find((v) => v.wallet.toLowerCase() === p.wallet.address.toLowerCase())!;
    const t = await readTexts(mine.name, [ACCESS_KEYS.key]);
    const fileKey = openFileKey(t[ACCESS_KEYS.key], p.access.secretKey);
    const v = await readTexts(sub.name, [docKey("harness.md"), VERSION_KEYS.docList]);
    console.log("   ", mine.label, "reads:", decryptText(fileKey, v[docKey("harness.md")]).split("\n")[0]);
    const fund = await serverWallet.sendTransaction({ to: p.wallet.address, value: parseEther("0.003") });
    await client.waitForTransactionReceipt({ hash: fund });
    const w = createWalletClient({ account: p.wallet, chain: sepolia, transport: http(SEPOLIA_RPC_URL) });
    const { request } = await client.simulateContract({
      account: p.wallet, address: dep.resolver, abi: PermissionedResolverImplAbi, functionName: "setText",
      args: [dnsEncode(mine.name), ACCESS_KEYS.vote, "yes:+7000bp"],
    });
    const voteTx = await w.writeContract(request);
    await client.waitForTransactionReceipt({ hash: voteTx });
    console.log("   ", mine.label, "voted:", explorerTx(voteTx));
  }

  console.log("5. close: count, burn the verifiers, move the version");
  const closed = await closeRound(id, true);
  console.log("   ", closed.status, "yes", closed.yes, "no", closed.no);
  console.log("    now at", closed.moved);
  const after = await readTexts(closed.moved!, ["petri.status", "petri.verifier.1", "petri.verifier.2"]);
  console.log("   ", after);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
