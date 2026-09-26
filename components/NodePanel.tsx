"use client";

import { useState } from "react";
import { OBJECTIVES } from "@/lib/catalog";
import { isBlocked, wordOf } from "@/lib/format";
import { ensNames } from "@/lib/ens/name";
import { ALL_RECORD_KEYS, RECORD_KEYS, VERDICT_KEYS, nodeRecords, readRecords, type EnsLookup, type RecordKey } from "@/lib/ens/records";
import { explorerAddress } from "@/app/ens/_lib/ens/contracts";
import type { ExportNode } from "@/lib/types";
import { Glyph } from "./Glyph";
import type { EnsState } from "./useEnsRecords";

interface Props {
  node: ExportNode;
  nodes: ExportNode[];
  minVerifications: number;
  /** Names the root in ENS-style names. */
  harness?: string;
  benchTotal: number;
  /** This version's ENS lookup. Absent, or "off", on a showcase tree. */
  ens?: { state: EnsState; lookup?: EnsLookup };
  /** The status on screen is a stage-demo override, so ENS is not called stale. */
  staged?: boolean;
  onSelect: (id: string) => void;
  /** Called when the verify command is copied. See TreeWorkspace. */
  onVerifyCopied?: () => void;
}

/** One text record as the panel lists it. `local` is set when the log has moved on since publishing. */
interface Row { key: RecordKey; value: string; local: string | null }

