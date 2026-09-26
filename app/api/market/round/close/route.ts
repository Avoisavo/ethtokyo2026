import { closeRound } from "@/lib/market/service";
import { handle, body } from "../../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const b = await body<{ id?: string; force?: boolean }>(request);
  return handle(() => closeRound(String(b.id ?? ""), b.force === true));
}
