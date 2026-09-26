import { checkSubmitProof } from "@/lib/market/world";
import { type Claim, MarketError, type Proposal, type SubmitMode, type SubmitStep, proposeVersion, submitVersion } from "@/lib/market/service";
import type { IDKitResultV3 } from "@/lib/world/idkit/types";
import { body } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * Submits a version to the market: a pending version of the log (`id`), or a
 * new proposal from the page (`parent` and `proposal`). It pays with a World
 * ID proof (free, rate limited) or a USDC stake transaction. The answer is a
 * stream of JSON lines, one per step: check, name, records, files, round, then
 * done. A failure is a last line { "error": "…" }.
 */
export async function POST(request: Request) {
  const b = await body<{ id?: string; parent?: string; proposal?: Proposal; result?: IDKitResultV3; txHash?: string; demo?: boolean; claim?: Claim; wallet?: string }>(request);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (line: SubmitStep | { error: string }) => ctrl.enqueue(enc.encode(`${JSON.stringify(line)}\n`));
      try {
        // A World ID proof for a proposal carries the parent id as its signal.
        const id = String(b.parent ?? b.id ?? "");
        let mode: SubmitMode;
        if (b.demo) mode = { kind: "demo" };
        else if (b.result) mode = { kind: "free", nullifier: (await checkSubmitProof(id, b.result)).nullifier };
        else if (b.txHash) mode = { kind: "stake", txHash: b.txHash };
        else throw new MarketError("Send a World ID result, or a USDC stake txHash.");
        if (b.parent && b.proposal) await proposeVersion(id, mode, b.proposal, send, b.wallet);
        else await submitVersion(id, mode, b.claim, send);
      } catch (e) {
        send({ error: e instanceof MarketError ? e.message : e instanceof Error ? e.message : String(e) });
      }
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
