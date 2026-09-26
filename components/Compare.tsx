"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { compareData, fmtPerf, fmtRating, fmtTokens, fmtWall, lineageOf, treeLinks, type ComparePoint, type Link } from "@/lib/compare";
import { STATUS_WORD, blockedText, clip, isBlocked } from "@/lib/format";
import type { ExportNode } from "@/lib/types";
import { Glyph } from "./Glyph";

interface Props {
  nodes: ExportNode[];
  selected: string;
  onSelect: (id: string) => void;
  benchTotal: number;
}

type Pt = [number, number];
type Vec = [number, number, number];
/** The version under the pointer in the 3D plot. */
type Hover = string | null;
type Axis = "x" | "y" | "z";

const PI = Math.PI;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const wrap = (a: number) => a - 2 * PI * Math.round(a / (2 * PI));
/** In a stack of dots, the accepted one is drawn last so it stays visible. */
const RANK: Record<string, number> = { accepted: 3, contested: 2, rejected: 1 };
const rankOf = (p: ComparePoint) => RANK[p.n.status] ?? 0;

/* ---- the radar: Performance on top, Cost bottom right, Speed bottom left ---- */

const RW = 460;
const RH = 374;
const RC: Pt = [RW / 2, 228];
const RR = 138;
type Measure = "perf" | "speed" | "cost";
/** Each spoke wears the colour of the same measure's axis in the 3D plot. */
const SPOKES: { key: Measure; title: string; axis: Axis; angle: number }[] = [
  { key: "perf", title: "Performance", axis: "x", angle: -PI / 2 },
  { key: "cost", title: "Cost", axis: "y", angle: PI / 6 },
  { key: "speed", title: "Speed", axis: "z", angle: (5 * PI) / 6 },
];
const spokeAt = (angle: number, r: number): Pt => [RC[0] + Math.cos(angle) * RR * r, RC[1] + Math.sin(angle) * RR * r];
const shapeOf = (rating: Record<Measure, number>) => SPOKES.map((sp) => spokeAt(sp.angle, rating[sp.key]).join(",")).join(" ");

/* ---- the trade-off triangle: Performance on top, Speed bottom left, Cost bottom right ---- */

const TW = 440;
const TH = 380;
const SIDE = 300;
const TOP: Pt = [TW / 2, 62];
const LEFT: Pt = [TW / 2 - SIDE / 2, 62 + (SIDE * Math.sqrt(3)) / 2];
const RIGHT: Pt = [TW / 2 + SIDE / 2, LEFT[1]];
const TR = 7;
const TGAP = 6;

/** Each corner pulls the point by its share. The shares add up to 1. */
const tri = (perf: number, speed: number, cost: number): Pt => [
  perf * TOP[0] + speed * LEFT[0] + cost * RIGHT[0],
  perf * TOP[1] + speed * LEFT[1] + cost * RIGHT[1],
];

/* ---- the 3D axes: x Performance, y Cost, z Speed. Every arrow points to better. ---- */

const PW = 560;
const PH = 470;
const PCX = 280;
const PCY = 242;
const SCALE = 96;
const CAM = 7;
const PR = 6;
const PGAP = 4;

interface View { yaw: number; pitch: number }
const HOME: View = { yaw: -0.62, pitch: 0.38 };
/** Views straight down one axis. That axis points at the viewer, so it is dimmed. */
const PRESETS: { label: string; title: string; view: View; away: Axis }[] = [
  { label: "x·y", title: "Performance against cost", view: { yaw: 0, pitch: 0 }, away: "z" },
  { label: "x·z", title: "Performance against speed", view: { yaw: 0, pitch: PI / 2 }, away: "y" },
  { label: "z·y", title: "Speed against cost", view: { yaw: PI / 2, pitch: 0 }, away: "x" },
];

interface Proj { x: number; y: number; depth: number; f: number }

function project([x, y, z]: Vec, v: View): Proj {
  const cy = Math.cos(v.yaw);
  const sy = Math.sin(v.yaw);
  const cp = Math.cos(v.pitch);
  const sp = Math.sin(v.pitch);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const y2 = y * cp - z1 * sp;
  const z2 = y * sp + z1 * cp;
  const f = CAM / (CAM - z2);
  return { x: PCX + x1 * SCALE * f, y: PCY - y2 * SCALE * f, depth: z2, f };
}

const niceStep = (range: number, count: number): number => {
  const raw = range / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const r = raw / mag;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
};

/** A range fitted to the values, with a little room at each end, and round ticks inside it. */
function fitDomain(values: number[], max = Infinity): { lo: number; hi: number; ticks: number[] } {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) {
    const half = Math.max(Math.abs(hi) * 0.05, 1);
    lo -= half;
    hi += half;
  }
  const pad = (hi - lo) * 0.08;
  lo = Math.max(0, lo - pad);
  hi = Math.min(max, hi + pad);
  const step = niceStep(hi - lo, 4);
  const ticks: number[] = [];
  for (let i = Math.ceil(lo / step); i * step <= hi + 1e-9; i++) ticks.push(Math.round(i * step * 1e6) / 1e6);
  return { lo, hi, ticks };
}

