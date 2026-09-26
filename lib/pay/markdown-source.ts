import "server-only";

import { ensNames } from "../ens/name";
import { loadTree, snapshotMode } from "../tree";
import { factsFromExport, factsFromShow, renderMarkdown, type ShowNode } from "./markdown";
import { engineInstalled, petriCountedKeys, petriShow, verifierIdentity } from "./petri-verify";

/**
 * The markdown file for one version, built before the seller asks for money:
 * a version that does not exist is a 404, never a charge.
 *
 * The facts come from the live engine when it is installed and a Petri key is
 * set (the saved snapshot can be behind the log), and from the snapshot otherwise.
 */
export type VersionFile =
  | { ok: true; id: string; file: string; markdown: string; source: "live" | "snapshot" }
  | { ok: false; status: number; code: string; detail: string };

const g = globalThis as unknown as { __petriMarkdown?: Map<string, { at: number; file: Promise<VersionFile> }> };
const cache = (g.__petriMarkdown ??= new Map());
const TTL_MS = 30_000;

/**
 * Cached for 30 s per version, and concurrent requests share one build: every
 * unpaid GET would otherwise start a `petri show` process.
 */
export function versionMarkdown(versionId: string, home: string | null): Promise<VersionFile> {
  const key = `${versionId}|${home ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.file;
  const file = buildVersionMarkdown(versionId, home);
  cache.set(key, { at: Date.now(), file });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return file;
}

async function buildVersionMarkdown(versionId: string, home: string | null): Promise<VersionFile> {
  const tree = await loadTree();
  if (!tree.ok) return { ok: false, status: 503, code: "tree_unavailable", detail: tree.error };
  const matches = tree.data.nodes.filter((n) => n.id.startsWith(versionId));
  if (matches.length !== 1) {
    return matches.length === 0
      ? { ok: false, status: 404, code: "version_not_found", detail: `No version ${versionId} in this tree.` }
      : { ok: false, status: 400, code: "ambiguous_version", detail: `${versionId} matches ${matches.length} versions. Use more characters.` };
  }
  const n = matches[0];
  const ens = ensNames(tree.data.nodes, "petri-harness-v1").get(n.id) ?? null;

  let facts = factsFromExport(n, ens, snapshotMode() ? "snapshot" : "live");
  if (engineInstalled() && verifierIdentity(home).ok) {
    const [live, status] = await Promise.all([petriShow(n.id, home!), petriCountedKeys(n.id, home!)]);
    if (live.ok) facts = factsFromShow(live.node as ShowNode, n.label, ens, status.ok ? status.counted : null);
  }
  return { ok: true, id: n.id, file: `petri-${n.id.slice(0, 8)}.md`, markdown: renderMarkdown(facts, Date.now()), source: facts.source };
}
