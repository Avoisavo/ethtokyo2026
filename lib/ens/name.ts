import type { ExportNode } from "../types";

/**
 * ENS-style hierarchical names for tree versions.
 *
 * Each version's label is its motif (already a short kebab-case slug), and its
 * name is that label on top of its parent's name, leaf first, like ENS:
 *
 *   petriharnessv1.petri.eth                 (the root: the harness itself)
 *   addsigs.petriharnessv1.petri.eth
 *   dropsigs.addsigs.petriharnessv1.petri.eth
 *
 * Every label says what that version does. Known motifs use ACTION_LABELS;
 * a new motif gets an automatic label from its slug (below).
 *
 * Each version adds one short label: the first two meaningful words of its
 * motif, joined with no dash, when they fit in MAX_LABEL characters
 * ("last-fence-not-first" → "lastfence"), otherwise the first word alone ("signatures-and-example" →
 * "signatures"). Filler words are skipped, and a root "genesis-v1" becomes "v1".
 *
 * Two siblings with the same motif get `2`, `3`… in the order they were
 * proposed, so every name is unique within its parent, as in a registry.
 */

export const ENS_SUFFIX = "petri.eth";

/**
 * Labels for known motifs, each saying what the version does. Read from the
 * hypothesis, not the slug: "positive-instructions" rewrites the rules as
 * do's, so it is "rewriterules". A motif not listed here falls back to toLabel.
 */
const ACTION_LABELS: Record<string, string> = {
  "signatures-and-example": "addsigs",
  "drop-example": "dropsigs",
  "restore-example": "restoresigs",
  "replicate-signatures": "retestsigs",
  "trim-prompt-tokens": "trimprompt",
  "restore-after-trim": "restoresigs",
  "restore-signatures-retest": "retestsigs",
  "short-prompt": "shortprompt",
  "positive-instructions": "rewriterules",
  "read-test-file": "readtests",
  "repair-turn": "retryempty",
  "last-fence-not-first": "lastcodeblock",
  "self-check-subprocess": "selftest",
  "one-call-per-symbol": "callpersymbol",
  "reserve-repair-budget": "repairbudget",
  "widen-contract": "addtaskhints",
};

/** Words that carry no idea, so they are skipped. */
const FILLER = new Set([
  "a", "an", "and", "the", "of", "to", "in", "on", "for", "with", "per", "after", "before", "not",
  // Says nothing about the idea: "drop-example" is about dropping, so it becomes "drop".
  "example",
]);
/** Longest label, so names stay short. */
const MAX_LABEL = 14;

/** A short, valid ENS label: lowercase letters and digits only, no dashes. */
function toLabel(raw: string, fallback: string, isRoot: boolean): string {
  let words = raw.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !FILLER.has(w));
  if (isRoot && words[0] === "genesis" && words.length > 1) words = words.slice(1);
  if (words.length === 0) return fallback;
  const two = words.slice(0, 2).join("");
  return (two.length <= MAX_LABEL ? two : words[0]).slice(0, 63);
}

/** The root's label: the harness name with every separator removed ("petri-harness-v1" → "petriharnessv1"). */
const rootLabelOf = (harness: string): string => harness.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 63);

/**
 * Map from node id to its full ENS-style name. `harness` names the root, the
 * first version of the tree; without it the root falls back to its motif.
 */
export function ensNames(nodes: ExportNode[], harness?: string): Map<string, string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Unique label per node among its siblings, by proposal order.
  const labels = new Map<string, string>();
  const taken = new Map<string, Set<string>>();
  for (const n of [...nodes].sort((a, b) => a.seq - b.seq)) {
    const parentKey = byId.has(n.parent) ? n.parent : "";
    const used = taken.get(parentKey) ?? new Set<string>();
    const motif = n.detail.proposal.motif ?? "";
    const isRoot = parentKey === "";
    const base = (isRoot && harness && rootLabelOf(harness)) || ACTION_LABELS[motif] || toLabel(motif, n.short, isRoot);
    let label = base;
    for (let k = 2; used.has(label); k++) label = `${base}${k}`;
    used.add(label);
    taken.set(parentKey, used);
    labels.set(n.id, label);
  }

  const names = new Map<string, string>();
  const nameOf = (id: string, seen: Set<string>): string => {
    const cached = names.get(id);
    if (cached) return cached;
    const n = byId.get(id)!;
    // A missing parent (or a cycle, which should never happen) ends the chain at the suffix.
    const parent = byId.has(n.parent) && !seen.has(n.parent) ? nameOf(n.parent, seen.add(id)) : ENS_SUFFIX;
    const name = `${labels.get(id)}.${parent}`;
    names.set(id, name);
    return name;
  };
  for (const n of nodes) nameOf(n.id, new Set());
  return names;
}