const REDUCED = "(prefers-reduced-motion: reduce)";
const subscribeReduced = (cb: () => void) => {
  const m = window.matchMedia(REDUCED);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const getReduced = () => window.matchMedia(REDUCED).matches;

/** Points drawn within a few units of each other, so a tooltip can name them all. */
function neighbours(at: Map<string, Pt>, id: string, within: number): string[] {
  const p = at.get(id);
  if (!p) return [];
  const out: string[] = [];
  for (const [other, q] of at) if (other !== id && Math.hypot(p[0] - q[0], p[1] - q[1]) <= within) out.push(other);
  return out;
}

interface Spot { id: string; at: Pt; r: number }
/** Where a dot is drawn, and the way it was fanned out, if it was. */
interface Placed { at: Pt; dir: Pt | null }

/**
 * Pull dots apart so none hides another. Dots within `same` of each other share a
 * spot: they spread on a small ring around it, in the order given. Then any dots still
 * touching push each other apart until `gap` separates them, each only as far as needed.
 */
function separate(spots: Spot[], gap: number, same = 0): Map<string, Placed> {
  const pos: Pt[] = spots.map((s) => [...s.at]);
  const dir: (Pt | null)[] = spots.map(() => null);
  const apart = (i: number, j: number) => spots[i]!.r + spots[j]!.r + gap;

  // Each group is measured from its first dot, so close neighbours never chain into one ring.
  const groups: number[][] = [];
  spots.forEach((s, i) => {
    const g = same > 0 ? groups.find((x) => Math.hypot(spots[x[0]!]!.at[0] - s.at[0], spots[x[0]!]!.at[1] - s.at[1]) <= same) : undefined;
    if (g) g.push(i);
    else groups.push([i]);
  });
  for (const ids of groups) {
    if (ids.length < 2) continue;
    const cx = ids.reduce((t, i) => t + spots[i]!.at[0], 0) / ids.length;
    const cy = ids.reduce((t, i) => t + spots[i]!.at[1], 0) / ids.length;
    const step = Math.max(...ids.map((i) => spots[i]!.r)) * 2 + gap;
    const ring = step / (2 * Math.sin(PI / ids.length));
    ids.forEach((i, k) => {
      const a = -PI / 2 + (2 * PI * k) / ids.length;
      dir[i] = [Math.cos(a), Math.sin(a)];
      pos[i] = [cx + ring * Math.cos(a), cy + ring * Math.sin(a)];
    });
  }

  for (let round = 0; round < 60; round++) {
    let moved = false;
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        const dx = pos[j]![0] - pos[i]![0];
        const dy = pos[j]![1] - pos[i]![1];
        const d = Math.hypot(dx, dy);
        const need = apart(i, j);
        if (d >= need) continue;
        // Exactly on top of each other: a fixed direction, so every frame agrees.
        const a = i * 2.39996 + j * 0.7;
        const [ux, uy] = d < 1e-6 ? [Math.cos(a), Math.sin(a)] : [dx / d, dy / d];
        const push = (need - d) / 2 + 0.01;
        pos[i] = [pos[i]![0] - ux * push, pos[i]![1] - uy * push];
        pos[j] = [pos[j]![0] + ux * push, pos[j]![1] + uy * push];
        moved = true;
      }
    }
    if (!moved) break;
  }
  return new Map(spots.map((s, i) => [s.id, { at: pos[i]!, dir: dir[i] ?? null }]));
}

interface LabelWant { id: string; at: Pt; r: number; text: string; dir?: Pt | null; size: number; must: boolean }
interface Rect { x: number; y: number; w: number; h: number }

/**
 * Put each label beside its dot where it covers no other dot or label. A fanned dot
 * tries the side it was fanned to first. A label with no free side is left out; its
 * dot still names itself on hover. `must` labels (the selected one) always show.
 */
function placeLabels(wants: LabelWant[], dots: Spot[], w: number, h: number): Map<string, { x: number; y: number }> {
  const taken: Rect[] = [];
  const out = new Map<string, { x: number; y: number }>();
  const hits = (a: Rect, b: Rect) => a.x < b.x + b.w + 2 && b.x < a.x + a.w + 2 && a.y < b.y + b.h + 1 && b.y < a.y + a.h + 1;
  const covers = (a: Rect, c: Spot) => {
    const nx = clamp(c.at[0], a.x, a.x + a.w);
    const ny = clamp(c.at[1], a.y, a.y + a.h);
    return Math.hypot(c.at[0] - nx, c.at[1] - ny) < c.r + 1.5;
  };
  for (const l of [...wants].sort((a, b) => Number(b.must) - Number(a.must))) {
    const tw = l.text.length * l.size * 0.6;
    const th = l.size;
    const [x, y] = l.at;
    const pad = l.r + 3;
    const d = pad * 0.72;
    const sides: { rect: Rect; toward: Pt }[] = [
      { rect: { x: x + pad, y: y - th / 2, w: tw, h: th }, toward: [1, 0] },
      { rect: { x: x - pad - tw, y: y - th / 2, w: tw, h: th }, toward: [-1, 0] },
      { rect: { x: x - tw / 2, y: y - pad - th, w: tw, h: th }, toward: [0, -1] },
      { rect: { x: x - tw / 2, y: y + pad, w: tw, h: th }, toward: [0, 1] },
      { rect: { x: x + d, y: y - d - th, w: tw, h: th }, toward: [0.7, -0.7] },
      { rect: { x: x + d, y: y + d, w: tw, h: th }, toward: [0.7, 0.7] },
      { rect: { x: x - d - tw, y: y - d - th, w: tw, h: th }, toward: [-0.7, -0.7] },
      { rect: { x: x - d - tw, y: y + d, w: tw, h: th }, toward: [-0.7, 0.7] },
    ];
    if (l.dir) {
      const [ux, uy] = l.dir;
      sides.sort((a, b) => (b.toward[0] * ux + b.toward[1] * uy) - (a.toward[0] * ux + a.toward[1] * uy));
    }
    const free = sides.find(({ rect }) =>
      rect.x >= 2 && rect.y >= 2 && rect.x + rect.w <= w - 2 && rect.y + rect.h <= h - 2
      && !taken.some((t) => hits(rect, t))
      && !dots.some((c) => c.id !== l.id && covers(rect, c)));
    const pick = free ?? (l.must ? sides[0] : undefined);
    if (!pick) continue;
    taken.push(pick.rect);
    out.set(l.id, { x: pick.rect.x, y: pick.rect.y + th * 0.8 });
  }
  return out;
}

function Tip({ p, x, y, w, h, also, byId }: { p: ComparePoint; x: number; y: number; w: number; h: number; also: string[]; byId: Map<string, ComparePoint> }) {
  return (
    <div className={`cmp-tip${y < h * 0.3 ? " below" : ""}`} role="presentation"
      style={{ left: `${(x / w) * 100}%`, top: `${(y / h) * 100}%` }}>
      <span className="cmp-tip-word">{STATUS_WORD[p.n.status]} · {p.n.short}</span>
      <span className="cmp-tip-hyp">{clip(p.n.hypothesis, 72)}</span>
      <span className="cmp-tip-nums">{fmtPerf(p.perfBp)} · {fmtTokens(p.tokens)} · {fmtWall(p.wallMs)}</span>
      <span className="cmp-tip-mix">Rating in this tree: {fmtRating(p.rating.perf)} performance · {fmtRating(p.rating.speed)} speed · {fmtRating(p.rating.cost)} cost</span>
      {also.length > 0 && (
        <span className="cmp-tip-also">Shares its spot with {also.slice(0, 5).map((id) => byId.get(id)?.n.short ?? id).join(", ")}{also.length > 5 ? ` +${also.length - 5}` : ""}</span>
      )}
    </div>
  );
}

