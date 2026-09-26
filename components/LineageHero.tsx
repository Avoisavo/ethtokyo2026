"use client";

import { useRef, type KeyboardEvent } from "react";
import { STATUS_WORD, clip, isBlocked, nodeNumbers, objectiveOf, wordOf } from "@/lib/format";
import { tidySlots, type Forest } from "@/lib/layout";
import { changesOf, fmtPct } from "@/lib/metrics";
import { ensNames } from "@/lib/ens-name";
import type { ExportNode } from "@/lib/types";
import { Glyph } from "./Glyph";
import { ZOOM_STEP, usePanZoom } from "./usePanZoom";

// The one-pager's Figure 1, drawn large: a tidy tree with S-curves from parent to child.
const COL = 420;
/** Row spacing for a one-line name; each extra name line adds NAME_LINE. */
const ROW = 84;
const NAME_LINE = 15;
/** Characters per name line in the diagram, about LABEL_W at 13px bold. */
const NAME_CHARS = 38;
const PAD_X = 40;
const PAD_Y = 46;
const LABEL_W = 300;
const R = 8;
/** The middle of a node's drawing, right of its dot: the objective pill sits left of it, the label right. */
const FOCUS_DX = 90;
const DEAD = new Set(["rejected", "withdrawn", "superseded"]);

/** Break an ENS name into lines at its dots, so the full name shows without clipping. */
function wrapName(name: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const [i, label] of name.split(".").entries()) {
    const part = i === 0 ? label : `.${label}`;
    if (line && line.length + part.length > NAME_CHARS) {
      // Keep the dot at the end of the line, so the break reads as one name.
      lines.push(`${line}.`);
      line = label;
    } else {
      line += part;
    }
  }
  if (line) lines.push(line);
  return lines;
}

interface Props {
  forest: Forest;
  nodes: ExportNode[];
  selected: string;
  onSelect: (id: string) => void;
  benchTotal: number;
  minVerifications: number;
  /** Names the root in ENS-style names. */
  harness?: string;
  /** The statuses the layout is computed from. Defaults to `nodes`. */
  layoutNodes?: ExportNode[];
}

