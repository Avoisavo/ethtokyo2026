import { createPublicClient, http, namehash } from "viem";
import { sepolia } from "viem/chains";

import { PermissionedResolverImplAbi } from "@/app/ens/_lib/ens/abis/PermissionedResolverImpl";
import { loadDeployment } from "@/lib/market/chain";
import { RECORD_KEYS } from "@/lib/ens/records";
import { handle } from "../_shared";

export const dynamic = "force-dynamic";

/** Reads logs over a wide block range. The Alchemy plan in .env.local refuses eth_getLogs. */
const LOGS_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const FROM_BLOCK = 11_780_000n;

/**
 * The 2 verifier records of a version name, `petri.verifier.1` and `.2`, with
 * the Sepolia tx that last wrote each one. The resolver keeps records by a
 * record id, and `Linked` ties the name to it.
 */
export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("name") ?? "";
  return handle(async () => {
    const { resolver } = loadDeployment();
    const client = createPublicClient({ chain: sepolia, transport: http(LOGS_RPC) });
    const links = await client.getContractEvents({
      address: resolver, abi: PermissionedResolverImplAbi, eventName: "Linked",
      args: { node: namehash(name) } as never, fromBlock: FROM_BLOCK, toBlock: "latest",
    });
    const recordId = (links.at(-1)?.args as { recordId?: bigint } | undefined)?.recordId;
    const out: Record<string, { value: string; tx: string; time: number } | null> = {};
    for (const key of [RECORD_KEYS.verifier1, RECORD_KEYS.verifier2]) {
      if (recordId === undefined) { out[key] = null; continue; }
      const logs = await client.getContractEvents({
        address: resolver, abi: PermissionedResolverImplAbi, eventName: "TextUpdated",
        args: { recordId, keyHash: key } as never, fromBlock: FROM_BLOCK, toBlock: "latest",
      });
      const l = logs.at(-1);
      out[key] = l ? { value: (l.args as { value: string }).value, tx: l.transactionHash, time: Number((await client.getBlock({ blockNumber: l.blockNumber })).timestamp) } : null;
    }
    return { name, records: out };
  });
}
