import { NextResponse } from "next/server";
import { treePlan } from "@/lib/ens/records";
import { TREES, loadTreeEntry } from "@/lib/trees";

export const dynamic = "force-dynamic";

/**
 * The records to publish on ENS: every version of the real tree with its
 * name and text records, the same plan `npm run ens:publish` writes. The
 * /ens publish card reads it. Showcase trees are never published.
 */
export async function GET() {
  const entry = TREES.find((t) => t.source === "real");
  if (!entry) return NextResponse.json({ error: "No real tree is configured" }, { status: 500 });
  const tree = await loadTreeEntry(entry);
  if (!tree.ok) return NextResponse.json({ error: tree.error }, { status: 500 });
  // The harness key names the root, as on the tree page.
  return NextResponse.json(treePlan(tree.data, entry.harness.key), { headers: { "cache-control": "no-store" } });
}
