"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { STATUS_WORD, clip, isBlocked, nodeNumbers, wordOf } from "@/lib/format";
import type { Forest } from "@/lib/layout";
import { ONCHAIN_TREES, REAL_TREE, ensNames } from "@/lib/ens/name";
import type { ExportNode } from "@/lib/types";
import { BuyTab } from "./BuyTab";
import { Compare } from "./Compare";
import { Glyph } from "./Glyph";
import { LineageHero, TradeIcon, WorldTick } from "./LineageHero";
import { NodePanel } from "./NodePanel";
import { Panels, type PanelDef } from "./Panels";
import { ProposeTab, VerifyTab } from "./ProposeTab";
import { TreeView } from "./TreeView";
import { useEnsRecords } from "./useEnsRecords";

interface Props {
  nodes: ExportNode[];
  forest: Forest;
  initial: string;
  minVerifications: number;
  benchTotal: number;
  /** The tree's tabs, shown beside the full record. */
  panels: PanelDef[];
  /** The Stats view. */
  stats: ReactNode;
  /** Which view opens first. `?view=stats` or `?view=compare` sets it. */
  initialView?: View;
  /** The tree slug, e.g. "coding--petri-harness-v1--claude-sonnet-5". It names the tree on ENS. */
  harness?: string;
}

type View = "tree" | "stats" | "compare";

/**
 * The version the stage demo accepts live. On every page load it is drawn as it
 * was BEFORE its second key, so the demo can be rehearsed. The real record is
 * unchanged and still reaches this page; the moment a new record arrives, the
 * real status is shown. Set it to "" to always show the recorded status.
 */
const DEMO_PENDING: string = "ae0acec3";

/**
 * World ID badges. A real one comes only from a real World ID proof (see
 * lib/trees.ts). To show the idea on the older versions, which never had a
 * World ID check, some get an example badge, drawn hollow and titled as an
 * example. The same versions every time, picked by their id.
 */
function withWorldBadges(nodes: ExportNode[], verifiedId: string | null): ExportNode[] {
  return nodes.map((n) => {
    if (n.worldId) return n;
    if (n.id === verifiedId) return { ...n, worldId: { kind: "verified", real: false } };
    if (n.parent === "root" || n.author === "web") return n;
    return parseInt(n.id.slice(0, 2), 16) % 3 === 0 ? { ...n, worldId: { kind: "submitted", real: false } } : n;
  });
}

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

