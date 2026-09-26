import { ENS_SUFFIX, ensNames } from "./ens-name";
import { claimBp, counted, isBlocked, isRoot, rootRerunBp } from "./format";
import type { ExportNode, NodeStatus, PetriExport } from "./types";

/**
 * The record a version keeps on its ENS name.
 *
 * Every version has a name (see ens-name.ts), and the resolver that serves
 * that name holds the version's record as text records: the hypothesis, the
 * verdict, the score, the checks by other keys. The node panel shows what the
 * resolver returns, so anyone can read the same record from any ENS client.
 *
 * ENSv2 lives on Sepolia. One PermissionedResolver on the suffix name
 * (petri.eth) serves every version below it: it stores records per full-name
 * namehash and answers wildcard `resolve()` calls, so no subname registry is
 * needed. `npm run ens:publish` writes the records.
 *
 * Shared by the server (reads), the publisher (writes) and the browser. Pure.
 */

/** Sepolia, where the ENSv2 contracts are deployed. */
export const ENS_CHAIN_ID = 11155111;

/** Every text record key a version stores, in the order they are written. */
export const RECORD_KEYS = {
  /** The hypothesis. `description` is the standard key, so any ENS app shows it. */
  description: "description",
  /** The full version id (SHA-256 of its manifest). Ties the name to one version. */
  id: "petri.id",
  /** The parent version id. Empty for a root. */
  parent: "petri.parent",
  status: "petri.status",
  /** The engine's status code, e.g. WIN or REGRESSION. */
  verdict: "petri.verdict",
  reason: "petri.reason",
  /** The score the panel shows, in basis points. */
  score: "petri.score",
  /** Where that score comes from: see ScoreSource. */
  scoreSource: "petri.score-source",
  /** The checked change in basis points, measured by other keys. Empty until checked. */
  delta: "petri.delta",
  /** Counted keys. */
  keys: "petri.keys",
  /** Keys needed to accept, from the tree's policy. */
  minKeys: "petri.min-keys",
  /** Checks by other keys, as JSON: EnsCheck[]. */
  checks: "petri.checks",
  /** Median tokens per task. */
  tokens: "petri.tokens",
  falsifiedIf: "petri.falsified-if",
  area: "petri.area",
  motif: "petri.motif",
  /** What the version aims at: "score" (accuracy) or "tokens". */
  metric: "petri.metric",
  mode: "petri.mode",
  /** The guard or typecheck class that stopped the change. Empty when it ran. */
  blocked: "petri.blocked",
  /** Tasks in the benchmark, so the score reads "19 of 20 tasks". */
  bench: "petri.bench",
} as const;

export type RecordKey = (typeof RECORD_KEYS)[keyof typeof RECORD_KEYS];

/** Every key, in write order. */
export const ALL_RECORD_KEYS: RecordKey[] = Object.values(RECORD_KEYS);

/**
 * Keys whose value changes as checks arrive. The rest are fixed when the
 * version is proposed.
 */
export const VERDICT_KEYS: RecordKey[] = [
  RECORD_KEYS.status, RECORD_KEYS.verdict, RECORD_KEYS.reason, RECORD_KEYS.score,
  RECORD_KEYS.scoreSource, RECORD_KEYS.delta, RECORD_KEYS.keys, RECORD_KEYS.checks,
];

/**
 * - `author`: the author's own median, a claim.
 * - `rerun`: a root, re-run by the keys that checked its child.
 * - `predicted`: a change that never ran: its parent's score plus the predicted delta.
 */
export type ScoreSource = "author" | "rerun" | "predicted";

/** One check by another key, as stored in `petri.checks`. */
export interface EnsCheck {
  /** The runner's label, or the first 8 hex of its key. */
  key: string;
  counted: boolean;
  deltaBp: number;
  parentBp: number;
  candidateBp: number;
  runs: number;
  /** Why the check was ignored. Empty when counted. */
  why: string;
}

/** A version's record as read back from its resolver. */
export interface EnsVersion {
  id: string;
  parent: string;
  hypothesis: string;
  status: NodeStatus;
  verdict: string;
  reason: string;
  scoreBp: number | null;
  scoreSource: ScoreSource;
  deltaBp: number | null;
  keys: number;
  minKeys: number | null;
  checks: EnsCheck[];
  tokensPerTask: number | null;
  falsifiedIf: string;
  area: string;
  motif: string;
  metric: string;
  mode: string;
  blocked: string;
  bench: number | null;
}

/** One name's lookup, as the /api/ens-records route returns it. */
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
const SOURCES: ScoreSource[] = ["author", "rerun", "predicted"];

/** The score the panel shows for a version, and where it comes from. */
export function displayScore(node: ExportNode, nodes: ExportNode[]): { bp: number; source: ScoreSource } {
  if (isBlocked(node)) return { bp: claimBp(node, nodes), source: "predicted" };
  const root = isRoot(node, new Set(nodes.map((n) => n.id)));
  const rerun = root ? rootRerunBp(node, nodes) : null;
  return rerun !== null ? { bp: rerun, source: "rerun" } : { bp: node.detail.claimedMedianBp, source: "author" };
}

