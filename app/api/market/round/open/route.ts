import { findVersion, openRound } from "@/lib/market/service";
import { handle, body } from "../../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { id } = await body<{ id?: string }>(request);
  return handle(async () => openRound((await findVersion(String(id ?? ""))).label));
}
