import { isBlocked, isRoot, rootRerunBp } from "./format";
import type { ExportNode, RunRecord } from "./types";

/** One version on the Compare view: its score, what it costs and how long it takes. */
export interface ComparePoint {
  n: ExportNode;
  /** Score in basis points, 0 to 10000. Re-run by other keys where it was. */
  perfBp: number;
  /** Median tokens per task. Lower is cheaper. */
  tokens: number;
  /** Median wall time of one benchmark run, in ms. Lower is faster. */
  wallMs: number;
  /** Shares of Performance, Speed and Cost. The three add up to 1. */
  mix: { perf: number; speed: number; cost: number };
}

export interface CompareData {
  points: ComparePoint[];
  /** Versions with no score, tokens or time to plot: blocked, or never measured. */
  unplotted: ExportNode[];
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * A root is never verified directly, so its own costs are empty. The keys that
 * checked its children re-ran it as their "parent" side. Read the costs from there.
 */
function rootRerunRuns(root: ExportNode, nodes: ExportNode[]): RunRecord[] {
  for (const n of nodes) {
    if (n.parent !== root.id) continue;
    const v = n.verifications.find((x) => x.counted && x.parent.runs.length > 0);
    if (v) return v.parent.runs;
  }
  return [];
}

function measure(n: ExportNode, nodes: ExportNode[], ids: Set<string>, benchTotal: number): Omit<ComparePoint, "n" | "mix"> | null {
  if (isBlocked(n)) return null;
  const root = isRoot(n, ids);
  const perfBp = root
    ? rootRerunBp(n, nodes) ?? n.detail.claimedMedianBp
    : n.verifications.find((v) => v.counted)?.candidate.medianBp ?? n.detail.claimedMedianBp;
  let tokens = n.costs.tokensPerTask;
  let wallMs = n.costs.medianWallMs;
  if (root && (tokens <= 0 || wallMs <= 0)) {
    // A run record counts tokens for the whole benchmark, not per task.
    const runs = rootRerunRuns(n, nodes);
    const t = median(runs.map((r) => r.tokens));
    const w = median(runs.map((r) => r.wallMs));
    // Floored, as the engine computes tokensPerTask.
    if (tokens <= 0 && t !== null && benchTotal > 0) tokens = Math.floor(t / benchTotal);
    if (wallMs <= 0 && w !== null) wallMs = Math.round(w);
  }
  if (tokens <= 0 || wallMs <= 0) return null;
  return { perfBp, tokens, wallMs };
}

/**
 * Every measured version with its three numbers, and its mix for the triangle.
 *
 * The triangle needs three shares. Each is a strength from 0 to 1: Performance is
 * the score itself; Speed and Cost are measured against the fastest and cheapest
 * version in this tree (the best one scores 1, one that takes twice as long 0.5).
 * The three strengths are then scaled to add up to 1.
 */
export function compareData(nodes: ExportNode[], benchTotal: number): CompareData {
  const ids = new Set(nodes.map((n) => n.id));
  const measured: Omit<ComparePoint, "mix">[] = [];
  const unplotted: ExportNode[] = [];
  for (const n of nodes) {
    const m = measure(n, nodes, ids, benchTotal);
    if (m === null) unplotted.push(n);
    else measured.push({ n, ...m });
  }
  const fastest = Math.min(...measured.map((p) => p.wallMs));
  const cheapest = Math.min(...measured.map((p) => p.tokens));
  const points = measured.map((p) => {
    const perf = Math.max(0, Math.min(1, p.perfBp / 10000));
    const speed = fastest / p.wallMs;
    const cost = cheapest / p.tokens;
    const sum = perf + speed + cost;
    return { ...p, mix: { perf: perf / sum, speed: speed / sum, cost: cost / sum } };
  });
  return { points, unplotted };
}

export const fmtPerf = (bp: number): string => `${Math.round(bp / 100)}%`;
export const fmtTokens = (t: number): string => `${Math.round(t).toLocaleString("en-US")} tokens/task`;
export const fmtWall = (ms: number): string => (ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 1000).toFixed(2)} s`);
export const fmtShare = (s: number): string => `${Math.round(s * 100)}%`;
