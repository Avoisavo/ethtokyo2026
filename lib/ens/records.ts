import { ENS_SUFFIX, ensNames } from "./name";
import { isBlocked, isRoot, rootRerunBp } from "../format";
import type { ExportNode, NodeStatus, PetriExport } from "../types";

/**
 * The record a version keeps on its ENS name: 8 text records.
 *
 *   description        the hypothesis, in the standard key so any ENS app shows it
 *   petri.id           the version id
 *   petri.parent       the parent version id, empty on the root
 *   petri.status       accepted | rejected | pending | baseline
 *   petri.score        "19/20": tasks passed, median of the runs
 *   petri.delta        "+7000bp": the checked change against the parent
 *   petri.verifier.1   the first key that re-ran it and counted
 *   petri.verifier.2   the second key
 *   petri.cost         "1141 tokens/task": what the version costs to run, so the trade-off is on chain
 *
 * The market adds its own records after a submit (lib/market/records.ts).
 * Shared by the server, the publisher and the browser. Pure.
 */

/** Sepolia, where the ENSv2 contracts are deployed. */
export const ENS_CHAIN_ID = 11155111;

export const RECORD_KEYS = {
  description: "description",
  id: "petri.id",
  parent: "petri.parent",
  status: "petri.status",
  score: "petri.score",
  delta: "petri.delta",
  verifier1: "petri.verifier.1",
  verifier2: "petri.verifier.2",
  cost: "petri.cost",
} as const;

export type RecordKey = (typeof RECORD_KEYS)[keyof typeof RECORD_KEYS];

/** Every key, in write order. */
export const ALL_RECORD_KEYS: RecordKey[] = Object.values(RECORD_KEYS);

/** Keys whose value changes as checks arrive. The rest are fixed when the version is proposed. */
export const VERDICT_KEYS: RecordKey[] = [RECORD_KEYS.status, RECORD_KEYS.score, RECORD_KEYS.delta, RECORD_KEYS.verifier1, RECORD_KEYS.verifier2];

/**
 * Keys an earlier schema wrote. The publisher clears them, so a name holds the
 * 8 records above and nothing else. Safe to delete once every name is clean.
 */
export const LEGACY_KEYS = [
  "petri.verdict", "petri.reason", "petri.score-source", "petri.keys", "petri.min-keys", "petri.checks",
  "petri.tokens", "petri.falsified-if", "petri.area", "petri.motif", "petri.metric", "petri.mode",
  "petri.blocked", "petri.bench",
];

/** A version's record as read back from its resolver. */
export interface EnsVersion {
  id: string;
  parent: string;
  hypothesis: string;
  status: NodeStatus | "baseline";
  score: string;
  delta: string;
  verifiers: string[];
  cost: string;
}

/** One name's lookup, as the /api/ens/records route returns it. */
export interface EnsLookup {
  name: string;
  /** The resolver that answered. Null when no resolver is on the name's path. */
  resolver: string | null;
  /** Text records by key. Null when the key is unset. */
  texts: Record<string, string | null>;
  /** Set when the lookup failed (RPC down, bad name). `texts` is then empty. */
  error?: string;
}

export interface EnsRecordsResponse {
  chainId: number;
  results: EnsLookup[];
}

const STATUSES: NodeStatus[] = ["accepted", "rejected", "pending", "contested", "withdrawn", "superseded"];

/** "+7000bp", "−7000bp" or "" when not checked yet. */
export const deltaText = (bp: number | null): string => (bp === null ? "" : `${bp >= 0 ? "+" : "−"}${Math.abs(bp)}bp`);

/** "19/20": the tasks passed out of the benchmark. The root shows its re-run, other keys' measurement. */
export function scoreText(node: ExportNode, nodes: ExportNode[], benchTotal: number): string {
  if (isBlocked(node)) return "";
  const ids = new Set(nodes.map((n) => n.id));
  const bp = isRoot(node, ids) ? (rootRerunBp(node, nodes) ?? node.detail.claimedMedianBp) : node.detail.claimedMedianBp;
  return `${Math.round((bp / 10000) * benchTotal)}/${benchTotal}`;
}

/** A verifier key as a record value: "0x" + the signing key, or the wallet as it is. */
const keyText = (runner: string): string => (/^[0-9a-f]{64}$/.test(runner) ? `0x${runner}` : runner);

/** The text records a version stores, key → value. Every key is present; unset values are "". */
export function nodeRecords(
  node: ExportNode, nodes: ExportNode[], benchTotal: number, _minVerifications: number,
): Record<RecordKey, string> {
  const ids = new Set(nodes.map((n) => n.id));
  const root = isRoot(node, ids);
  const verifiers = node.verifications.filter((v) => v.counted).map((v) => keyText(v.runner));
  return {
    [RECORD_KEYS.description]: node.hypothesis,
    [RECORD_KEYS.id]: node.id,
    [RECORD_KEYS.parent]: root ? "" : node.parent,
    [RECORD_KEYS.status]: root ? "baseline" : node.status,
    [RECORD_KEYS.score]: scoreText(node, nodes, benchTotal),
    [RECORD_KEYS.delta]: root ? "" : deltaText(node.verifiedDeltaBp),
    [RECORD_KEYS.verifier1]: verifiers[0] ?? "",
    [RECORD_KEYS.verifier2]: verifiers[1] ?? "",
    [RECORD_KEYS.cost]: isBlocked(node) ? "" : `${node.costs.tokensPerTask} tokens/task`,
  };
}