/** The text records a version stores, key → value. Every key is present; unset values are "". */
export function nodeRecords(
  node: ExportNode, nodes: ExportNode[], benchTotal: number, minVerifications: number,
): Record<RecordKey, string> {
  const p = node.detail.proposal;
  const ids = new Set(nodes.map((n) => n.id));
  const score = displayScore(node, nodes);
  const checks: EnsCheck[] = node.verifications.map((v) => ({
    key: v.runnerLabel || v.runner.slice(0, 8),
    counted: v.counted,
    deltaBp: v.deltaMedianBp,
    parentBp: v.parent.medianBp,
    candidateBp: v.candidate.medianBp,
    runs: v.runs,
    why: v.counted ? "" : v.ignoredWhy,
  }));
  return {
    [RECORD_KEYS.description]: node.hypothesis,
    [RECORD_KEYS.id]: node.id,
    [RECORD_KEYS.parent]: isRoot(node, ids) ? "" : node.parent,
    [RECORD_KEYS.status]: node.status,
    [RECORD_KEYS.verdict]: node.statusCode,
    [RECORD_KEYS.reason]: node.statusReason,
    [RECORD_KEYS.score]: String(score.bp),
    [RECORD_KEYS.scoreSource]: score.source,
    [RECORD_KEYS.delta]: node.verifiedDeltaBp === null ? "" : String(node.verifiedDeltaBp),
    [RECORD_KEYS.keys]: String(counted(node)),
    [RECORD_KEYS.minKeys]: String(minVerifications),
    [RECORD_KEYS.checks]: checks.length === 0 ? "" : JSON.stringify(checks),
    [RECORD_KEYS.tokens]: String(node.costs.tokensPerTask),
    [RECORD_KEYS.falsifiedIf]: p.falsifiedIf ?? "",
    [RECORD_KEYS.area]: p.primaryArea ?? "",
    [RECORD_KEYS.motif]: p.motif ?? "",
    [RECORD_KEYS.metric]: p.metric ?? "",
    [RECORD_KEYS.mode]: node.mode,
    [RECORD_KEYS.blocked]: isBlocked(node) ? node.detail.mechanical!.cls : "",
    [RECORD_KEYS.bench]: String(benchTotal),
  } as Record<RecordKey, string>;
}

/** One version's name and the records it should hold. */
export interface PlannedName {
  id: string;
  short: string;
  name: string;
  records: Record<RecordKey, string>;
}

/** The records to publish for a whole tree. The resolver on the suffix serves every name. */
export interface TreePlan {
  suffix: string;
  tree: string;
  names: PlannedName[];
}

/**
 * Every version of a tree with its ENS name and records, in proposal order.
 * `harness` must be the same key the tree page passes to ensNames, so the
 * published names are the names the page shows.
 */
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

const int = (raw: string | null | undefined): number | null => {
  const s = (raw ?? "").trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
};

const text = (raw: string | null | undefined): string => (raw ?? "").trim();

/** Parses `petri.checks`. Anything malformed is dropped, never guessed. */
export function parseChecks(raw: string | null | undefined): EnsCheck[] {
  const s = text(raw);
  if (!s) return [];
  let data: unknown;
  try {
    data = JSON.parse(s);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: EnsCheck[] = [];
  for (const c of data) {
    if (typeof c !== "object" || c === null) continue;
    const o = c as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const deltaBp = num(o.deltaBp), parentBp = num(o.parentBp), candidateBp = num(o.candidateBp), runs = num(o.runs);
    if (typeof o.key !== "string" || typeof o.counted !== "boolean" || deltaBp === null || parentBp === null || candidateBp === null || runs === null) continue;
    out.push({ key: o.key, counted: o.counted, deltaBp, parentBp, candidateBp, runs, why: typeof o.why === "string" ? o.why : "" });
  }
  return out;
}

/**
 * Reads a version's record from its text records. Returns null when the name
 * holds no Petri record (no `petri.id`), so the caller falls back to the log.
 */
export function readRecords(texts: Record<string, string | null | undefined>): EnsVersion | null {
  const id = text(texts[RECORD_KEYS.id]);
  if (!id) return null;
  const status = text(texts[RECORD_KEYS.status]) as NodeStatus;
  const source = text(texts[RECORD_KEYS.scoreSource]) as ScoreSource;
  return {
    id,
    parent: text(texts[RECORD_KEYS.parent]),
    hypothesis: text(texts[RECORD_KEYS.description]),
    status: STATUSES.includes(status) ? status : "pending",
    verdict: text(texts[RECORD_KEYS.verdict]),
    reason: text(texts[RECORD_KEYS.reason]),
    scoreBp: int(texts[RECORD_KEYS.score]),
    scoreSource: SOURCES.includes(source) ? source : "author",
    deltaBp: int(texts[RECORD_KEYS.delta]),
    keys: int(texts[RECORD_KEYS.keys]) ?? 0,
    minKeys: int(texts[RECORD_KEYS.minKeys]),
    checks: parseChecks(texts[RECORD_KEYS.checks]),
    tokensPerTask: int(texts[RECORD_KEYS.tokens]),
    falsifiedIf: text(texts[RECORD_KEYS.falsifiedIf]),
    area: text(texts[RECORD_KEYS.area]),
    motif: text(texts[RECORD_KEYS.motif]),
    metric: text(texts[RECORD_KEYS.metric]),
    mode: text(texts[RECORD_KEYS.mode]),
    blocked: text(texts[RECORD_KEYS.blocked]),
    bench: int(texts[RECORD_KEYS.bench]),
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
