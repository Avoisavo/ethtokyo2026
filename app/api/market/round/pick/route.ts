import { pickRound } from "@/lib/market/service";
import { handle, body } from "../../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const b = await body<{ label?: string; n?: number; force?: boolean }>(request);
  return handle(() => pickRound(String(b.label ?? ""), Number(b.n ?? 0), b.force === true));
}
