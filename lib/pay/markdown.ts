import type { ExportNode } from "../types";

/**
 * A Petri version as a markdown file: what an agent reads before it builds on
 * that version. Pure. The seller route (app/api/versions/[versionId]/markdown)
 * sells it over x402, and lib/pay/markdown-source.ts reads the facts.
 */

export type VersionFacts = {
  id: string;
  label: string;
  ensName: string | null;
  parent: string;
  author: string;
  status: string;
  statusCode: string;
  statusReason: string;
  verifiedDeltaBp: number | null;
  hypothesis: string;
  falsifiedIf: string;
  area: string;
  motif: string;
  /** One row per key. counted is the acceptance rule's answer, or null when it is not known. */
  reports: { runner: string; deltaMedianBp: number; counted: boolean | null; repeats: number }[];
  diff: string;
  /** live: `petri show` on the engine. snapshot: the saved export, which may be behind the log. */
  source: "live" | "snapshot";
};

/** Groups reports by key: the first report's delta, counted if any report of that key counted, and the repeats. */
function byKey(reports: { runner: string; deltaMedianBp: number; counted: boolean | null }[]): VersionFacts["reports"] {
  const rows = new Map<string, VersionFacts["reports"][number]>();
  for (const r of reports) {
    const row = rows.get(r.runner);
    if (!row) rows.set(r.runner, { ...r, repeats: 0 });
    else {
      row.repeats++;
      if (r.counted) row.counted = true;
    }
  }
  return [...rows.values()];
}

export function factsFromExport(n: ExportNode, ensName: string | null, source: VersionFacts["source"]): VersionFacts {
  return {
    id: n.id,
    label: n.label,
    ensName,
    parent: n.parent,
    author: n.author,
    status: n.status,
    statusCode: n.statusCode,
    statusReason: n.statusReason,
    verifiedDeltaBp: n.verifiedDeltaBp,
    hypothesis: n.hypothesis,
    falsifiedIf: n.detail.proposal.falsifiedIf,
    area: n.detail.proposal.primaryArea,
    motif: n.detail.proposal.motif,
    reports: byKey(n.verifications.map((v) => ({ runner: v.runner, deltaMedianBp: v.deltaMedianBp, counted: v.counted }))),
    diff: n.diff,
    source,
  };
}

/** The node from `petri --json show <id> --diff`. */
export type ShowNode = {
  id: string;
  manifest: { parent: string; author: string };
  detail: { proposal: { hypothesis: string; falsifiedIf: string; primaryArea: string; motif: string } };
  status: string;
  statusCode: string;
  statusReason: string;
  verifiedDeltaBp: number | null;
  verifications: { pub: string; body: { runner: string; deltaMedianBp: number } }[];
  diff?: string;
};

/**
 * `countedKeys` comes from `petri status`: the keys the acceptance rule actually
 * counted. It also drops reports with too few runs, a bad signature or the wrong
 * parent, which a rule recomputed here would miss. Null when status failed.
 */
export function factsFromShow(n: ShowNode, label: string, ensName: string | null, countedKeys: string[] | null): VersionFacts {
  const counted = countedKeys ? new Set(countedKeys) : null;
  const reports = byKey(
    n.verifications.map((v) => ({ runner: v.body.runner, deltaMedianBp: v.body.deltaMedianBp, counted: counted ? counted.has(v.body.runner) : null })),
  );
  return {
    id: n.id,
    label,
    ensName,
    parent: n.manifest.parent,
    author: n.manifest.author,
    status: n.status,
    statusCode: n.statusCode,
    statusReason: n.statusReason,
    verifiedDeltaBp: n.verifiedDeltaBp,
    hypothesis: n.detail.proposal.hypothesis,
    falsifiedIf: n.detail.proposal.falsifiedIf,
    area: n.detail.proposal.primaryArea,
    motif: n.detail.proposal.motif,
    reports,
    diff: n.diff ?? "",
    source: "live",
  };
}

const bp = (v: number | null) => (v === null ? "not measured yet" : `${v > 0 ? "+" : ""}${v} bp`);
const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
const firstSentence = (t: string) => oneLine(t).split(/(?<=\.)\s/)[0];

/** "harness/prompt.ts (+3 −16)" for each file in a unified diff. */
export function diffSummary(diff: string): string {
  const files: { path: string; add: number; del: number }[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) files.push({ path: line.slice(4).replace(/^b\//, ""), add: 0, del: 0 });
    else if (line.startsWith("--- ") || !files.length) continue;
    else if (line.startsWith("+")) files[files.length - 1].add++;
    else if (line.startsWith("-")) files[files.length - 1].del++;
  }
  return files.length ? files.map((f) => `${f.path} (+${f.add} −${f.del})`).join(", ") : "no file change";
}

/** About ten lines: the facts an agent needs before it builds on this version. */
export function renderMarkdown(f: VersionFacts, at: number): string {
  const reruns = f.reports.length
    ? f.reports
        .map((r) => {
          const note = [
            r.counted === false ? "not counted" : r.counted === null ? "count unknown" : "",
            r.repeats ? `+${r.repeats} repeat report${r.repeats === 1 ? "" : "s"}, not counted` : "",
          ].filter(Boolean);
          return `${r.runner.slice(0, 8)} ${bp(r.deltaMedianBp)}${note.length ? ` (${note.join("; ")})` : ""}`;
        })
        .join(", ")
    : "none yet (needs 2 keys)";
  return [
    `# Petri version ${f.id.slice(0, 8)}${f.label ? ` (${f.label})` : ""}`,
    "",
    `- **Hypothesis:** ${oneLine(f.hypothesis)}`,
    `- **Status:** ${f.status} (${f.statusCode}). ${firstSentence(f.statusReason)}`,
    `- **Verified change:** ${bp(f.verifiedDeltaBp)} (100 bp = 1% of the tasks)`,
    `- **Proven wrong if:** ${oneLine(f.falsifiedIf)}`,
    `- **Re-runs by other keys:** ${reruns}`,
    `- **Changed:** ${diffSummary(f.diff)} · ${f.area} · ${f.motif}`,
    `- **Parent:** ${f.parent === "root" ? "root" : f.parent.slice(0, 8)} · **Author key:** ${f.author.slice(0, 8)}`,
    ...(f.ensName ? [`- **ENS:** ${f.ensName}`] : []),
    `- **Id:** ${f.id}`,
    "",
    `Read from the ${f.source === "live" ? "live Petri log" : "saved snapshot (may be behind the log)"} at ${new Date(at).toISOString()}. Bought over x402; Intercepta screened the payment.`,
    "",
  ].join("\n");
}
