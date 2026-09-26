import { type Address, createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

import { PermissionedResolverImplAbi } from "@/app/ens/_lib/ens/abis/PermissionedResolverImpl";
import { keyResource } from "@/app/ens/_lib/ens/permissioned-resolver";
import { ResolverRoles } from "@/app/ens/_lib/ens/roles";
import { loadDeployment } from "@/lib/market/chain";
import { ACCESS_KEYS } from "@/lib/market/records";
import { handle } from "../_shared";

export const dynamic = "force-dynamic";

/** Reads logs over a wide block range. The Alchemy plan in .env.local refuses eth_getLogs. */
const LOGS_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
/** Before the platform resolver took its first role. */
const FROM_BLOCK = 11_780_000n;

/**
 * The access control of `petri.vote`, read from the chain: every time the
 * platform resolver granted or revoked the right to write it, with the tx,
 * and the wallets that hold it now. With `?wallet=`, a live `hasRoles` check
 * for that wallet too.
 */
export async function GET(request: Request) {
  const wallet = new URL(request.url).searchParams.get("wallet");
  return handle(async () => {
    const { resolver } = loadDeployment();
    const client = createPublicClient({ chain: sepolia, transport: http(LOGS_RPC) });
    const resource = keyResource(ACCESS_KEYS.vote);
    const logs = await client.getContractEvents({
      address: resolver, abi: PermissionedResolverImplAbi, eventName: "EACRolesChanged",
      args: { resource } as never, fromBlock: FROM_BLOCK, toBlock: "latest",
    });
    const times = new Map<bigint, number>();
    for (const b of new Set(logs.map((l) => l.blockNumber))) times.set(b, Number((await client.getBlock({ blockNumber: b })).timestamp));
    const changes = logs.map((l) => {
      const a = l.args as { account: Address; oldRoleBitmap: bigint; newRoleBitmap: bigint };
      const bit = ResolverRoles.ROLE_SET_TEXT;
      return {
        account: a.account,
        kind: (a.newRoleBitmap & bit) !== 0n ? "grant" as const : "revoke" as const,
        from: Number(a.oldRoleBitmap), to: Number(a.newRoleBitmap),
        tx: l.transactionHash, block: Number(l.blockNumber), time: times.get(l.blockNumber)!,
      };
    });
    const last = new Map<string, number>();
    for (const c of changes) last.set(c.account.toLowerCase(), c.to);
    const holders = [...last].filter(([, bits]) => (BigInt(bits) & ResolverRoles.ROLE_SET_TEXT) !== 0n).map(([a]) => a);
    const now = wallet && /^0x[0-9a-fA-F]{40}$/.test(wallet)
      ? await client.readContract({ address: resolver, abi: PermissionedResolverImplAbi, functionName: "hasRoles", args: [resource, ResolverRoles.ROLE_SET_TEXT, wallet as Address] })
      : null;
    return { resolver, resource: `0x${resource.toString(16)}`, changes, holders, wallet, hasRole: now };
  });
}
