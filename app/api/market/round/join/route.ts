import { joinRound } from "@/lib/market/service";
import { handle, body } from "../../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const b = await body<{ id?: string; wallet?: string; accessKey?: string; signature?: string; attemptId?: string }>(request);
  return handle(() => joinRound(String(b.id ?? ""), {
    wallet: String(b.wallet ?? ""), accessKey: String(b.accessKey ?? ""), signature: String(b.signature ?? ""), attemptId: b.attemptId,
  }));
}
