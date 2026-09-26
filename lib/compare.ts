import { isBlocked, isRoot, rootRerunBp } from "./format";
import type { ExportNode, RunRecord } from "./types";
import { estimateTradeOff } from "./metrics";

/** One version on the Compare view: its score, what it costs and how long it takes. */
export interface ComparePoint {
  n: ExportNode;
  /** Score in basis points, 0 to 10000. Re-run by other keys where it was. */
  perfBp: number;
  /** Median tokens per task. Lower is cheaper. */
  tokens: number;
  /** Median wall time of one benchmark run, in ms. Lower is faster. */
  wallMs: number;
  /** How strong it is on each measure within this tree, FLOOR (weakest) to 1 (best). */
  rating: { perf: number; speed: number; cost: number };
  /** The three ratings scaled to add up to 1: where it sits in the trade-off triangle. */
  mix: { perf: number; speed: number; cost: number };
  /** True for a version that never ran: placed at its parent, moved by the estimate. Not data. */
  est?: boolean;
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

export function measure(n: ExportNode, nodes: ExportNode[], ids: Set<string>, benchTotal: number): Omit<ComparePoint, "n" | "rating" | "mix"> | null {
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

/** The weakest version still shows a little, so its radar shape never collapses to a point. */
const FLOOR = 0.1;

/**
 * Each value as a rating across this tree: the best version scores 1, the worst
 * FLOOR, the rest in between by their value. Small differences are stretched too,
 * so versions look clearly different; the real numbers are always shown beside.
 */
function ratings(values: number[], higherIsBetter: boolean): number[] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const best = higherIsBetter ? hi : lo;
  return values.map((v) => FLOOR + (1 - FLOOR) * (hi === lo ? 1 : 1 - Math.abs(best - v) / (hi - lo)));
}

/** Every measured version with its three numbers, its rating on each within this tree, and its mix. */
export function compareData(nodes: ExportNode[], benchTotal: number): CompareData {
  const ids = new Set(nodes.map((n) => n.id));
  const measured: Omit<ComparePoint, "rating" | "mix">[] = [];
  const unplotted: ExportNode[] = [];
  const at = new Map<string, Omit<ComparePoint, "rating" | "mix">>();
  for (const n of nodes) {
    const m = measure(n, nodes, ids, benchTotal);
    if (m !== null) { const q = { n, ...m }; measured.push(q); at.set(n.id, q); }
  }
  // A version that never ran is placed at its parent, moved by the estimated change,
  // so a path through it can be drawn. It is marked `est` and drawn faded.
  for (const n of [...nodes].sort((a, b) => a.seq - b.seq)) {
    if (at.has(n.id)) continue;
    const parent = at.get(n.parent);
    if (!parent) { unplotted.push(n); continue; }
    const e = estimateTradeOff(n, nodes);
    const q = {
      n, est: true,
      perfBp: Math.min(10000, Math.max(0, parent.perfBp * (1 + e.perf / 100))),
      tokens: Math.max(1, parent.tokens * (1 - e.tokens / 100)),
      wallMs: Math.max(1, parent.wallMs * (1 - e.speed / 100)),
    };
    measured.push(q);
    at.set(n.id, q);
  }
  const perf = ratings(measured.map((p) => p.perfBp), true);
  const speed = ratings(measured.map((p) => p.wallMs), false);
  const cost = ratings(measured.map((p) => p.tokens), false);
  const points = measured.map((p, i) => {
    const sum = perf[i]! + speed[i]! + cost[i]!;
    return {
      ...p,
      rating: { perf: perf[i]!, speed: speed[i]!, cost: cost[i]! },
      mix: { perf: perf[i]! / sum, speed: speed[i]! / sum, cost: cost[i]! / sum },
    };
  });
  return { points, unplotted };
}

/** A line from a version to its parent. `direct` is false when unmeasured versions sit between. */
export interface Link { parent: string; child: string; direct: boolean }

/** The tree's parent links among plotted versions. An unplotted parent is skipped to its nearest plotted ancestor. */
export function treeLinks(nodes: ExportNode[], points: ComparePoint[]): Link[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const shown = new Set(points.map((p) => p.n.id));
  const links: Link[] = [];
  for (const p of points) {
    let cur = byId.get(p.n.parent);
    let direct = true;
    const seen = new Set<string>();
    while (cur !== undefined && !shown.has(cur.id) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parent);
      direct = false;
    }
    if (cur !== undefined && shown.has(cur.id)) links.push({ parent: cur.id, child: p.n.id, direct });
  }
  return links;
}

/** The versions from the start of the tree down to `id`, following plotted parents. */
export function lineageOf(id: string, links: Link[], nodes: ExportNode[], points: ComparePoint[]): Set<string> {
  const shown = new Set(points.map((p) => p.n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // An unplotted version is traced from its nearest plotted ancestor.
  let cur: string | undefined = id;
  const guard = new Set<string>();
  while (cur !== undefined && !shown.has(cur) && !guard.has(cur)) { guard.add(cur); cur = byId.get(cur)?.parent; }
  const up = new Map(links.map((l) => [l.child, l.parent]));
  const path = new Set<string>();
  while (cur !== undefined && !path.has(cur)) { path.add(cur); cur = up.get(cur); }
  return path;
}

export const fmtPerf = (bp: number): string => `${Math.round(bp / 100)}%`;
export const fmtTokens = (t: number): string => `${Math.round(t).toLocaleString("en-US")} tokens/task`;
export const fmtWall = (ms: number): string => (ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 1000).toFixed(2)} s`);
/** A rating as the 0 to 100 number shown on the radar. */
export const fmtRating = (r: number): string => `${Math.round(r * 100)}`;