export function TreeWorkspace({ nodes: given, forest, initial, minVerifications, benchTotal, panels, stats, initialView = "tree", harness }: Props) {
  // The root is the baseline: drawn as accepted, because everything is measured against it.
  const recorded = useMemo(
    () => given.map((n) => (n.parent === "root" ? { ...n, status: "accepted" as const, statusCode: "BASELINE" } : n)),
    [given],
  );
  const [selected, setSelected] = useState(initial);
  const [view, setView] = useState<View>(initialView);
  const [simulatedId, setSimulatedId] = useState<string | null>(null);
  // True until a new record arrives from the engine in this tab.
  const [beforeUpdate, setBeforeUpdate] = useState(true);

  // The version the Verify demo joined with the World ID scan. The scan is a demo, so its badge is an example.
  const [worldVerified, setWorldVerified] = useState<string | null>(null);
  const nodes = useMemo(() => {
    const base = beforeUpdate ? showAsPending(recorded, DEMO_PENDING) : recorded;
    const shown = simulatedId === null ? base : simulateAccepted(base, simulatedId);
    return withWorldBadges(shown, worldVerified);
  }, [beforeUpdate, simulatedId, recorded, worldVerified]);

  const names = useMemo(() => ensNames(nodes, harness), [nodes, harness]);
  // The version names are read from ENS for the trees that are on chain.
  const onChain = harness !== undefined && ONCHAIN_TREES.includes(harness);
  // Every version's record, read from its ENS name. A showcase tree is never looked up.
  const ens = useEnsRecords([...names.values()], onChain);

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

  // The demo vote is in: the demo version stays accepted, on every load, until its × is pressed.
  useEffect(() => {
    if (DEMO_PENDING === "") return;
    void fetch("/api/market/demo-verify", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ round?: { id: string; vote?: string; closed?: boolean; human?: string } | null }>)
      .then((d) => {
        if (d.round?.human === "world") setWorldVerified(d.round.id);
        if (d.round?.id.startsWith(DEMO_PENDING) && d.round.closed && d.round.vote?.startsWith("yes")) {
          setBeforeUpdate(false);
          setSimulatedId(d.round.id);
        }
      })
      .catch(() => {});
    // STAGE DEMO. A yes vote on chain shows the demo version accepted, the same
    // simulation the Space key does, even when the saved tree still has 1 of 2 keys.
    const onVoted = (e: Event) => {
      setBeforeUpdate(false);
      const id = (e as CustomEvent<string>).detail;
      if (id) setSimulatedId(id);
    };
    window.addEventListener("petri:voted", onVoted);
    return () => window.removeEventListener("petri:voted", onVoted);
  }, []);
  const demoNode = DEMO_PENDING === "" ? undefined : recorded.find((n) => n.id.startsWith(DEMO_PENDING));
  const undo = !beforeUpdate && demoNode ? {
    id: demoNode.id,
    run: () => {
      setBeforeUpdate(true);
      setSimulatedId(null);
      setWorldVerified(null);
      void fetch("/api/market/demo-verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ step: "reset" }) });
      window.dispatchEvent(new CustomEvent("petri:demo-reset"));
    },
  } : null;

  const node = nodes.find((n) => n.id === selected) ?? nodes[0]!;
  // The status on screen is a stage-demo override, not the record, so the panel
  // does not call the ENS copy stale.
  const staged = simulatedId === node.id
    || (beforeUpdate && DEMO_PENDING.length > 0 && node.id.startsWith(DEMO_PENDING)
      && recorded.find((n) => n.id === node.id)?.status === "accepted");
  const shared = { forest, nodes, selected: node.id, onSelect: setSelected, benchTotal, minVerifications, harness };
  // An accepted version of the real tree can be bought. It gets a Buy tab.
  const name = names.get(node.id)!;
  const buy: PanelDef | null = harness === REAL_TREE && name.split(".")[1] === "accepted"
    ? { id: "buy", label: "Buy", hint: "1 USDC, then the files", content: <BuyTab key={node.id} id={node.id} name={name} /> }
    : null;
  const scored = !isBlocked(node);
  const leads: PanelDef[] = [
    { id: "propose", label: "Propose", hint: "branch from this version",
      content: <ProposeTab key={node.id} parentId={node.id} name={name} /> },
    { id: "verify", label: "Verify", hint: "re-run it with your key",
      content: <VerifyTab key={node.id} versionId={node.id} name={name} scored={scored} status={node.status} verifications={node.verifications} reason={node.statusReason} /> },
    ...(buy ? [buy] : []),
  ];

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
              <span><svg width="14" height="14" aria-hidden="true"><WorldTick real cx={7} cy={7} /></svg>A World ID human submitted it · <svg width="14" height="14" aria-hidden="true"><WorldTick real={false} cx={7} cy={7} /></svg>example badge</span>
              <span className="legend-trade">
                <svg width="12" height="12" aria-hidden="true"><TradeIcon kind="perf" x={6} y={6} /></svg>performance
                <svg width="12" height="12" aria-hidden="true"><TradeIcon kind="tokens" x={6} y={6} /></svg>token savings
                <svg width="12" height="12" aria-hidden="true"><TradeIcon kind="speed" x={6} y={6} /></svg>speed · against the parent, + is better
              </span>
            </div>
            <LineageHero {...shared} layoutNodes={recorded} undo={undo} />
            <TreeView {...shared} />
          </div>

          <div className={`selected-strip s-${node.status}`} aria-live="polite">
            <svg width="14" height="14" aria-hidden="true"><Glyph status={node.status} cx={7} cy={7} r={5} /></svg>
            <span className="sel-word" title={node.id}>{wordOf(node)} · {names.get(node.id)}</span>
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
          ens={{ state: ens.state, lookup: ens.byName.get(names.get(node.id)!) }} staged={staged} />
        <div className="record-info"><Panels panels={panels} leads={leads} /></div>
      </section>
    </>
  );
}
