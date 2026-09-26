/**
 * Runs the whole market once on Sepolia, from the terminal, with a test
 * verifier wallet. No World ID: the submit uses a made-up nullifier, which
 * only the server function accepts. Use it to check the chain writes work.
 *
 *   npm run market:smoke -- ae0acec3
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { type Hex, createPublicClient, createWalletClient, encodeFunctionData, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { PermissionedResolverImplAbi } from "@/app/ens/_lib/ens/abis/PermissionedResolverImpl";
import { dnsEncode } from "@/app/ens/_lib/ens/names";

async function main() {
  const envFile = path.join(process.cwd(), ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const id = process.argv[2] ?? "ae0acec3";

  const { SEPOLIA_RPC_URL } = await import("@/lib/ens/resolve");
  const { loadDeployment, readTexts } = await import("@/lib/market/chain");
  const { newAccessKeyPair, openFileKey, decryptText } = await import("@/lib/market/crypto");
  const { ACCESS_KEYS, VERSION_KEYS, docKey } = await import("@/lib/market/records");
  const { accessMessage, closeRound, joinRound, pickRound, submitVersion } = await import("@/lib/market/service");

  const dep = loadDeployment();
  const client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) });
  const server = privateKeyToAccount(process.env.PETRI_ENS_PRIVATE_KEY as Hex);
  const serverWallet = createWalletClient({ account: server, chain: sepolia, transport: http(SEPOLIA_RPC_URL) });

  console.log("1. submit (free, test nullifier)");
  const sub = await submitVersion(id, { kind: "free", nullifier: `0xtest${Date.now()}` });
  console.log("  ", sub.name, "tx", sub.tx, "round", sub.round.name);

  console.log("2. a test verifier joins");
  const vKey = generatePrivateKey();
  const verifier = privateKeyToAccount(vKey);
  const access = newAccessKeyPair();
  const signature = await verifier.signMessage({ message: accessMessage(access.publicKey) });
  const joined = await joinRound(sub.label, sub.round.n, { wallet: verifier.address, accessKey: access.publicKey, signature });
  console.log("   pool", joined.pool.length, "tx", joined.tx);

  console.log("3. pick (forced, the window is not over)");
  const picked = await pickRound(sub.label, sub.round.n, true);
  console.log("   seed", picked.seed.slice(0, 18), "verifiers", picked.verifiers.map((v) => v.name));
  const mine = picked.verifiers.find((v) => v.wallet.toLowerCase() === verifier.address.toLowerCase())!;

  console.log("4. the verifier opens the key and reads harness.md");
  const t = await readTexts(mine.name, [ACCESS_KEYS.key]);
  const fileKey = openFileKey(t[ACCESS_KEYS.key], access.secretKey);
  const v = await readTexts(sub.name, [docKey("harness.md"), VERSION_KEYS.docList]);
  console.log("   files:", v[VERSION_KEYS.docList]);
  console.log("   " + decryptText(fileKey, v[docKey("harness.md")]).split("\n")[0]);

  console.log("5. the verifier writes its vote with its own wallet");
  const fund = await serverWallet.sendTransaction({ to: verifier.address, value: parseEther("0.003") });
  await client.waitForTransactionReceipt({ hash: fund });
  const vWallet = createWalletClient({ account: verifier, chain: sepolia, transport: http(SEPOLIA_RPC_URL) });
  const { request } = await client.simulateContract({
    account: verifier, address: dep.resolver, abi: PermissionedResolverImplAbi, functionName: "setText",
    args: [dnsEncode(mine.name), ACCESS_KEYS.vote, "yes:+7000bp"],
  });
  const voteTx = await vWallet.writeContract(request);
  await client.waitForTransactionReceipt({ hash: voteTx });
  console.log("   vote tx", voteTx);
  void encodeFunctionData;

  console.log("6. close");
  const closed = await closeRound(sub.label, sub.round.n, true);
  console.log("   ", closed.status, "yes", closed.yes, "no", closed.no, "txs", closed.txs.length);
  const after = await readTexts(mine.name, [ACCESS_KEYS.key]);
  console.log("   sealed key after close:", after[ACCESS_KEYS.key] === "" ? "gone" : "STILL THERE");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
