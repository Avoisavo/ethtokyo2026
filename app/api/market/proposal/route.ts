import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { PETRI_ROOT } from "@/lib/tree";
import { demoWorldId, removeProposal } from "@/lib/market/service";
import { handle } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * The proposal `pnpm demo:propose` wrote in the Petri folder, or null. The
 * Propose tab polls this after you run the command in your own terminal.
 */
export async function GET() {
  return handle(async () => {
    const file = path.join(PETRI_ROOT, ".petri", "scratch", "demo-proposal", "proposal.json");
    const demo = demoWorldId();
    if (!existsSync(file)) return { proposal: null, demo };
    return { proposal: JSON.parse(readFileSync(file, "utf8")) as unknown, demo };
  });
}

/** Hides a version proposed from the web app from the tree, by `id`. Its ENS name and round stay. */
export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  return handle(() => removeProposal(id));
}
