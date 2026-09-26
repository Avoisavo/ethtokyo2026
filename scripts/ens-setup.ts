/**
 * One-time setup of petri.eth on Sepolia ENSv2, from the server wallet.
 *
 *   npm run ens:setup
 *
 * It needs PETRI_ENS_PRIVATE_KEY in .env.local and some Sepolia ETH on that
 * wallet. Every step checks the chain first, so a re-run only does what is
 * missing. The result goes to lib/ens/deployment.json.
 *
 * Steps:
 *   1. Deploy the platform resolver (one PermissionedResolver, all roles to the wallet).
 *   2. Deploy the subname registry for petri.eth (one UserRegistry).
 *   3. Mint test USDC, approve, commit, wait 60 s, register petri.eth with both set.
 *   Then `npm run ens:tree` registers the trees and their versions.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  type Address,
  type Hex,
  bytesToHex,
  createWalletClient,
  erc20Abi,
  formatEther,
  http,
  parseAbi,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { ETHRegistrarAbi as RegistrarAbi } from "@/app/ens/_lib/ens/abis/ETHRegistrar";
import { addresses, explorerAddress, explorerTx } from "@/app/ens/_lib/ens/contracts";
import { formatError } from "@/app/ens/_lib/ens/errors";
import {
  PERMISSIONED_RESOLVER_IMPL,
  USER_REGISTRY_IMPL,
  VERIFIABLE_FACTORY,
  allRolesTo,
  encodeRegistryInit,
  encodeResolverInit,
  predictProxyAddress,
  registrySalt,
  resolverSalt,
  verifiableFactoryAbi,
} from "@/app/ens/_lib/ens/factory";
import { labelId, namehash } from "@/app/ens/_lib/ens/names";
import { ENS_SUFFIX } from "@/lib/ens/name";

class Fail extends Error {}

const LABEL = ENS_SUFFIX.replace(/\.eth$/, "");
const DURATION = BigInt(365 * 24 * 60 * 60);
const COMMIT_WAIT_MS = 65_000;
/** The largest uint64: a subname that never expires on its own. */
const NEVER = (1n << 64n) - 1n;
const OUT = path.join(process.cwd(), "lib", "ens", "deployment.json");

const usdcAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const registryStateAbi = parseAbi([
  "function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))",
  "function getSubregistry(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "function setSubregistry(uint256 anyId, address registry)",
  "function setResolver(uint256 anyId, address resolver)",
  "function setParent(address parent, string label)",
  "function getParent() view returns (address parent, string label)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const envFile = path.join(process.cwd(), ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const { sepoliaClient, SEPOLIA_RPC_URL: rpcUrl } = await import("@/lib/ens/resolve");

  const key = process.env.PETRI_ENS_PRIVATE_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Fail("Set PETRI_ENS_PRIVATE_KEY (0x + 64 hex) in .env.local.");
  const account = privateKeyToAccount(key as Hex);
  const client = sepoliaClient(rpcUrl);
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });

  const balance = await client.getBalance({ address: account.address });
  console.log(`Wallet ${account.address}: ${formatEther(balance)} ETH`);
  if (balance === 0n) throw new Fail("The wallet has no Sepolia ETH. Fund it first.");

  // Every write goes through here: simulate, send, wait, and stop on a revert.
  const send = async (label: string, tx: Parameters<typeof client.simulateContract>[0]) => {
    try {
      const { request } = await client.simulateContract({ ...tx, account } as never);
      const hash = await wallet.writeContract(request as never);
      console.log(`  ${label}: ${explorerTx(hash)}`);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Fail(`${label} reverted: ${explorerTx(hash)}`);
      return receipt;
    } catch (e) {
      if (e instanceof Fail) throw e;
      throw new Fail(`${label} failed: ${formatError(e)}`);
    }
  };

  const setParent = async (registry: Address, parent: Address, label: string) => {
    const [p, l] = await client.readContract({ address: registry, abi: registryStateAbi, functionName: "getParent" });
    if (p.toLowerCase() === parent.toLowerCase() && l === label) return;
    await send(`name the parent of ${label}'s registry`, { address: registry, abi: registryStateAbi, functionName: "setParent", args: [parent, label] });
  };
  const hasCode = async (a: Address) => ((await client.getCode({ address: a })) ?? "0x") !== "0x";
  const proxyLogic = await client.readContract({ address: VERIFIABLE_FACTORY, abi: verifiableFactoryAbi, functionName: "proxyLogic" });
  const predict = (salt: bigint) => predictProxyAddress({ proxyLogic, deployer: account.address, salt });

  // 1. The platform resolver.
  const resolver = predict(resolverSalt(account.address));
  console.log(`\n1. Resolver ${resolver}`);
  if (await hasCode(resolver)) console.log("  already deployed");
  else {
    await send("deploy resolver", {
      address: VERIFIABLE_FACTORY, abi: verifiableFactoryAbi, functionName: "deployProxy",
      args: [PERMISSIONED_RESOLVER_IMPL, resolverSalt(account.address), encodeResolverInit(allRolesTo(account.address))],
    });
  }

  // 2. The subname registry for petri.eth.
  const registry = predict(registrySalt(namehash(ENS_SUFFIX)));
  console.log(`\n2. Registry for ${ENS_SUFFIX}: ${registry}`);
  if (await hasCode(registry)) console.log("  already deployed");
  else {
    await send("deploy registry", {
      address: VERIFIABLE_FACTORY, abi: verifiableFactoryAbi, functionName: "deployProxy",
      args: [USER_REGISTRY_IMPL, registrySalt(namehash(ENS_SUFFIX)), encodeRegistryInit(allRolesTo(account.address))],
    });
  }

  // 3. petri.eth itself.
  const registrar = addresses.ETHRegistrar;
  const ethRegistry = addresses.ETHRegistry;
  const usdc = addresses.MockUSDC;
  console.log(`\n3. ${ENS_SUFFIX}`);
  const available = await client.readContract({ address: registrar, abi: RegistrarAbi, functionName: "isAvailable", args: [LABEL] });
  if (!available) {
    const state = await client.readContract({ address: ethRegistry, abi: registryStateAbi, functionName: "getState", args: [labelId(LABEL)] });
    if (state.latestOwner.toLowerCase() !== account.address.toLowerCase()) {
      throw new Fail(`${ENS_SUFFIX} belongs to ${state.latestOwner}, not to this wallet.`);
    }
    console.log(`  already registered, expires ${new Date(Number(state.expiry) * 1000).toISOString()}`);
  } else {
    const [base, premium] = await client.readContract({
      address: registrar, abi: RegistrarAbi, functionName: "getRegisterPrice", args: [LABEL, DURATION, usdc],
    });
    const price = base + premium;
    const have = await client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    if (have < price) await send(`mint ${Number(price) / 1e6 * 2} USDC`, { address: usdc, abi: usdcAbi, functionName: "mint", args: [account.address, price * 2n] });
    const allowance = await client.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, registrar] });
    if (allowance < price) await send("approve USDC", { address: usdc, abi: erc20Abi, functionName: "approve", args: [registrar, (price * 101n) / 100n] });

    const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const commitment = await client.readContract({
      address: registrar, abi: RegistrarAbi, functionName: "makeCommitment",
      args: [LABEL, account.address, secret, registry, resolver, DURATION, zeroHash],
    });
    await send("commit", { address: registrar, abi: RegistrarAbi, functionName: "commit", args: [commitment] });
    console.log(`  waiting ${COMMIT_WAIT_MS / 1000} s for the commitment to age…`);
    await sleep(COMMIT_WAIT_MS);
    await send(`register ${ENS_SUFFIX} (${Number(price) / 1e6} USDC, 1 year)`, {
      address: registrar, abi: RegistrarAbi, functionName: "register",
      args: [LABEL, account.address, secret, registry, resolver, DURATION, usdc, zeroHash],
    });
  }
  const setResolver = await client.readContract({ address: ethRegistry, abi: registryStateAbi, functionName: "getResolver", args: [LABEL] });
  if (setResolver.toLowerCase() !== resolver.toLowerCase()) {
    await send("point petri.eth at the resolver", { address: ethRegistry, abi: registryStateAbi, functionName: "setResolver", args: [labelId(LABEL), resolver] });
  }
  const setRegistry = await client.readContract({ address: ethRegistry, abi: registryStateAbi, functionName: "getSubregistry", args: [LABEL] });
  if (setRegistry.toLowerCase() !== registry.toLowerCase()) {
    await send("point petri.eth at the registry", { address: ethRegistry, abi: registryStateAbi, functionName: "setSubregistry", args: [labelId(LABEL), registry] });
  }
  // The registry names its own parent, so indexers such as explorer.ens.dev file
  // its subnames under petri.eth. Without it they show no history and no subnames.
  await setParent(registry, ethRegistry, LABEL);

  const out = {
    chainId: 11155111,
    owner: account.address,
    resolver,
    registry,
    setupAt: new Date().toISOString(),
  };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\nDone. Saved to ${path.relative(process.cwd(), OUT)}`);
  console.log(`Resolver ${explorerAddress(resolver)}\nRegistry ${explorerAddress(registry)}\nNext: npm run ens:tree`);
}

main().catch((e) => {
  console.error(e instanceof Fail ? e.message : `Unexpected error: ${formatError(e)}`);
  process.exit(1);
});