export function LineageHero({ forest, nodes, selected, onSelect, benchTotal, minVerifications, harness, layoutNodes }: Props) {
  const status = new Map((layoutNodes ?? nodes).map((n) => [n.id, n.status]));
  const { slots, rows, maxDepth } = tidySlots(forest, (id) => status.get(id));
  const names = ensNames(nodes, harness);
  const nameLines = new Map(nodes.map((n) => [n.id, wrapName(names.get(n.id) ?? n.short)]));
  // Rows grow with the longest wrapped name, so no label runs into the next row.
  const extra = Math.max(0, ...[...nameLines.values()].map((l) => l.length - 1)) * NAME_LINE;
  const row = ROW + extra;
  const padY = PAD_Y + extra;
  const at = (id: string) => {
    const s = slots[id]!;
    return { x: PAD_X + s.depth * COL, y: padY + s.row * row };
  };
  const width = PAD_X * 2 + maxDepth * COL + LABEL_W;
  const height = padY * 2 + (rows - 1) * row;
  const svgRef = useRef<SVGSVGElement>(null);
  const focus = slots[selected] === undefined ? null : at(selected);
  const zoom = usePanZoom(svgRef, width, height, focus && { x: focus.x + FOCUS_DX, y: focus.y });

  // Where a branch rejoins the accepted line.
  //
  // A version whose parent was rejected often restores an earlier harness: the
  // files it runs hash to the same id as an accepted ancestor, so the two run
  // exactly the same code. Walk up past the rejected parent to that ancestor.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const restoredAncestor = (n: ExportNode): string => {
    const seen = new Set<string>();
    let cur = byId.get(n.parent);
    while (cur !== undefined && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.status === "accepted" && cur.harness === n.harness) return cur.id;
      cur = byId.get(cur.parent);
    }
    return "";
  };
  const restores = nodes
    .filter((n) => DEAD.has(byId.get(n.parent)?.status ?? "") && n.harness !== undefined)
    .map((n) => ({ from: restoredAncestor(n), to: n.id }))
    .filter((e) => e.from !== "" && slots[e.from] !== undefined && slots[e.to] !== undefined);

  const key = (e: KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(id); }
  };

  return (
    <div className="hero">
      {/* Sized by CSS to fill the plate. Zooming changes only the viewBox, never the page layout. */}
      <svg ref={svgRef} viewBox={zoom.viewBox} role="group" aria-label={`Lineage of ${nodes.length} harness versions`}
        className={zoom.panning ? "panning" : zoom.pannable ? "pannable" : undefined} {...zoom.svgProps}>
        {nodes.filter((n) => slots[n.parent] !== undefined && slots[n.id] !== undefined).map((n) => {
          const a = at(n.parent);
          const b = at(n.id);
          const mx = (a.x + b.x) / 2;
          return (
            <path key={`e-${n.id}`} className={DEAD.has(n.status) ? "h-edge dead" : "h-edge"}
              d={`M${a.x + R} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x - R} ${b.y}`} />
          );
        })}
        {/* A version whose parent was rejected, drawn back to the accepted version whose
            harness it restores. Same harness hash, so the two run exactly the same code.
            The parent edge above is the record; this one shows where the branch rejoins. */}
        {restores.map(({ from, to }) => {
          const a = at(from);
          const b = at(to);
          const mx = (a.x + b.x) / 2;
          return (
            <path key={`r-${to}`} className="h-edge restore"
              d={`M${a.x + R} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x - R} ${b.y}`}>
              <title>{`runs the same harness as ${from.slice(0, 8)}`}</title>
            </path>
          );
        })}

        {/* The direction each change aimed for, on the line just before the child. */}
        {nodes.filter((n) => slots[n.parent] !== undefined && slots[n.id] !== undefined).map((n) => {
          const b = at(n.id);
          const local = changesOf(n, nodes).local;
          const label = local === null ? objectiveOf(n) : `${objectiveOf(n)} ${fmtPct(local)}`;
          const w = label.length * 5.5 + 14;
          return (
            <g key={`o-${n.id}`} className="objective">
              <rect x={b.x - R - 10 - w} y={b.y - 8} width={w} height={16} rx={8} />
              <text x={b.x - R - 10 - w / 2} y={b.y + 3.2} textAnchor="middle">{label}</text>
            </g>
          );
        })}
        {nodes.filter((n) => slots[n.id] !== undefined).map((n) => {
          const { x, y } = at(n.id);
          const sel = n.id === selected;
          const name = names.get(n.id) ?? n.short;
          const word = wordOf(n);
          const lines = nameLines.get(n.id) ?? [name];
          const up = (lines.length - 1) * NAME_LINE;
          const hyp = clip(n.hypothesis, 44);
          const num = nodeNumbers(n, nodes, benchTotal, minVerifications);
          // White blocks behind the label lines. Edges are drawn first, so an edge that
          // runs under a label is hidden there and reappears past it.
          const labelW = Math.min(LABEL_W - 20, Math.max(...lines.map((l) => l.length * 7.2), hyp.length * 5.9, num.length * 6.6) + 8);
          return (
            <g key={n.id} className={`h-node s-${n.status}${sel ? " is-selected" : ""}`} role="button"
              tabIndex={0} aria-pressed={sel} aria-label={`${STATUS_WORD[n.status]} ${name}. ${n.hypothesis}`}
              onClick={() => onSelect(n.id)} onKeyDown={(e) => key(e, n.id)}
              onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) zoom.reveal({ x: x + FOCUS_DX, y }); }}>
              {/* Two blocks, with an open band at the dot height. A straight edge stays visible
                  in that band, between the hypothesis above and the numbers below. */}
              <rect className="backdrop" x={x + 14} y={y - 30 - up} width={labelW} height={29 + up} />
              <rect className="backdrop" x={x + 14} y={y + 6} width={labelW} height={26} />
              <rect className="hit" x={x - 16} y={y - 33 - up} width={LABEL_W - 6} height={68 + up} rx={6} />
              {sel && <circle className="ring" cx={x} cy={y} r={R + 5} />}
              <Glyph status={n.status} cx={x} cy={y} r={R} />
              <text className="h-word" x={x + 18} y={y - 19 - up}>{word}</text>
              <title>{`${name} · ${n.short}`}</title>
              <text className="h-ens" x={x + 18} y={y - 4 - up}>
                {lines.map((l, i) => (
                  <tspan key={i} x={x + 18} dy={i === 0 ? 0 : NAME_LINE}>{l}</tspan>
                ))}
              </text>
              <text className="h-hyp" x={x + 18} y={y + 16}>{hyp}</text>
              <text className="h-num" x={x + 18} y={y + 29}>{num}</text>
            </g>
          );
        })}
      </svg>
      <div className="zoom" role="group" aria-label="Zoom" title="Pinch or Ctrl/⌘ + scroll to zoom. Drag to move around.">
        <button type="button" onClick={() => zoom.zoomBy(1 / ZOOM_STEP)} disabled={zoom.atMin} aria-label="Zoom out">−</button>
        <span className="zoom-level">{zoom.zoom === null ? "" : `${Math.round(zoom.zoom * 100)}%`}</span>
        <button type="button" onClick={() => zoom.zoomBy(ZOOM_STEP)} disabled={zoom.atMax} aria-label="Zoom in">+</button>
        <button type="button" onClick={zoom.fitAll} disabled={zoom.atMin}>Fit</button>
      </div>
    </div>
  );
}
