import { checkSubmitProof } from "@/lib/market/world";
import { MarketError, submitVersion } from "@/lib/market/service";
import type { IDKitResultV3 } from "@/lib/world/idkit/types";
import { handle, body } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * Submits a version to the market. Either a World ID proof (free, rate
 * limited) or a USDC stake transaction. The docs are encrypted and written to
 * the version name, and round 1 opens.
 */
export async function POST(request: Request) {
  const b = await body<{ id?: string; result?: IDKitResultV3; txHash?: string }>(request);
  return handle(async () => {
    const id = String(b.id ?? "");
    if (b.result) {
      const { nullifier } = await checkSubmitProof(id, b.result);
      return submitVersion(id, { kind: "free", nullifier });
    }
    if (b.txHash) return submitVersion(id, { kind: "stake", txHash: b.txHash });
    throw new MarketError("Send a World ID result, or a USDC stake txHash.");
  });
}
