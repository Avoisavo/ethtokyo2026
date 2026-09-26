import type { ExportNode } from "../types";

/**
 * The ENS name of every tree version, on Sepolia ENSv2.
 *
 * A tree is domain × harness × model, and its name reads the same way, leaf
 * first: `claude-sonnet-5.petri-harness-v1.coding.petri.eth`. Under the tree
 * are three folders. A version lives in the one that matches its status, and
 * the platform moves it when the status changes:
 *
 *   v1.accepted.claude-sonnet-5.petri-harness-v1.coding.petri.eth   accepted, or the baseline
 *   v3.rejected.claude-sonnet-5.petri-harness-v1.coding.petri.eth   rejected
 *   v9.pending.claude-sonnet-5.petri-harness-v1.coding.petri.eth    waiting for keys
 *
 * `v<n>` counts versions in log order, so the number never changes. The
 * `petri.parent` record says which version a version came from. The tree name
 * holds `petri.v<n>` = the version id, so anyone can look a number up.
 */

export const ENS_SUFFIX = "petri.eth";

export type Folder = "accepted" | "rejected" | "pending";
export const FOLDERS: Folder[] = ["accepted", "rejected", "pending"];

/** The tree slug of the one real tree, as lib/trees.ts names it. */
export const REAL_TREE = "coding--petri-harness-v1--claude-sonnet-5";

/** The trees that are on chain. The others are showcase trees that stay off chain. */
export const ONCHAIN_TREES = [REAL_TREE, "research--hermes-agent--claude-sonnet-5"];

/** `coding--petri-harness-v1--claude-sonnet-5` → `claude-sonnet-5.petri-harness-v1.coding.petri.eth`. */
export function treeName(slug: string): string {
  const [domain, harness, model] = slug.split("--");
  return `${model}.${harness}.${domain}.${ENS_SUFFIX}`;
}

/** The names from the domain down to the tree: `coding.petri.eth`, `petri-harness-v1.coding.petri.eth`, the tree. */
export function treeLevels(slug: string): string[] {
  const [domain, harness, model] = slug.split("--");
  return [`${domain}.${ENS_SUFFIX}`, `${harness}.${domain}.${ENS_SUFFIX}`, `${model}.${harness}.${domain}.${ENS_SUFFIX}`];
}

export const folderName = (slug: string, folder: Folder): string => `${folder}.${treeName(slug)}`;

/** The label of the version at `seq`, counted from 1. */
export const versionLabel = (index: number): string => `v${index}`;

/** Where a version lives. The root is the baseline everything is measured against, so it sits with the accepted ones. */
export function folderOf(n: ExportNode): Folder {
  if (n.parent === "root" || n.status === "accepted") return "accepted";
  if (n.status === "rejected") return "rejected";
  return "pending";
}

export const versionName = (slug: string, label: string, folder: Folder): string => `${label}.${folderName(slug, folder)}`;

/** Where a name opens in the ENSv2 explorer (explorer.ens.dev), which indexes Sepolia. */
export const ensAppUrl = (name: string): string => `https://explorer.ens.dev/${name}`;

/** Map from node id to its label, `v<n>`, in `seq` order. */
export function versionLabels(nodes: ExportNode[]): Map<string, string> {
  const labels = new Map<string, string>();
  [...nodes].sort((a, b) => a.seq - b.seq).forEach((n, i) => labels.set(n.id, versionLabel(i + 1)));
  return labels;
}

/** Map from node id to its full ENS name, in the folder of its current status. */
export function ensNames(nodes: ExportNode[], slug: string = REAL_TREE): Map<string, string> {
  const labels = versionLabels(nodes);
  const names = new Map<string, string>();
  for (const n of nodes) names.set(n.id, versionName(slug, labels.get(n.id)!, folderOf(n)));
  return names;
}

/** The short label of a name: `v3.rejected.…` → `v3`. */
export const shortLabel = (name: string): string => name.split(".")[0];

/** `v3.rejected.<tree>` → the same label in another folder. */
export function moveName(name: string, folder: Folder): string {
  const [label, , ...rest] = name.split(".");
  return [label, folder, ...rest].join(".");
}

/**
 * The same versions, with `short` replaced by the ENS label (`v10`), for views
 * that only display it. The real short id stays where a command needs it.
 */
export function withVersionLabels<T extends ExportNode>(nodes: T[]): T[] {
  const labels = versionLabels(nodes);
  return nodes.map((n) => ({ ...n, short: labels.get(n.id) ?? n.short }));
}
