"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { STATUS_WORD, clip, isBlocked, nodeNumbers, wordOf } from "@/lib/format";
import type { Forest } from "@/lib/layout";
import { ensNames } from "@/lib/ens-name";
import type { ExportNode } from "@/lib/types";
import { Compare } from "./Compare";
import { Glyph } from "./Glyph";
import { LineageHero } from "./LineageHero";
import { NodePanel } from "./NodePanel";
import { TreeView } from "./TreeView";
import { useEnsRecords } from "./useEnsRecords";

interface Props {
  nodes: ExportNode[];
  forest: Forest;
  initial: string;
  minVerifications: number;
  benchTotal: number;
  /** Rendered beside the full record. */
  info: ReactNode;
  /** The Stats view. */
  stats: ReactNode;
  /** Which view opens first. `?view=stats` or `?view=compare` sets it. */
  initialView?: View;
  /** The harness key, e.g. "petri-harness-v1". Names the root in ENS-style names. */
  harness?: string;
}

type View = "tree" | "stats" | "compare";

/**
 * The version the stage demo accepts live. On every page load it is drawn as it
 * was BEFORE its second key, so the demo can be rehearsed. The real record is
 * unchanged and still reaches this page; the moment a new record arrives, the
 * real status is shown. Set it to "" to always show the recorded status.
 */
const DEMO_PENDING = "ae0acec3";

/**
 * Draw an accepted version as "waiting for its second key": its first check
 * only, and the status that goes with it. Display only, and never the reverse:
 * a version is never drawn as accepted when the record says it is not.
 */
function showAsPending(nodes: ExportNode[], prefix: string): ExportNode[] {
  if (prefix === "") return nodes;
  return nodes.map((n) => {
    if (!n.id.startsWith(prefix) || n.status !== "accepted") return n;
    return {
      ...n,
      status: "pending",
      statusCode: "INSUFFICIENT_VERIFICATIONS",
      statusReason: "1 of 2 verifications from distinct keys. The author's own runs never count.",
      verifiedDeltaBp: null,
      verifications: n.verifications.slice(0, 1),
    };
  });
}

/**
 * STAGE SIMULATION. Pressing Space shows the SELECTED version as accepted by two
 * keys. It changes this browser tab only. Nothing is written, no record is
 * signed, and a refresh shows the recorded tree again.
 */
function simulateAccepted(nodes: ExportNode[], targetId: string): ExportNode[] {
  const template = nodes.find((n) => n.id.startsWith("ecc7cdb0"))?.verifications.filter((v) => v.counted) ?? [];
  return nodes.map((n) => {
    if (n.id !== targetId) return n;
    const verifications = template.slice(0, 2).map((v, i) => ({
      ...v,
      reportId: `simulated-${i}`,
      counted: true,
      ignoredWhy: "",
      deltaMedianBp: 1000,
      parent: { ...v.parent, node: n.parent, medianBp: 9000 },
      candidate: { ...v.candidate, node: n.id, medianBp: 10000 },
    }));
    return {
      ...n,
      status: "accepted",
      statusCode: "WIN",
      statusReason: "2 verifications from distinct keys, every one at or above +1000bp. Worst delta +1000bp.",
      verifiedDeltaBp: 1000,
      detail: {
        ...n.detail,
        claimedMedianBp: 10000,
        mechanical: n.detail.mechanical ? { ...n.detail.mechanical, cls: "ok", evidence: "" } : undefined,
      },
      verifications,
    };
  });
}