/** "0x1234…abcd". */
const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The version as ENS stores it: its name, the resolver that serves it, and
 * every text record on it. When the name holds this version's record, the
 * values are the resolver's. Until then they are the records `npm run
 * ens:publish` writes, built from the local log.
 */
export function NodePanel({ node, nodes, harness, minVerifications, benchTotal, ens, staged = false, onSelect, onVerifyCopied }: Props) {
  const p = node.detail.proposal;
  const names = ensNames(nodes, harness);
  const name = names.get(node.id)!;
  const lookup = ens?.lookup && !ens.lookup.error ? ens.lookup : undefined;
  const read = lookup ? readRecords(lookup.texts) : null;
  // A name that holds another version's record (the tree changed after publishing) is not this version's.
  const onEns = read !== null && read.id === node.id;
  const local = nodeRecords(node, nodes, benchTotal, minVerifications);

  const rows: Row[] = ALL_RECORD_KEYS.map((key) => {
    // A stage-demo status is listed as the tree draws it, not as ENS holds it.
    if (!onEns || (staged && VERDICT_KEYS.includes(key))) return { key, value: local[key], local: null };
    const value = lookup!.texts[key] ?? "";
    return { key, value, local: value === local[key] ? null : local[key] };
  });
  const set = rows.filter((r) => r.value !== "").length;
  const changed = rows.filter((r) => r.local !== null).length;
  const parentId = rows.find((r) => r.key === RECORD_KEYS.parent)!.value;
  const parent = parentId ? nodes.find((n) => n.id === parentId) : undefined;

  return (
    <aside className="node-panel" aria-live="polite">
      <div className="np-head">
        <svg width="14" height="14" aria-hidden="true"><Glyph status={node.status} cx={7} cy={7} r={5} /></svg>
        <p className="eyebrow">{wordOf(node)} · {node.short}</p>
      </div>

      <section className="ens-profile" aria-label={`ENS records of ${name}`}>
        <div>
          <p className="ens-kicker">ENS name · Sepolia</p>
          <h2 className="ens-name np-ens">{name}</h2>
          <p className="ens-resolver">
            {lookup?.resolver
              ? <>Resolver <a href={explorerAddress(lookup.resolver)} target="_blank" rel="noreferrer" title={lookup.resolver}>{shortAddress(lookup.resolver)}</a></>
              : "No resolver on this name yet"}
          </p>
        </div>

        <RecordSource state={ens?.state ?? "off"} lookup={ens?.lookup} onEns={onEns} foreign={read !== null && !onEns ? read.id : null} changed={changed} />

        <div className="np-block">
          <h3>Text records · {set} of {rows.length} set</h3>
          <dl className="ens-records">
            {rows.map((r) => (
              <div key={r.key} className={r.local !== null ? "ens-row changed" : "ens-row"}>
                <dt>{r.key}</dt>
                <dd>
                  {r.value === "" ? <span className="ens-unset">not set</span> : <span>{r.value}</span>}
                  {r.key === RECORD_KEYS.parent && parent && (
                    <button type="button" className="ens-link" onClick={() => onSelect(parent.id)}>{names.get(parent.id)} ↑</button>
                  )}
                  {r.local !== null && <span className="ens-local">Local log: {r.local === "" ? "not set" : r.local}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <Fork parentId={node.short} area={p.primaryArea} />

      <CheckIt short={node.short} scored={!isBlocked(node)} onVerifyCopied={onVerifyCopied} />

      {node.diff.trim() && (
        <details className="np-block diff">
          <summary>Show the change</summary>
          <pre>{node.diff}</pre>
        </details>
      )}
    </aside>
  );
}

/** Where the listed values come from. */
function RecordSource({ state, lookup, onEns, foreign, changed }: {
  state: EnsState; lookup?: EnsLookup; onEns: boolean; foreign: string | null; changed: number;
}) {
  const publishes = <>These are the records <code>npm run ens:publish</code> writes to this name.</>;
  if (onEns) {
    return (
      <p className="ens-state on">
        Read from the resolver.
        {changed > 0 && <> {changed} {changed === 1 ? "record has" : "records have"} changed in the local log since publishing. Run <code>npm run ens:publish</code> to update {changed === 1 ? "it" : "them"}.</>}
      </p>
    );
  }
  if (state === "off") return <p className="ens-state">A showcase tree is not published. These are the records its name would hold.</p>;
  if (lookup?.error || (!lookup && state === "error")) return <p className="ens-state" title={lookup?.error}>ENS did not answer. {publishes}</p>;
  if (!lookup) return <p className="ens-state">Reading the resolver… {publishes}</p>;
  if (foreign) return <p className="ens-state">This name holds another version&apos;s record (petri.id {foreign.slice(0, 8)}). {publishes}</p>;
  return <p className="ens-state">Not on ENS yet. {publishes}</p>;
}

/** Branch from this version toward your own direction. Prints the real CLI command. */
/** The commands anyone can run, in the order the demo follows. */
const CHECK_STEPS = (short: string, scored: boolean): { what: string; why: string; cmds: string[] }[] => [
  {
    what: "How it works",
    why: "The record every agent reads before it proposes a change: what won, what failed, and why.",
    cmds: ["pnpm petri digest"],
  },
  {
    what: "Run it",
    why: scored
      ? "The harness reads a task, the model writes the code, the tests run in the sandbox. 3 tasks by default, and nothing is signed."
      : "This version has no recorded answers, so it runs only against a real model. It needs ANTHROPIC_API_KEY.",
    cmds: [scored ? `pnpm petri run ${short}` : `ANTHROPIC_API_KEY=... pnpm petri run ${short} --mode live`],
  },
  {
    what: "Evals",
    why: scored
      ? "The whole benchmark, 5 times: every task passed or failed, and the median score."
      : "The whole benchmark, 5 times, against a real model. Replay cannot score this version.",
    cmds: [scored ? `pnpm petri evals ${short}` : `ANTHROPIC_API_KEY=... pnpm petri evals ${short} --mode live`],
  },
  {
    what: "Verify it",
    why: scored
      ? "Your key re-runs this version and its parent, then signs the result. The author's own key is refused."
      : "A version with no score cannot be verified. Score it live first, then another key signs it.",
    cmds: [
      "PETRI_HOME=~/my-verifier pnpm petri id create --label me",
      `PETRI_HOME=~/my-verifier pnpm petri verify ${short} --show`,
    ],
  },
  {
    what: "Check the record",
    why: "Every signature and the hash chain of the log.",
    cmds: ["pnpm petri fsck"],
  },
];

function CheckIt({ short, scored, onVerifyCopied }: { short: string; scored: boolean; onVerifyCopied?: () => void }) {
  const [copied, setCopied] = useState("");
  const steps = CHECK_STEPS(short, scored);
  return (
    <div className="np-block checkit">
      <h3>Check it yourself</h3>
      <p className="muted">Clone the repo, then run these from the repository root. Nothing here needs an API key.</p>
      <ol className="checkit-steps">
        {steps.map((s) => (
          <li key={s.what}>
            <p className="checkit-what">{s.what}</p>
            <p className="muted">{s.why}</p>
            {s.cmds.map((cmd) => (
              <div className="checkit-cmd" key={cmd}>
                <code>{cmd}</code>
                <button type="button" className="btn btn-sm" onClick={() => {
                  void navigator.clipboard?.writeText(cmd);
                  setCopied(cmd);
                  if (cmd.includes("petri verify")) onVerifyCopied?.();
                }}>
                  {copied === cmd ? "Copied" : "Copy"}
                </button>
              </div>
            ))}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Fork({ parentId, area }: { parentId: string; area: string }) {
  const [direction, setDirection] = useState(OBJECTIVES[0]!);
  const [copied, setCopied] = useState(false);
  const motif = direction.replace(/\s+/g, "-");
  const cmd = `pnpm petri propose --parent ${parentId} --area ${area} --motif ${motif} \\\n  --hypothesis "This change improves ${direction}, because ..."`;
  return (
    <div className="np-block fork">
      <h3>Fork this version</h3>
      <p className="muted">Copy it, change one idea toward your own goal, and submit it. Your fork becomes a new branch.</p>
      <label className="fork-row" htmlFor={`fork-dir-${parentId}`}>
        <span>Direction</span>
        <select id={`fork-dir-${parentId}`} value={direction} onChange={(e) => { setDirection(e.target.value); setCopied(false); }}>
          {OBJECTIVES.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </label>
      <pre className="fork-cmd">{cmd}</pre>
      <button type="button" className="btn btn-sm" onClick={() => { void navigator.clipboard?.writeText(cmd); setCopied(true); }}>
        {copied ? "Copied" : "Copy command"}
      </button>
    </div>
  );
}