export function Compare({ nodes, selected, onSelect, benchTotal }: Props) {
  const { points, unplotted } = useMemo(() => compareData(nodes, benchTotal), [nodes, benchTotal]);
  const links = useMemo(() => treeLinks(nodes, points), [nodes, points]);
  const lineage = useMemo(() => lineageOf(selected, links, nodes, points), [selected, links, nodes, points]);
  const byId = useMemo(() => new Map(points.map((p) => [p.n.id, p])), [points]);
  const [hover, setHover] = useState<Hover>(null);

  if (points.length === 0) {
    return (
      <section className="compare" aria-labelledby="compare-title">
        <div className="stats-head"><h2 id="compare-title">Compare</h2></div>
        <p className="empty">No version has a score, a token count and a time yet, so there is nothing to compare.</p>
      </section>
    );
  }

  const best = points.reduce((a, b) => (b.perfBp > a.perfBp || (b.perfBp === a.perfBp && b.tokens < a.tokens) ? b : a));
  const cheapest = points.reduce((a, b) => (b.tokens < a.tokens || (b.tokens === a.tokens && b.perfBp > a.perfBp) ? b : a));
  const fastest = points.reduce((a, b) => (b.wallMs < a.wallMs || (b.wallMs === a.wallMs && b.perfBp > a.perfBp) ? b : a));
  const fact = (label: string, p: ComparePoint, value: string) => (
    <button type="button" className="cmp-fact" aria-pressed={p.n.id === selected} onClick={() => onSelect(p.n.id)}>
      <span className="cmp-fact-label">{label}</span>
      <span className="cmp-fact-value">{value}</span>
      <span className="cmp-fact-who">
        <svg width="12" height="12" aria-hidden="true"><Glyph status={p.n.status} cx={6} cy={6} r={4.2} /></svg>
        {STATUS_WORD[p.n.status]} · {p.n.short}
      </span>
    </button>
  );

  const shared = { points, byId, selected, onSelect, hover, setHover };

  return (
    <section className="compare" aria-labelledby="compare-title">
      <div className="stats-head">
        <h2 id="compare-title">Compare</h2>
        <p className="muted">Performance, cost and speed for every measured version. Select a version to open its record.</p>
      </div>

      <div className="cmp-facts">
        {fact("Best performance", best, fmtPerf(best.perfBp))}
        {fact("Cheapest", cheapest, fmtTokens(cheapest.tokens))}
        {fact("Fastest", fastest, fmtWall(fastest.wallMs))}
      </div>

      <figure className="cmp-figure">
        <div className="plate compare-plate">
          <Radar byId={byId} nodes={nodes} selected={selected} onSelect={onSelect} />
          <Axes3D {...shared} links={links} lineage={lineage} />
        </div>
        <div className="legend">
          <span><svg width="14" height="14" aria-hidden="true"><Glyph status="accepted" cx={7} cy={7} r={5} /></svg>Accepted</span>
          <span><svg width="14" height="14" aria-hidden="true"><Glyph status="rejected" cx={7} cy={7} r={5} /></svg>Rejected, kept in the tree</span>
          {points.some((p) => p.n.status !== "accepted" && p.n.status !== "rejected") && (
            <span><svg width="14" height="14" aria-hidden="true"><Glyph status="pending" cx={7} cy={7} r={5} /></svg>Pending</span>
          )}
          <span><svg width="18" height="18" aria-hidden="true"><circle className="cmp-ring" cx={9} cy={9} r={7.5} /></svg>Selected</span>
          {links.length > 0 && (
            <>
              <span><svg width="26" height="12" aria-hidden="true"><path className="cmp-link" d="M2 6 H18" /><path className="cmp-link-head" d="M24 6 L17 2.5 L17 9.5 Z" /></svg>Parent to child, as in the tree</span>
              <span><svg width="26" height="12" aria-hidden="true"><path className="cmp-link on-path" d="M2 6 H18" /><path className="cmp-link-head on-path" d="M24 6 L17 2.5 L17 9.5 Z" /></svg>Path to the selected version</span>
            </>
          )}
        </div>
        <figcaption>
          Performance is the benchmark score, re-run by other keys where it was. Cost is the median tokens per task. Speed is the median time of one benchmark run.
          Both charts stretch each measure across this tree, from the weakest version to the best, so even small differences show.
          On the radar, the tip of each spoke is the best version in this tree (100) and the weakest sits near the centre (10); the real value is printed under each rating.
          The 3D axes, the tooltips and the table show real values. In the 3D plot, arrows join each version to its parent.
          The trade-off triangle is on the Tree tab, beside the tree.
          {unplotted.length > 0 && ` ${unplotted.length} ${unplotted.length === 1 ? "version was" : "versions were"} never measured and ${unplotted.length === 1 ? "is" : "are"} not plotted.`}
        </figcaption>
        <details className="table-view">
          <summary>Show as a table</summary>
          <table className="cmp-table">
            <thead>
              <tr><th scope="col">Version</th><th scope="col">Status</th><th scope="col">Performance</th><th scope="col">Cost</th><th scope="col">Speed</th><th scope="col">Rating · perf / speed / cost</th></tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.n.id} className={p.n.id === selected ? "is-selected" : undefined}>
                  <td><button type="button" className="cmp-row-btn" aria-pressed={p.n.id === selected} onClick={() => onSelect(p.n.id)}><code>{p.n.short}</code></button></td>
                  <td>{STATUS_WORD[p.n.status]}</td>
                  <td>{fmtPerf(p.perfBp)}</td>
                  <td>{fmtTokens(p.tokens)}</td>
                  <td>{fmtWall(p.wallMs)}</td>
                  <td>{fmtRating(p.rating.perf)} / {fmtRating(p.rating.speed)} / {fmtRating(p.rating.cost)}</td>
                </tr>
              ))}
              {unplotted.map((n) => (
                <tr key={n.id} className={n.id === selected ? "is-selected" : undefined}>
                  <td><button type="button" className="cmp-row-btn" aria-pressed={n.id === selected} onClick={() => onSelect(n.id)}><code>{n.short}</code></button></td>
                  <td>{STATUS_WORD[n.status]}</td>
                  <td colSpan={4} className="muted">not measured</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </figure>
    </section>
  );
}

interface ChartProps {
  points: ComparePoint[];
  byId: Map<string, ComparePoint>;
  selected: string;
  onSelect: (id: string) => void;
  hover: Hover;
  setHover: (h: Hover) => void;
}

/** The point `r` from `from` toward `to`: trims a link to the edge of its dot. */
const toward = (from: Pt, to: Pt, r: number): Pt => {
  const d = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
  return [from[0] + ((to[0] - from[0]) / d) * r, from[1] + ((to[1] - from[1]) / d) * r];
};
const DEAD = new Set(["rejected", "withdrawn", "superseded"]);

interface TreeProps { links: Link[]; lineage: Set<string> }

/**
 * The tree drawn over a chart: a gentle curve from each version to its child, dashed
 * when the child was rejected. The path to the selected version is drawn last, on top.
 */
function TreeLinks({ links, lineage, byId, spot }: TreeProps & { byId: Map<string, ComparePoint>; spot: (id: string) => { at: Pt; r: number } | undefined }) {
  const onPath = (l: Link) => lineage.has(l.child) && lineage.has(l.parent);
  return (
    <g aria-hidden="true">
      {[...links].sort((a, b) => Number(onPath(a)) - Number(onPath(b))).map((l) => {
        const from = spot(l.parent);
        const to = spot(l.child);
        if (!from || !to) return null;
        const [a, b] = [from.at, to.at];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        if (Math.hypot(dx, dy) < from.r + to.r + 6) return null;
        // Bend each curve to its right, so a link and its way back never overlap.
        const c: Pt = [(a[0] + b[0]) / 2 - dy * 0.16, (a[1] + b[1]) / 2 + dx * 0.16];
        const start = toward(a, c, from.r + 2);
        const end = toward(b, c, to.r + 3);
        const len = Math.hypot(b[0] - c[0], b[1] - c[1]) || 1;
        const ux = (b[0] - c[0]) / len;
        const uy = (b[1] - c[1]) / len;
        const path = onPath(l);
        const cls = `cmp-link${path ? " on-path" : ""}${DEAD.has(byId.get(l.child)!.n.status) ? " dead" : ""}${l.direct ? "" : " skip"}`;
        return (
          <g key={`l-${l.child}`}>
            <path className={cls} d={`M${start[0]} ${start[1]} Q${c[0]} ${c[1]} ${end[0]} ${end[1]}`} />
            <path className={`cmp-link-head${path ? " on-path" : ""}`}
              d={`M${end[0]} ${end[1]} L${end[0] - ux * 7 - uy * 3.5} ${end[1] - uy * 7 + ux * 3.5} L${end[0] - ux * 7 + uy * 3.5} ${end[1] - uy * 7 - ux * 3.5} Z`} />
          </g>
        );
      })}
    </g>
  );
}

/** How a measure moved from the parent: ▲ better, ▼ worse, in the measure's own unit. */
function change(key: Measure, p: ComparePoint, parent: ComparePoint): string {
  const d = key === "perf" ? p.perfBp - parent.perfBp : key === "speed" ? parent.wallMs - p.wallMs : parent.tokens - p.tokens;
  if (Math.abs(d) < (key === "speed" ? 5 : 1)) return "same as parent";
  const size = key === "perf" ? `${Math.round(Math.abs(d) / 100)} pts` : key === "speed" ? fmtWall(Math.abs(d)) : `${Math.round(Math.abs(d)).toLocaleString("en-US")} tok`;
  return `${d > 0 ? "▲" : "▼"} ${size} vs parent`;
}

const realValue = (key: Measure, p: ComparePoint): string =>
  key === "perf" ? `${fmtPerf(p.perfBp)} score` : key === "speed" ? `${fmtWall(p.wallMs)} a run` : `${Math.round(p.tokens).toLocaleString("en-US")} tok/task`;

function Chip({ x, y, text, axis }: { x: number; y: number; text: string; axis: Axis }) {
  const w = text.length * 9 + 18;
  return (
    <g className={`rd-chip ax-${axis}`}>
      <rect x={x - w / 2} y={y} width={w} height={26} rx={6} />
      <text x={x} y={y + 18} textAnchor="middle">{text}</text>
    </g>
  );
}

/**
 * The selected version as a radar, like a player card: one spoke per measure, the
 * shape filled in its status colour, its parent drawn dashed behind it. Above it, the
 * version's place in the tree: the path from the start and the children, all selectable.
 */
function Radar({ byId, nodes, selected, onSelect }: { byId: Map<string, ComparePoint>; nodes: ExportNode[]; selected: string; onSelect: (id: string) => void }) {
  const all = new Map(nodes.map((n) => [n.id, n]));
  const node = all.get(selected) ?? nodes[0]!;
  const p = byId.get(node.id);
  const parentNode = all.get(node.parent);
  const parent = parentNode ? byId.get(parentNode.id) : undefined;

  // The path from the start of the tree down to this version, and what grew from it.
  const path: ExportNode[] = [];
  const seen = new Set<string>();
  for (let cur: ExportNode | undefined = node; cur && !seen.has(cur.id); cur = all.get(cur.parent)) {
    seen.add(cur.id);
    path.unshift(cur);
  }
  const children = nodes.filter((n) => n.parent === node.id);
  const chip = (n: ExportNode) => (
    <button key={n.id} type="button" className="rd-node" aria-pressed={n.id === node.id} onClick={() => onSelect(n.id)}
      title={byId.has(n.id) ? clip(n.hypothesis, 90) : `${clip(n.hypothesis, 70)} (not measured)`}>
      <svg width="12" height="12" aria-hidden="true"><Glyph status={n.status} cx={6} cy={6} r={4.2} blocked={isBlocked(n)} /></svg>
      {n.short}
    </button>
  );

  const rings = [0.25, 0.5, 0.75];
  const tone = node.status === "accepted" ? "pass" : node.status === "rejected" ? "fail" : "wait";

  return (
    <div className="cmp-pane">
      <div className="cmp-pane-head">
        <h3>Radar</h3>
        <span className="muted">The selected version on each measure, against its parent</span>
      </div>

      <div className="rd-head">
        <div className="rd-who">
          <svg width="14" height="14" aria-hidden="true"><Glyph status={node.status} cx={7} cy={7} r={5} blocked={isBlocked(node)} /></svg>
          <b>{STATUS_WORD[node.status]} · {node.short}</b>
          <span className="muted">{clip(node.hypothesis, 110)}</span>
        </div>
        <div className="rd-tree">
          <span className="rd-tree-label">Path</span>
          <span className="rd-path">
            {path.map((n, i) => (
              <span key={n.id} className="rd-step">{i > 0 && <span className="rd-arrow" aria-hidden="true">→</span>}{chip(n)}</span>
            ))}
          </span>
        </div>
        <div className="rd-tree">
          <span className="rd-tree-label">Children</span>
          <span className="rd-path">{children.length === 0 ? <span className="muted">none yet</span> : children.map(chip)}</span>
        </div>
      </div>

      <div className="cmp-chart">
        <svg viewBox={`0 0 ${RW} ${RH}`} role="img"
          aria-label={p
            ? `Radar of ${node.short}: ${SPOKES.map((sp) => `${sp.title} ${fmtRating(p.rating[sp.key])} (${realValue(sp.key, p)})`).join(", ")}${parent ? `, against its parent ${parent.n.short}` : ""}`
            : `${node.short} was not measured`}>
          <polygon className="rd-face" points={shapeOf({ perf: 1, speed: 1, cost: 1 })} />
          {rings.map((r) => <polygon key={r} className="rd-ring" points={shapeOf({ perf: r, speed: r, cost: r })} />)}
          {SPOKES.map((sp) => {
            const [x, y] = spokeAt(sp.angle, 1);
            return <line key={sp.key} className={`rd-spoke ax-${sp.axis}`} x1={RC[0]} y1={RC[1]} x2={x} y2={y} />;
          })}

          {parent && (
            <g className="rd-parent" aria-hidden="true">
              <polygon points={shapeOf(parent.rating)} />
              {SPOKES.map((sp) => {
                const [x, y] = spokeAt(sp.angle, parent.rating[sp.key]);
                return <circle key={sp.key} cx={x} cy={y} r={3} />;
              })}
            </g>
          )}
          {p ? (
            <g className={`rd-shape rd-${tone}`} aria-hidden="true">
              <polygon points={shapeOf(p.rating)} />
              {SPOKES.map((sp) => {
                const [x, y] = spokeAt(sp.angle, p.rating[sp.key]);
                return <circle key={sp.key} cx={x} cy={y} r={4.5} />;
              })}
            </g>
          ) : (
            <g aria-hidden="true">
              <text className="rd-empty" x={RC[0]} y={RC[1] - 4} textAnchor="middle">Not measured</text>
              <text className="rd-empty-sub" x={RC[0]} y={RC[1] + 14} textAnchor="middle">
                {isBlocked(node) ? blockedText(node.detail.mechanical!.cls) : "no score, tokens or time yet"}
              </text>
            </g>
          )}

          {SPOKES.map((sp) => {
            const [vx, vy] = spokeAt(sp.angle, 1);
            const top = sp.key === "perf";
            // Outward from the corner: above the top one, below and a little out for the others.
            const x = top ? vx : vx + Math.cos(sp.angle) * 14;
            const rating = p ? fmtRating(p.rating[sp.key]) : "—";
            const detail = p ? `${realValue(sp.key, p)}${parent ? ` · ${change(sp.key, p, parent)}` : ""}` : "not measured";
            const chipY = top ? vy - 38 : vy + 12;
            const nameY = top ? chipY - 20 : chipY + 42;
            const detailY = top ? chipY - 6 : chipY + 56;
            return (
              <g key={`b-${sp.key}`}>
                <text className="rd-name" x={x} y={nameY} textAnchor="middle">{sp.title.toUpperCase()}</text>
                <text className="rd-detail" x={x} y={detailY} textAnchor="middle">{detail}</text>
                <Chip x={x} y={chipY} text={rating} axis={sp.axis} />
              </g>
            );
          })}
        </svg>
      </div>

      <div className="legend rd-legend">
        <span><svg width="22" height="12" aria-hidden="true"><rect className={`rd-key rd-${tone}`} x="1" y="1" width="20" height="10" rx="2" /></svg>{node.short}{p ? "" : " (not measured)"}</span>
        {parentNode && (
          <span><svg width="22" height="12" aria-hidden="true"><path className="rd-parent-key" d="M1 6 H21" /></svg>
            Parent {parentNode.short}{parent ? "" : " (not measured)"}</span>
        )}
        <span><svg width="22" height="12" aria-hidden="true"><path className="rd-face-key" d="M1 11 L11 1 L21 11 Z" /></svg>Outer edge: best in this tree on that measure</span>
        {p && parent && <span>▲ better than its parent · ▼ worse</span>}
      </div>
    </div>
  );
}

/**
 * The trade-off triangle on its own, for the Tree tab. It follows the version
 * selected in the tree, and picking a dot selects that version there.
 */
export function TradeOffTriangle({ nodes, selected, onSelect, benchTotal }: Props) {
  const { points } = useMemo(() => compareData(nodes, benchTotal), [nodes, benchTotal]);
  const links = useMemo(() => treeLinks(nodes, points), [nodes, points]);
  const lineage = useMemo(() => lineageOf(selected, links, nodes, points), [selected, links, nodes, points]);
  const byId = useMemo(() => new Map(points.map((p) => [p.n.id, p])), [points]);

  if (points.length === 0) {
    return <p className="muted tri-empty">No version has a score, a token count and a time yet.</p>;
  }
  const sel = byId.get(selected);
  return (
    <>
      <Triangle points={points} byId={byId} selected={selected} onSelect={onSelect} links={links} lineage={lineage} />
      <p className="tri-selected">
        {sel
          ? <>{sel.n.short}: {fmtPerf(sel.perfBp)} · {fmtTokens(sel.tokens)} · {fmtWall(sel.wallMs)}</>
          : "The selected version was never measured, so it is not in the triangle."}
      </p>
    </>
  );
}

/**
 * Every version as a dot in one triangle: closer to a corner, stronger on that measure.
 * Versions on the same spot fan out on a small ring, and arrows draw the tree.
 */
function Triangle({ points, byId, selected, onSelect, links, lineage }: TreeProps & { points: ComparePoint[]; byId: Map<string, ComparePoint>; selected: string; onSelect: (id: string) => void }) {
  const [hover, setHover] = useState<Hover>(null);
  const at = new Map<string, Pt>(points.map((p) => [p.n.id, tri(p.mix.perf, p.mix.speed, p.mix.cost)]));
  // Versions with near-equal numbers share a spot. They fan out around it, accepted
  // first at the top, then the fastest, so each one can be seen and picked.
  const fanOrder = [...points].sort((a, b) => rankOf(b) - rankOf(a) || a.wallMs - b.wallMs);
  const drawn = separate(fanOrder.map((p) => ({ id: p.n.id, at: at.get(p.n.id)!, r: TR })), TGAP, 5);
  const dots: Spot[] = points.map((p) => ({ id: p.n.id, at: drawn.get(p.n.id)!.at, r: TR }));
  const labels = placeLabels(fanOrder.map((p) => {
    const isSel = p.n.id === selected;
    const d = drawn.get(p.n.id)!;
    return { id: p.n.id, at: d.at, r: isSel ? TR + 4 : TR, text: p.n.short, dir: d.dir, size: isSel ? 11 : 10, must: isSel };
  }), dots, TW, TH);

  const grid: ReactNode[] = [];
  for (const k of [0.2, 0.4, 0.6, 0.8]) {
    const lines: [Pt, Pt][] = [
      [tri(k, 1 - k, 0), tri(k, 0, 1 - k)],
      [tri(1 - k, k, 0), tri(0, k, 1 - k)],
      [tri(1 - k, 0, k), tri(0, 1 - k, k)],
    ];
    lines.forEach(([a, b], i) => grid.push(<line key={`g-${k}-${i}`} className="cmp-grid" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />));
  }
  const mid = tri(1 / 3, 1 / 3, 1 / 3);
  const order = [...points].sort((a, b) => Number(a.n.id === selected) - Number(b.n.id === selected) || rankOf(a) - rankOf(b));
  const hp = hover === null ? undefined : byId.get(hover);

  const key = (e: KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(id); }
  };

  return (
    <div className="cmp-pane">
      <div className="cmp-pane-head">
        <h3>Trade-off triangle</h3>
        <span className="muted">Closer to a corner, stronger on it</span>
      </div>
      <div className="cmp-chart">
        <svg viewBox={`0 0 ${TW} ${TH}`} role="group" aria-label={`Trade-off triangle of ${points.length} versions: performance at the top, speed bottom left, cost bottom right`}>
          <polygon className="cmp-tri-face" points={[TOP, LEFT, RIGHT].map((p) => p.join(",")).join(" ")} />
          {grid}
          <path className="cmp-mid" d={`M${mid[0] - 5} ${mid[1]} h10 M${mid[0]} ${mid[1] - 5} v10`} />

          <text className="cmp-corner" x={TOP[0]} y={TOP[1] - 26} textAnchor="middle">Performance</text>
          <text className="cmp-corner-sub" x={TOP[0]} y={TOP[1] - 11} textAnchor="middle">higher score</text>
          <text className="cmp-corner" x={LEFT[0]} y={LEFT[1] + 24} textAnchor="middle">Speed</text>
          <text className="cmp-corner-sub" x={LEFT[0]} y={LEFT[1] + 39} textAnchor="middle">less time</text>
          <text className="cmp-corner" x={RIGHT[0]} y={RIGHT[1] + 24} textAnchor="middle">Cost</text>
          <text className="cmp-corner-sub" x={RIGHT[0]} y={RIGHT[1] + 39} textAnchor="middle">fewer tokens</text>

          <TreeLinks links={links} lineage={lineage} byId={byId} spot={(id) => { const d = drawn.get(id); return d && { at: d.at, r: TR }; }} />

          {/* A thin line from where a moved dot really sits to where it is drawn. */}
          <g aria-hidden="true">
            {points.map((p) => {
              const [tx, ty] = at.get(p.n.id)!;
              const [x, y] = drawn.get(p.n.id)!.at;
              if (Math.hypot(x - tx, y - ty) < 1.5) return null;
              return <line key={`s-${p.n.id}`} className="cmp-spoke" x1={tx} y1={ty} x2={x} y2={y} />;
            })}
            {points.map((p) => {
              const [tx, ty] = at.get(p.n.id)!;
              const [x, y] = drawn.get(p.n.id)!.at;
              return Math.hypot(x - tx, y - ty) < 1.5 ? null : <circle key={`a-${p.n.id}`} className="cmp-anchor" cx={tx} cy={ty} r={2} />;
            })}
          </g>

          {order.map((p) => {
            const d = drawn.get(p.n.id)!;
            const [x, y] = d.at;
            const isSel = p.n.id === selected;
            const lab = labels.get(p.n.id);
            return (
              <g key={p.n.id} className="cmp-dot" role="button" tabIndex={0} aria-pressed={isSel}
                aria-label={`${STATUS_WORD[p.n.status]} ${p.n.short}: ${fmtPerf(p.perfBp)}, ${fmtTokens(p.tokens)}, ${fmtWall(p.wallMs)}`}
                onClick={() => onSelect(p.n.id)} onKeyDown={(e) => key(e, p.n.id)}
                onPointerEnter={() => setHover(p.n.id)} onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(p.n.id)} onBlur={() => setHover(null)}>
                <circle className="cmp-hit" cx={x} cy={y} r={TR + TGAP / 2} />
                {(isSel || hover === p.n.id) && <circle className={isSel ? "cmp-ring" : "cmp-ring cmp-ring-hover"} cx={x} cy={y} r={TR + 4} />}
                <Glyph status={p.n.status} cx={x} cy={y} r={TR} />
                {lab && <text className={isSel ? "cmp-label" : "cmp-label cmp-label-quiet"} x={lab.x} y={lab.y} aria-hidden="true">{p.n.short}</text>}
              </g>
            );
          })}
        </svg>
        {hp && (() => {
          const [x, y] = drawn.get(hp.n.id)!.at;
          return <Tip p={hp} x={x} y={y} w={TW} h={TH} also={neighbours(at, hp.n.id, 2 * TR + TGAP)} byId={byId} />;
        })()}
      </div>
    </div>
  );
}

