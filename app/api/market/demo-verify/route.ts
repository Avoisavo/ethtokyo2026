import { type DemoStep, demoClose, demoJoin, demoReset, demoRound } from "@/lib/market/demo-verify";
import { MarketError } from "@/lib/market/service";
import { body, handle } from "../_shared";

export const dynamic = "force-dynamic";

/** The demo verify round now. The Verify tab polls this. */
export async function GET() {
  return handle(async () => ({ round: await demoRound() }));
}

/**
 * `step: "join"` with `id`, `human` (world or stake) and `price`: streams one
 * JSON line per step. `step: "vote"`: record the vote and close the access
 * control, after `pnpm demo:vote` sent it. `step: "reset"`: start again.
 */
export async function POST(request: Request) {
  const b = await body<{ id?: string; step?: string; human?: "world" | "stake"; price?: number; voteTx?: string; person?: string }>(request);
  if (b.step === "vote") return handle(async () => ({ round: await demoClose(b.voteTx) }));
  if (b.step === "reset") return handle(async () => demoReset());
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (line: DemoStep | { error: string }) => ctrl.enqueue(enc.encode(`${JSON.stringify(line)}\n`));
      try {
        if (b.step !== "join") throw new MarketError("step must be join, vote or reset.");
        await demoJoin(String(b.id ?? ""), { human: b.human === "stake" ? "stake" : "world", price: 5, person: String(b.person ?? "") }, send);
      } catch (e) {
        send({ error: e instanceof Error ? e.message : String(e) });
      }
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