export function TreeWorkspace({ nodes: recorded, forest, initial, minVerifications, benchTotal, info, stats, initialView = "tree", harness }: Props) {
  const [selected, setSelected] = useState(initial);
  const [view, setView] = useState<View>(initialView);
  const [simulatedId, setSimulatedId] = useState<string | null>(null);
  // True until a new record arrives from the engine in this tab.
  const [beforeUpdate, setBeforeUpdate] = useState(true);

  const nodes = useMemo(() => {
    const base = beforeUpdate ? showAsPending(recorded, DEMO_PENDING) : recorded;
    return simulatedId === null ? base : simulateAccepted(base, simulatedId);
  }, [beforeUpdate, simulatedId, recorded]);

  const names = useMemo(() => ensNames(nodes, harness), [nodes, harness]);
  // Every version's record, read from its ENS name. A showcase tree is never looked up.
  const ens = useEnsRecords([...names.values()], !recorded.some((n) => n.showcase));

  // The demo version shows its real status once a new record is written.
  // LiveRefresh announces that, then refreshes the page with the new record.
  useEffect(() => {
    const onDetected = () => setBeforeUpdate(false);
    window.addEventListener("petri:detected", onDetected);
    return () => window.removeEventListener("petri:detected", onDetected);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || (e.target as HTMLElement | null)?.closest("input, textarea, select")) return;
      e.preventDefault();
      // The version on screen. A version that is already accepted stays as it is.
      setSimulatedId((current) => (current === null ? selected : current));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const node = nodes.find((n) => n.id === selected) ?? nodes[0]!;
  // The status on screen is a stage-demo override, not the record, so the panel
  // does not call the ENS copy stale.
  const staged = simulatedId === node.id
    || (beforeUpdate && DEMO_PENDING.length > 0 && node.id.startsWith(DEMO_PENDING)
      && recorded.find((n) => n.id === node.id)?.status === "accepted");
  const shared = { forest, nodes, selected: node.id, onSelect: setSelected, benchTotal, minVerifications, harness };

  return (
    <>
      <div className="view-bar">
        <div className="seg" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "tree"} onClick={() => setView("tree")}>Tree</button>
          <button type="button" aria-pressed={view === "stats"} onClick={() => setView("stats")}>Stats</button>
          <button type="button" aria-pressed={view === "compare"} onClick={() => setView("compare")}>Compare</button>
        </div>
      </div>

      {view === "tree" ? (
        <figure className="stage">
          <div className="plate tree-plate">
            <div className="legend legend-overlay" aria-label="Legend">
              <span><svg width="14" height="14" aria-hidden="true"><Glyph status="accepted" cx={7} cy={7} r={5} /></svg>Accepted — two other keys re-ran it and agreed</span>
              <span><svg width="14" height="14" aria-hidden="true"><Glyph status="rejected" cx={7} cy={7} r={5} /></svg>Rejected — kept, with the reason</span>
              <span><svg width="14" height="14" aria-hidden="true"><Glyph status="pending" cx={7} cy={7} r={5} /></svg>Pending — waiting for keys</span>
              <span><svg width="22" height="14" aria-hidden="true"><line className="h-edge restore" x1="1" x2="21" y1="7" y2="7" /></svg>Runs the same harness as that version again</span>
            </div>
            <LineageHero {...shared} layoutNodes={recorded} />
            <TreeView {...shared} />
          </div>

          <div className={`selected-strip s-${node.status}`} aria-live="polite">
            <svg width="14" height="14" aria-hidden="true"><Glyph status={node.status} cx={7} cy={7} r={5} /></svg>
            <span className="sel-word" title={node.short}>{wordOf(node)} · {names.get(node.id)}</span>
            <span className="sel-hyp">{clip(node.hypothesis, 96)}</span>
            <span className="sel-num">{nodeNumbers(node, nodes, benchTotal, minVerifications)}</span>
            <a href="#record">Full record ↓</a>
          </div>
        </figure>
      ) : view === "stats" ? (
        stats
      ) : (
        <Compare nodes={nodes} selected={node.id} onSelect={setSelected} benchTotal={benchTotal} />
      )}

      <section id="record" className="record">
        <NodePanel node={node} nodes={nodes} harness={harness} minVerifications={minVerifications}
          benchTotal={benchTotal} onSelect={setSelected}
          ens={{ state: ens.state, lookup: ens.byName.get(names.get(node.id)!) }} staged={staged}
          onVerifyCopied={() => {
            // STAGE DEMO. Copying the verify command shows this version accepted,
            // the same simulation the Space key does. Display only, in this tab.
            const target = node.id;
            window.setTimeout(() => setSimulatedId((current) => current ?? target), 1200);
          }} />
        <div className="record-info">{info}</div>
      </section>
    </>
  );
}