function Axes3D({ points, byId, selected, onSelect, hover, setHover, links, lineage }: ChartProps & TreeProps) {
  const [view, setView] = useState<View>(HOME);
  // null until the viewer chooses: then it follows prefers-reduced-motion.
  const [spin, setSpin] = useState<boolean | null>(null);
  const [inside, setInside] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [tween, setTween] = useState<{ from: View; to: View; t0: number } | null>(null);
  // The axis a preset looks straight down. Any other turn brings it back.
  const [away, setAway] = useState<Axis | null>(null);
  const reduced = useSyncExternalStore(subscribeReduced, getReduced, () => true);
  const drag = useRef<{ id: number; x: number; y: number; from: View; moved: boolean } | null>(null);

  const autoSpin = spin ?? !reduced;
  const spinning = autoSpin && !inside && !dragging && tween === null;

  useEffect(() => {
    if (!spinning) return;
    let raf = 0;
    let last = -1;
    const tick = (now: number) => {
      const dt = last < 0 ? 0 : Math.min(0.05, (now - last) / 1000);
      last = now;
      setView((v) => ({ ...v, yaw: v.yaw + dt * 0.32 }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [spinning]);

  useEffect(() => {
    if (tween === null) return;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - tween.t0) / 480);
      const e = 1 - (1 - t) ** 3;
      setView({
        yaw: tween.from.yaw + (tween.to.yaw - tween.from.yaw) * e,
        pitch: tween.from.pitch + (tween.to.pitch - tween.from.pitch) * e,
      });
      if (t < 1) raf = requestAnimationFrame(tick);
      else setTween(null);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [tween]);

  const goTo = (to: View, dim: Axis | null = null) => {
    setSpin(false);
    setAway(dim);
    const target = { yaw: view.yaw + wrap(to.yaw - view.yaw), pitch: to.pitch };
    if (reduced) { setTween(null); setView(target); } else setTween({ from: view, to: target, t0: performance.now() });
  };
  const nudge = (dYaw: number, dPitch: number) => {
    setSpin(false);
    setTween(null);
    setAway(null);
    setView((v) => ({ yaw: v.yaw + dYaw, pitch: clamp(v.pitch + dPitch, -PI / 2, PI / 2) }));
  };

  // Map each number onto the cube, -1 to 1. Each axis spans this tree's own range, so
  // the dots fill the cube. Cost and time run backwards: fewer tokens and less time
  // sit further along their arrows, so every arrow points to better.
  const perf = fitDomain(points.map((p) => p.perfBp), 10000);
  const cost = fitDomain(points.map((p) => p.tokens));
  const time = fitDomain(points.map((p) => p.wallMs));
  const X = (bp: number) => -1 + (2 * (bp - perf.lo)) / (perf.hi - perf.lo);
  const Y = (t: number) => -1 + (2 * (cost.hi - t)) / (cost.hi - cost.lo);
  const Z = (ms: number) => -1 + (2 * (time.hi - ms)) / (time.hi - time.lo);
  const P = (v: Vec) => project(v, view);

  // Grid on the three faces that sit behind the points from this angle.
  const faceDepth = (axis: 0 | 1 | 2) => {
    const e: Vec = [0, 0, 0];
    e[axis] = 1;
    return project(e, view).depth;
  };
  const back = ([0, 1, 2] as const).map((a) => (faceDepth(a) > 0 ? -1 : 1));
  const perfTicks = perf.ticks;
  const tickPos: number[][] = [perfTicks.map(X), cost.ticks.map(Y), time.ticks.map(Z)];
  const planes: ReactNode[] = [];
  ([0, 1, 2] as const).forEach((a) => {
    const [u, w] = ([0, 1, 2] as const).filter((k) => k !== a);
    const at = (pu: number, pw: number): Vec => {
      const v: Vec = [0, 0, 0];
      v[a] = back[a]!;
      v[u!] = pu;
      v[w!] = pw;
      return v;
    };
    const corners = [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)].map(P);
    planes.push(<polygon key={`f-${a}`} className="cmp-plane" points={corners.map((c) => `${c.x},${c.y}`).join(" ")} />);
    for (const t of tickPos[u!]!) {
      const s = P(at(t, -1));
      const e = P(at(t, 1));
      planes.push(<line key={`f-${a}-u-${t}`} className="cmp-plane-grid" x1={s.x} y1={s.y} x2={e.x} y2={e.y} />);
    }
    for (const t of tickPos[w!]!) {
      const s = P(at(-1, t));
      const e = P(at(1, t));
      planes.push(<line key={`f-${a}-w-${t}`} className="cmp-plane-grid" x1={s.x} y1={s.y} x2={e.x} y2={e.y} />);
    }
  });

  // The three axes from the corner where every number is at its worst.
  const O = P([-1, -1, -1]);
  const axes = [
    { name: "x" as Axis, title: "Performance", end: [1.7, -1, -1] as Vec, label: [1.98, -1, -1] as Vec },
    { name: "y" as Axis, title: "Cost", end: [-1, 1.62, -1] as Vec, label: [-1, 1.85, -1] as Vec },
    { name: "z" as Axis, title: "Speed", end: [-1, -1, 1.7] as Vec, label: [-1, -1, 1.98] as Vec },
  ];
  const arrow = (a: Proj, b: Proj) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 8) return "";
    const ux = dx / len;
    const uy = dy / len;
    const s = 8;
    return `M${b.x} ${b.y} L${b.x - ux * s - uy * s * 0.5} ${b.y - uy * s + ux * s * 0.5} L${b.x - ux * s + uy * s * 0.5} ${b.y - uy * s - ux * s * 0.5} Z`;
  };
  const OFF = 0.17;
  // Where the three axes meet, their first labels would collide. Only x keeps its label there.
  const nearOrigin = (pos: number) => pos < -0.8;
  const ticks = [
    ...perfTicks.map((t) => ({ k: `x-${t}`, at: [X(t), -1 - OFF, -1 - OFF] as Vec, text: fmtPerf(t) })),
    ...cost.ticks.filter((t) => !nearOrigin(Y(t))).map((t) => ({ k: `y-${t}`, at: [-1 - OFF, Y(t), -1 - OFF] as Vec, text: Math.round(t).toLocaleString("en-US") })),
    ...time.ticks.filter((t) => !nearOrigin(Z(t))).map((t) => ({ k: `z-${t}`, at: [-1 - OFF, -1 - OFF, Z(t)] as Vec, text: fmtWall(t) })),
  ];

  const projected = points.map((p) => {
    const v: Vec = [X(p.perfBp), Y(p.tokens), Z(p.wallMs)];
    return { p, s: P(v), floor: P([v[0], -1, v[2]]) };
  }).sort((a, b) => a.s.depth - b.s.depth || rankOf(a.p) - rankOf(b.p));
  // From this angle some dots land on each other. Push them apart on screen, every
  // frame, so each stays visible while the plot turns; a thin line marks the true spot.
  const apart = separate(projected.map((q) => ({ id: q.p.n.id, at: [q.s.x, q.s.y], r: PR * q.s.f })), PGAP);
  const placed = projected.map((q) => ({ ...q, d: apart.get(q.p.n.id)!.at }));
  const spot3d = new Map(placed.map((q) => [q.p.n.id, { at: q.d, r: PR * q.s.f }]));
  const sel = placed.find((q) => q.p.n.id === selected);
  const selLabel = sel && placeLabels(
    [{ id: sel.p.n.id, at: sel.d, r: PR * sel.s.f + 4, text: sel.p.n.short, size: 11, must: true }],
    placed.map((q) => ({ id: q.p.n.id, at: q.d, r: PR * q.s.f })), PW, PH,
  ).get(sel.p.n.id);
  const at2d = new Map<string, Pt>(placed.map((q) => [q.p.n.id, [q.s.x, q.s.y]]));
  const ideal = P([1, 1, 1]);
  const hp = hover === null ? undefined : placed.find((q) => q.p.n.id === hover);

  const onKey = (e: KeyboardEvent) => {
    const step = 0.12;
    if (e.key === "ArrowLeft") nudge(-step, 0);
    else if (e.key === "ArrowRight") nudge(step, 0);
    else if (e.key === "ArrowUp") nudge(0, -step);
    else if (e.key === "ArrowDown") nudge(0, step);
    else if (e.key === "Home") goTo(HOME);
    else return;
    e.preventDefault();
  };

  return (
    <div className="cmp-pane">
      <div className="cmp-pane-head">
        <h3>3D axes</h3>
        <span className="muted">Drag to spin · every arrow points to better</span>
      </div>
      <div className="cmp-tools" role="group" aria-label="3D view">
        <button type="button" aria-pressed={autoSpin} onClick={() => { setTween(null); setAway(null); setSpin(!autoSpin); }}>{autoSpin ? "Pause spin" : "Spin"}</button>
        <button type="button" onClick={() => goTo(HOME)}>Reset</button>
        {PRESETS.map((v) => (
          <button key={v.label} type="button" title={v.title} aria-label={v.title} aria-pressed={away === v.away} onClick={() => goTo(v.view, v.away)}>{v.label}</button>
        ))}
      </div>
      <div className="cmp-chart cmp-3d">
        <svg viewBox={`0 0 ${PW} ${PH}`} className={dragging ? "is-dragging" : undefined} tabIndex={0}
          role="group" aria-label={`3D plot of ${points.length} versions: x performance, y cost, z speed. Drag or use the arrow keys to turn it.`}
          onKeyDown={onKey}
          onPointerEnter={() => setInside(true)}
          onPointerLeave={() => { setInside(false); if (drag.current === null) setHover(null); }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: view, moved: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d === null || d.id !== e.pointerId) return;
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            if (!d.moved) {
              // A small move is still a click on a dot.
              if (Math.hypot(dx, dy) < 4) return;
              d.moved = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              setDragging(true);
              setAway(null);
              setSpin(false);
              setTween(null);
              setHover(null);
            }
            setView({ yaw: d.from.yaw + dx * 0.01, pitch: clamp(d.from.pitch + dy * 0.01, -PI / 2, PI / 2) });
          }}
          onPointerUp={() => { drag.current = null; setDragging(false); }}
          onPointerCancel={() => { drag.current = null; setDragging(false); setInside(false); }}>
          {planes}

          {axes.map((a) => {
            const end = P(a.end);
            const lab = P(a.label);
            return (
              <g key={a.name} className={a.name === away ? "cmp-ax is-dim" : "cmp-ax"}>
                <line className={`cmp-axis ax-${a.name}`} x1={O.x} y1={O.y} x2={end.x} y2={end.y} />
                <path className={`cmp-arrow ax-${a.name}`} d={arrow(O, end)} />
                <text className="cmp-axis-title" x={lab.x} y={lab.y + 4} textAnchor="middle">
                  <tspan className="cmp-axis-name">{a.name} </tspan>{a.title}
                </text>
              </g>
            );
          })}
          {ticks.map((t) => {
            const s = P(t.at);
            return <text key={t.k} className={`c-tick cmp-tick${away !== null && t.k.startsWith(away) ? " is-dim" : ""}`} x={s.x} y={s.y + 3.5} textAnchor="middle">{t.text}</text>;
          })}

          <g aria-hidden="true">
            <path className="cmp-ideal" d={`M${ideal.x} ${ideal.y - 6} L${ideal.x + 6} ${ideal.y} L${ideal.x} ${ideal.y + 6} L${ideal.x - 6} ${ideal.y} Z`} />
            <text className="cmp-ideal-label" x={ideal.x + 10} y={ideal.y + 4}>best on all three</text>
          </g>

          {placed.map(({ p, s, floor, d }) => (
            <g key={`d-${p.n.id}`} aria-hidden="true">
              <line className="cmp-drop" x1={floor.x} y1={floor.y} x2={s.x} y2={s.y} />
              <ellipse className="cmp-shadow" cx={floor.x} cy={floor.y} rx={3.2 * floor.f} ry={1.6 * floor.f} />
              {Math.hypot(d[0] - s.x, d[1] - s.y) >= 1.5 && (
                <>
                  <line className="cmp-spoke" x1={s.x} y1={s.y} x2={d[0]} y2={d[1]} />
                  <circle className="cmp-anchor" cx={s.x} cy={s.y} r={2} />
                </>
              )}
            </g>
          ))}
          <TreeLinks links={links} lineage={lineage} byId={byId} spot={(id) => spot3d.get(id)} />
          {placed.map(({ p, s, d: [x, y] }) => {
            const isSel = p.n.id === selected;
            const r = PR * s.f;
            return (
              <g key={p.n.id} className="cmp-dot" role="button" tabIndex={-1} aria-pressed={isSel}
                aria-label={`${STATUS_WORD[p.n.status]} ${p.n.short}: ${fmtPerf(p.perfBp)}, ${fmtTokens(p.tokens)}, ${fmtWall(p.wallMs)}`}
                onClick={() => onSelect(p.n.id)}
                onPointerEnter={() => { if (drag.current?.moved !== true) setHover(p.n.id); }}
                onPointerLeave={() => setHover(null)}>
                <circle className="cmp-hit" cx={x} cy={y} r={r + PGAP / 2} />
                {(isSel || hover === p.n.id) && <circle className={isSel ? "cmp-ring" : "cmp-ring cmp-ring-hover"} cx={x} cy={y} r={r + 4} />}
                <Glyph status={p.n.status} cx={x} cy={y} r={r} />
              </g>
            );
          })}
          {sel && selLabel && <text className="cmp-label" x={selLabel.x} y={selLabel.y} aria-hidden="true">{sel.p.n.short}</text>}
        </svg>
        {hp && <Tip p={hp.p} x={hp.d[0]} y={hp.d[1]} w={PW} h={PH} also={neighbours(at2d, hp.p.n.id, 2 * PR)} byId={byId} />}
      </div>
    </div>
  );
}