/**
 * The standard `name` key. The ENSv2 explorer lists the keys its indexer saw,
 * plus 6 standard keys it always reads from the chain. While the indexer is
 * behind, only those 6 show, so this one carries a one-line summary.
 */
export const SUMMARY_KEY = "name";

/** `v2 · accepted · 19/20 · +7000bp · 1141 tokens/task · from v1`. `parent` is the parent's label. */
export function summaryLine(label: string, r: Record<string, string>, parent?: string): string {
  return [
    label,
    r[RECORD_KEYS.status],
    r[RECORD_KEYS.score],
    r[RECORD_KEYS.delta],
    r[RECORD_KEYS.cost],
    // The claim without its "what changed" part, which `description` already shows.
    r["petri.claim"] ? `claim ${r["petri.claim"].split(" · ").slice(0, 3).join(" · ")}` : "",
    parent ? `from ${parent}` : "",
  ].filter(Boolean).join(" · ");
}

/**
 * While the explorer's indexer is stopped, it shows only 6 standard keys. So
 * `description` carries every record of the name, after the text itself:
 *
 *   <the text>
 *
 *   — every record —
 *   petri.status: pending
 *   …
 *
 * `descriptionText` gives the text back. Set FULL_DESCRIPTION to false once
 * the indexer lists every key again.
 */
export const FULL_DESCRIPTION = true;
const RECORDS_MARK = "\n\n— every record —\n";

export function fullDescription(text: string, records: Record<string, string>): string {
  if (!FULL_DESCRIPTION) return text;
  const lines = Object.entries(records)
    .filter(([k, v]) => k !== RECORD_KEYS.description && k !== SUMMARY_KEY && v !== "" && !k.startsWith("petri.doc."))
    .map(([k, v]) => `${k}: ${v}`);
  return lines.length === 0 ? text : `${text}${RECORDS_MARK}${lines.join("\n")}`;
}

/** The text part of a description, without the records after it. */
export const descriptionText = (d: string): string => d.split(RECORDS_MARK)[0]!;

/** The records a name holds, with `name` (the summary) and the full `description`. */
export function withExplorerKeys(records: Record<string, string>, summary: string): Record<string, string> {
  return {
    ...records,
    [SUMMARY_KEY]: summary,
    [RECORD_KEYS.description]: fullDescription(records[RECORD_KEYS.description] ?? "", records),
  };
}

/** One version's name and the records it should hold. */
export interface PlannedName {
  id: string;
  short: string;
  name: string;
  records: Record<RecordKey, string>;
}

/** The records to publish for a whole tree. */
export interface TreePlan {
  suffix: string;
  tree: string;
  names: PlannedName[];
}

/** Every version of a tree with its ENS name and records, in proposal order. */
export function treePlan(data: PetriExport, slug: string): TreePlan {
  const names = ensNames(data.nodes, slug);
  return {
    suffix: ENS_SUFFIX,
    tree: data.tree,
    names: [...data.nodes].sort((a, b) => a.seq - b.seq).map((n) => ({
      id: n.id,
      short: n.short,
      name: names.get(n.id)!,
      records: nodeRecords(n, data.nodes, data.bench.total, data.policy.minVerifications),
    })),
  };
}

const text = (raw: string | null | undefined): string => (raw ?? "").trim();

/**
 * Reads a version's record from its text records. Returns null when the name
 * holds no Petri record (no `petri.id`), so the caller falls back to the log.
 */
export function readRecords(texts: Record<string, string | null | undefined>): EnsVersion | null {
  const id = text(texts[RECORD_KEYS.id]);
  if (!id) return null;
  const status = text(texts[RECORD_KEYS.status]);
  return {
    id,
    parent: text(texts[RECORD_KEYS.parent]),
    hypothesis: descriptionText(text(texts[RECORD_KEYS.description])),
    status: status === "baseline" ? "baseline" : (STATUSES as string[]).includes(status) ? (status as NodeStatus) : "pending",
    score: text(texts[RECORD_KEYS.score]),
    delta: text(texts[RECORD_KEYS.delta]),
    verifiers: [texts[RECORD_KEYS.verifier1], texts[RECORD_KEYS.verifier2]].map(text).filter((v) => v !== ""),
    cost: text(texts[RECORD_KEYS.cost]),
  };
}

/**
 * The keys whose value on ENS differs from `want`. An unset record equals "".
 * The publisher writes only these; the panel uses it to spot a stale record.
 */
export function changedKeys(
  want: Record<string, string>, have: Record<string, string | null | undefined>, keys: readonly string[] = Object.keys(want),
): string[] {
  return keys.filter((k) => (want[k] ?? "") !== (have[k] ?? ""));
}
