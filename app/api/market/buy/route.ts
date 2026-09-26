import { MarketError, buyVersion, type BuyStep } from "@/lib/market/service";
import { body } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * Buys a version. The answer is a stream of JSON lines, one per step, so the
 * page can show each step as it happens: check, files, name, key, then done
 * with the new name. A failure is a last line { "error": "…" }.
 */
export async function POST(request: Request) {
  const b = await body<{ id?: string; wallet?: string; accessKey?: string; signature?: string; txHash?: string }>(request);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (line: BuyStep | { error: string }) => ctrl.enqueue(enc.encode(`${JSON.stringify(line)}\n`));
      try {
        await buyVersion(String(b.id ?? ""), {
          wallet: String(b.wallet ?? ""), accessKey: String(b.accessKey ?? ""), signature: String(b.signature ?? ""), txHash: String(b.txHash ?? ""),
        }, send);
      } catch (e) {
        send({ error: e instanceof MarketError ? e.message : e instanceof Error ? e.message : String(e) });
      }
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
