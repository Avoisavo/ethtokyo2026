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
const keyText = (runner: string): string => (runner.startsWith("0x") ? runner : `0x${runner}`);

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
export function treePlan(data: PetriExport, harness: string): TreePlan {
  const names = ensNames(data.nodes, harness);
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
    hypothesis: text(texts[RECORD_KEYS.description]),
    status: status === "baseline" ? "baseline" : (STATUSES as string[]).includes(status) ? (status as NodeStatus) : "pending",
    score: text(texts[RECORD_KEYS.score]),
    delta: text(texts[RECORD_KEYS.delta]),
    verifiers: [texts[RECORD_KEYS.verifier1], texts[RECORD_KEYS.verifier2]].map(text).filter((v) => v !== ""),
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
