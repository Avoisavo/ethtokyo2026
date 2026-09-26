/**
 * The verifier's vote, on chain: `pnpm demo:vote v18 yes` (or `no`).
 *
 * It signs with the verifier wallet the platform made when you joined on the
 * Verify tab, and writes `petri.vote` on your verifier name. The resolver lets
 * only that wallet write that key: the access control is open for you now.
 * Then it asks the platform to close the round, which takes the right back.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createPublicClient, createWalletClient, http, parseAbi, bytesToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { packetToBytes } from 'viem/ens';
import { sepolia } from 'viem/chains';

const ROOT = resolve(import.meta.dirname, '..', '..');
const env = join(ROOT, '.env.local');
if (existsSync(env)) process.loadEnvFile(env);
const RPC = process.env['NEXT_PUBLIC_SEPOLIA_RPC_URL'] || 'https://ethereum-sepolia-rpc.publicnode.com';
const WEB = process.env['PETRI_WEB_URL'] ?? 'http://localhost:3000';

const version = (process.argv[2] ?? 'v18').split('.')[0]!;
const choice = (process.argv[3] ?? 'yes').toLowerCase();
if (choice !== 'yes' && choice !== 'no') { console.error('say yes or no: pnpm demo:vote v18 yes'); process.exit(2); }
const vote = choice === 'yes' ? 'yes:+7000bp' : 'no:-7000bp';

const walletFile = join(ROOT, 'petri', '.petri', 'scratch', 'verifier-wallet.json');
if (!existsSync(walletFile)) { console.error('No verifier wallet. Join the round on the Verify tab first.'); process.exit(2); }
const w = JSON.parse(readFileSync(walletFile, 'utf8')) as { address: string; privateKey: Hex; verifier: string };
if (!w.verifier.startsWith(`verifier1.${version}.`)) { console.error(`You are picked for ${w.verifier}, not ${version}.`); process.exit(2); }
const { resolver } = JSON.parse(readFileSync(join(ROOT, 'lib', 'ens', 'deployment.json'), 'utf8')) as { resolver: Hex };

const abi = parseAbi(['function setText(bytes name, string key, string value)']);
const account = privateKeyToAccount(w.privateKey);
const client = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
const tx = (h: string) => `https://sepolia.etherscan.io/tx/${h}`;

async function main() {
  console.log(`verifier   ${w.verifier}`);
  console.log(`wallet     ${account.address}`);
  console.log(`vote       petri.vote = ${vote}`);
  const { request } = await client.simulateContract({ account, address: resolver, abi, functionName: 'setText', args: [bytesToHex(packetToBytes(w.verifier)), 'petri.vote', vote] });
  const hash = await wallet.writeContract(request);
  console.log(`sent       ${tx(hash)}`);
  await client.waitForTransactionReceipt({ hash, pollingInterval: 1_000 });
  console.log('on chain   your wallet wrote the vote. Only it may write petri.vote on this name.\n');

  console.log('close      the platform takes the right back');
  const res = await fetch(`${WEB}/api/market/demo-verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'vote', voteTx: hash }) });
  const data = (await res.json()) as { ok: boolean; error?: string; round?: { txs: Record<string, string> } };
  if (!data.ok) { console.error(`close failed: ${data.error}`); process.exit(1); }
  console.log(`closed     ${tx(data.round!.txs['close']!)}`);
  console.log('done       the access control is closed. The names expire by themselves.');
}
main().catch((e) => { console.error(String((e as Error).message ?? e).split('\n')[0]); process.exit(1); });
