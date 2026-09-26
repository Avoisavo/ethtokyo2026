import { claimBp, isBlocked, isRoot, objectiveOf, rootRerunBp } from "./format";
import type { ExportNode } from "./types";
import { measure } from "./compare";

/** The quantity a direction is judged on. */
export type Metric = "score" | "tokens" | "time";

export function metricOf(objective: string): Metric {
  if (objective === "token savings") return "tokens";
  if (objective === "speed") return "time";
  return "score";
}

/** The measured value of one metric for one version. A blocked version has none. */
export function valueOf(n: ExportNode, metric: Metric, nodes: ExportNode[], ids: Set<string>): number | null {
  if (isBlocked(n)) return metric === "score" ? claimBp(n, nodes) : null;
  if (metric === "tokens") return n.costs.tokensPerTask > 0 ? n.costs.tokensPerTask : null;
  if (metric === "time") return n.costs.medianWallMs > 0 ? n.costs.medianWallMs : null;
  if (isRoot(n, ids)) return rootRerunBp(n, nodes) ?? (n.detail.claimedMedianBp > 0 ? n.detail.claimedMedianBp : null);
  return n.verifications.find((v) => v.counted)?.candidate.medianBp ?? n.detail.claimedMedianBp;
}

/**
 * The gain from one value to another, positive when it got better.
 * Score going up is a gain. Tokens or time going DOWN is a gain (a saving, a speed-up).
 */
export function gain(from: number | null, to: number | null, metric: Metric): number | null {
  if (from === null || to === null || from === 0) return null;
  const change = ((to - from) / from) * 100;
  return metric === "score" ? change : -change;
}

export function fmtPct(p: number | null): string {
  if (p === null) return "—";
  const r = Math.round(p);
  return r === 0 ? "0%" : `${r > 0 ? "+" : "−"}${Math.abs(r)}%`;
}

export interface Changes {
  /** Gain on this version's own direction, against its parent. */
  local: number | null;
  /** Gains against the start of the tree: one shared scale for the whole graph. */
  accuracy: number | null;
  tokenSavings: number | null;
  isStart: boolean;
}

export function changesOf(n: ExportNode, nodes: ExportNode[]): Changes {
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const ids = new Set(byId.keys());
  const metric = metricOf(objectiveOf(n));
  const parent = byId.get(n.parent);
  let root: ExportNode = n;
  const seen = new Set<string>();
  while (!isRoot(root, ids) && !seen.has(root.id)) { seen.add(root.id); root = byId.get(root.parent)!; }
  const v = (x: ExportNode, m: Metric) => valueOf(x, m, nodes, ids);
  return {
    local: parent ? gain(v(parent, metric), v(n, metric), metric) : null,
    accuracy: gain(v(root, "score"), v(n, "score"), "score"),
    tokenSavings: gain(v(root, "tokens"), v(n, "tokens"), "tokens"),
    isStart: root.id === n.id,
  };
}

/** The three results of a change, against its parent. Positive is better on every one. */
export interface TradeOff {
  /** Benchmark score: up is better. */
  perf: number;
  /** Tokens per task: fewer is better, so a positive number is a saving. */
  tokens: number;
  /** Time of one benchmark run: shorter is better, so a positive number is a speed-up. */
  speed: number;
}

/**
 * What a change gained and what it cost, against its parent, from the same
 * measurements the Compare view uses (re-run by other keys where they were).
 * Null when either side was never measured, for example a blocked change.
 */
export function tradeOffOf(n: ExportNode, nodes: ExportNode[], benchTotal: number): TradeOff | null {
  const ids = new Set(nodes.map((x) => x.id));
  const parent = nodes.find((x) => x.id === n.parent);
  if (!parent) return null;
  const a = measure(parent, nodes, ids, benchTotal);
  const b = measure(n, nodes, ids, benchTotal);
  if (!a || !b) return null;
  const perf = gain(a.perfBp, b.perfBp, "score");
  const tokens = gain(a.tokens, b.tokens, "tokens");
  const speed = gain(a.wallMs, b.wallMs, "time");
  return perf === null || tokens === null || speed === null ? null : { perf, tokens, speed };
}

/** "perf +280% · tokens −32% · speed +4%": every number, + is better. */
export const fmtTradeOff = (t: TradeOff): string => `perf ${fmtPct(t.perf)} · tokens ${fmtPct(t.tokens)} · speed ${fmtPct(t.speed)}`;

/**
 * A MOCK trade-off for a change that was never measured, so the tree reads the
 * same everywhere. It is not data: performance is the author's claim on their
 * own direction, and the other two are placeholders from the version id, in
 * the range −15% to +15%. Every place that shows it marks it as an estimate.
 */
export function estimateTradeOff(n: ExportNode, nodes: ExportNode[]): TradeOff {
  const claim = changesOf(n, nodes).local ?? 0;
  const metric = metricOf(objectiveOf(n));
  const seed = (i: number) => (parseInt(n.id.slice(i * 4, i * 4 + 4), 16) % 31) - 15;
  return {
    perf: metric === "score" ? claim : seed(0),
    tokens: metric === "tokens" ? claim : seed(1),
    speed: metric === "time" ? claim : seed(2),
  };
}

/** A mocked value: "~+5%". */
export const fmtEst = (p: number): string => `~${fmtPct(p)}`;
