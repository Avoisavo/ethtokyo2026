import type { ExportNode } from "../types";

/**
 * The ENS name of every tree version, on Sepolia ENSv2.
 *
 * The tree is one name under petri.eth. Each version is one subname of the
 * tree, numbered in log order, so `v1` is the root and `v3` is the third
 * version that was proposed:
 *
 *   petriharnessv1-claudesonnet5-coding.petri.eth        the tree
 *   v1.petriharnessv1-claudesonnet5-coding.petri.eth     the root, 0a54718a
 *   v3.petriharnessv1-claudesonnet5-coding.petri.eth     872aaa3d
 *
 * The number says nothing about the parent. The `petri.parent` record does,
 * and the tree name's `petri.v1` record says which version id `v1` is. A verify
 * round of v3 is `v3-1.v3.…`, and a chosen verifier is `k3.v3-1.v3.…`. Labels
 * cannot hold a dot, so `v3.1` in the UI is `v3-1` on chain.
 */

export const ENS_SUFFIX = "petri.eth";

/** The one real tree: "Petri harness v1 × Claude Sonnet 5 (Coding)". */
export const TREE_LABEL = "petriharnessv1-claudesonnet5-coding";
export const TREE_NAME = `${TREE_LABEL}.${ENS_SUFFIX}`;

/** The label of the version at `seq`, counted from 1. */
export const versionLabel = (index: number): string => `v${index}`;

/**
 * The tree label of a harness key. The real tree has its fixed label. A
 * showcase tree takes its harness key, so its names never collide with the
 * real one: "hermes-agent" → hermes-agent.petri.eth.
 */
export const treeLabelOf = (harness?: string): string =>
  harness === undefined || harness === "petri-harness-v1" ? TREE_LABEL : harness.toLowerCase().replace(/[^a-z0-9-]+/g, "-");

/** The version name for a label: `v3` → `v3.<tree>.petri.eth`. */
export const versionName = (label: string, harness?: string): string => `${label}.${treeLabelOf(harness)}.${ENS_SUFFIX}`;

/** Where a name opens in the ENSv2 explorer (explorer.ens.dev), which indexes Sepolia. */
export const ensAppUrl = (name: string): string => `https://explorer.ens.dev/${name}`;

/**
 * Map from node id to its full ENS name. Versions are numbered in `seq` order,
 * so the numbers are stable as long as the log only grows.
 */
export function ensNames(nodes: ExportNode[], harness?: string): Map<string, string> {
  const names = new Map<string, string>();
  [...nodes].sort((a, b) => a.seq - b.seq).forEach((n, i) => names.set(n.id, versionName(versionLabel(i + 1), harness)));
  return names;
}
