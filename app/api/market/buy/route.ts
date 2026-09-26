import { buyVersion } from "@/lib/market/service";
import { handle, body } from "../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const b = await body<{ label?: string; wallet?: string; accessKey?: string; signature?: string; txHash?: string }>(request);
  return handle(() => buyVersion(String(b.label ?? ""), {
    wallet: String(b.wallet ?? ""), accessKey: String(b.accessKey ?? ""), signature: String(b.signature ?? ""), txHash: String(b.txHash ?? ""),
  }));
}
