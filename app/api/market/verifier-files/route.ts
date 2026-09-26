import { versionDocs } from "@/lib/market/docs";
import { findVersion } from "@/lib/market/service";
import { handle } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * The files a picked verifier opens: the same set a buyer gets. For the stage
 * demo of the Verify tab, which picks you at once. A real round seals the file
 * key to the verifier's access key instead, as the buy does.
 */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  return handle(async () => {
    const { node } = await findVersion(id);
    return { files: versionDocs(node.id, node.hypothesis) };
  });
}
