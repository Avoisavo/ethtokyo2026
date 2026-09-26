import type { NextRequest } from "next/server";
import { isAddress } from "viem";

import { WORLD_CHAIN_ID, checkAgentHuman } from "@/lib/world/agentkit/world-agentkit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/world/agentkit?address=0x…
 *
 * Asks World AgentBook, through AgentKit (`@worldcoin/agentkit`), whether an
 * agent's EVM address is registered to a verified human on World Chain. The
 * answer is the human's anonymous id, or null when the agent is not registered.
 * Register an agent with `npm run world:agentkit -- <address>`.
 */
export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address")?.trim() ?? "";
  if (!isAddress(address)) {
    return Response.json({ error: "address must be an EVM address (0x + 40 hex)" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  try {
    const human = await checkAgentHuman(address);
    return Response.json({ address, chain: WORLD_CHAIN_ID, registered: human !== null, human }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    // World Chain RPC unreachable. Not the same as "not registered".
    return Response.json(
      { error: `AgentBook lookup failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
