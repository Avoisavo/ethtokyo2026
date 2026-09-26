/**
 * A clean test of the explorer, the relay app's way:
 *   1. register petriv2.eth with NO subregistry (commit, wait, register)
 *   2. deploy its UserRegistry
 *   3. ETHRegistry.setSubregistry(petriv2, registry)   <- the event the indexer follows
 *   4. registry.setParent(ETHRegistry, "petriv2")
 *   5. register test.petriv2.eth in that registry, and write one record on each name
 */
import { type Address, bytesToHex, createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, parseAbi, zeroAddress, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { ETHRegistrarAbi } from "@/app/ens/_lib/ens/abis/ETHRegistrar";
import { PermissionedResolverImplAbi } from "@/app/ens/_lib/ens/abis/PermissionedResolverImpl";
import { addresses, explorerTx } from "@/app/ens/_lib/ens/contracts";
import {
  USER_REGISTRY_IMPL, VERIFIABLE_FACTORY, allRolesTo, encodeRegistryInit, predictProxyAddress, registrySalt, verifiableFactoryAbi,
} from "@/app/ens/_lib/ens/factory";
import { dnsEncode, labelId, namehash } from "@/app/ens/_lib/ens/names";

process.loadEnvFile(".env.local");
const LABEL = "petriv2", SUB = "test";
const RESOLVER = "0x599F57D68C77911060B0A64118C5ac9781f117eC" as Address; // our PermissionedResolver
const YEAR = BigInt(365 * 24 * 3600);
const regAbi = parseAbi([
  "function setSubregistry(uint256 anyId, address registry)",
  "function setParent(address parent, string label)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
]);

async function main() {
  const acct = privateKeyToAccount(process.env.PETRI_ENS_PRIVATE_KEY as `0x${string}`);
  const rpc = "https://ethereum-sepolia-rpc.publicnode.com";
  const c = createPublicClient({ chain: sepolia, transport: http(rpc) });
  const w = createWalletClient({ account: acct, chain: sepolia, transport: http(rpc) });
  const send = async (what: string, tx: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => {
    const { request } = await c.simulateContract({ ...tx, account: acct } as never);
    const h = await w.writeContract(request as never);
    const r = await c.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`${what} reverted ${h}`);
    console.log(`${what}: ${explorerTx(h)}`);
  };
  const R = addresses.ETHRegistrar, USDC = addresses.MockUSDC;

  // 1. Register with no subregistry.
  const [base, premium] = await c.readContract({ address: R, abi: ETHRegistrarAbi, functionName: "getRegisterPrice", args: [LABEL, YEAR, USDC] });
  const price = ((base + premium) * 101n) / 100n;
  const bal = await c.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [acct.address] });
  if (bal < price) await send("mint USDC", { address: USDC, abi: parseAbi(["function mint(address to, uint256 amount)"]), functionName: "mint", args: [acct.address, price * 2n] });
  const allow = await c.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [acct.address, R] });
  if (allow < price) await send("approve USDC", { address: USDC, abi: erc20Abi, functionName: "approve", args: [R, price] });
  const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const commitment = await c.readContract({ address: R, abi: ETHRegistrarAbi, functionName: "makeCommitment", args: [LABEL, acct.address, secret, zeroAddress, RESOLVER, YEAR, zeroHash] });
  await send("commit", { address: R, abi: ETHRegistrarAbi, functionName: "commit", args: [commitment] });
  console.log("waiting 65 s…");
  await new Promise((r) => setTimeout(r, 65_000));
  await send(`register ${LABEL}.eth (no subregistry)`, { address: R, abi: ETHRegistrarAbi, functionName: "register", args: [LABEL, acct.address, secret, zeroAddress, RESOLVER, YEAR, USDC, zeroHash] });

  // 2. Deploy its registry.
  const proxyLogic = await c.readContract({ address: VERIFIABLE_FACTORY, abi: verifiableFactoryAbi, functionName: "proxyLogic" });
  const salt = registrySalt(namehash(`${LABEL}.eth`));
  const registry = predictProxyAddress({ proxyLogic, deployer: acct.address, salt });
  if (((await c.getCode({ address: registry })) ?? "0x") === "0x") {
    await send("deploy the registry", { address: VERIFIABLE_FACTORY, abi: verifiableFactoryAbi, functionName: "deployProxy", args: [USER_REGISTRY_IMPL, salt, encodeRegistryInit(allRolesTo(acct.address))] });
  }
  console.log("registry", registry);

  // 3. Attach it, 4. link it back.
  await send("setSubregistry on the .eth registry", { address: addresses.ETHRegistry, abi: regAbi, functionName: "setSubregistry", args: [labelId(LABEL), registry] });
  await send("setParent on the new registry", { address: registry, abi: regAbi, functionName: "setParent", args: [addresses.ETHRegistry, LABEL] });

  // 5. One subname and one record on each.
  await send(`register ${SUB}.${LABEL}.eth`, { address: registry, abi: regAbi, functionName: "register", args: [SUB, acct.address, zeroAddress, RESOLVER, 0n, (1n << 64n) - 1n] });
  const calls = [
    encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "setText", args: [dnsEncode(`${LABEL}.eth`), "description", "Petri: an evolution tree for AI agent harnesses."] }),
    encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "setText", args: [dnsEncode(`${SUB}.${LABEL}.eth`), "description", "A test subname."] }),
    encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "setText", args: [dnsEncode(`${SUB}.${LABEL}.eth`), "petri.status", "accepted"] }),
  ];
  await send("write 3 records", { address: RESOLVER, abi: PermissionedResolverImplAbi, functionName: "multicall", args: [calls] });
  console.log(`\nhttps://explorer.ens.dev/${LABEL}.eth\nhttps://explorer.ens.dev/${SUB}.${LABEL}.eth`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message.split("\n").slice(0, 6).join("\n") : e); process.exit(1); });
