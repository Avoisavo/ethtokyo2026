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
  reports: { runner: string; deltaMedianBp: number; counted: boolean }[];
  diff: string;
  /** live: `petri show` on the engine. snapshot: the saved export, which may be behind the log. */
  source: "live" | "snapshot";
};

export function factsFromExport(n: ExportNode, ensName: string | null): VersionFacts {
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
    reports: n.verifications.map((v) => ({ runner: v.runner, deltaMedianBp: v.deltaMedianBp, counted: v.counted })),
    diff: n.diff,
    source: "snapshot",
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

export function factsFromShow(n: ShowNode, label: string, ensName: string | null): VersionFacts {
  // The acceptance rule counts one report per key and never the author's. `petri show` lists raw reports.
  const seen = new Set<string>();
  const reports = n.verifications.map((v) => {
    const counted = v.body.runner !== n.manifest.author && !seen.has(v.body.runner);
    seen.add(v.body.runner);
    return { runner: v.body.runner, deltaMedianBp: v.body.deltaMedianBp, counted };
  });
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
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(f: VersionFacts, at: number): string {
  const short = f.id.slice(0, 8);
  const lines = [
    `# Petri version ${short}${f.label ? ` (${f.label})` : ""}`,
    "",
    `> ${f.hypothesis.replace(/\n/g, "\n> ")}`,
    "",
    "| | |",
    "|---|---|",
    `| Version | \`${f.id}\` |`,
    ...(f.ensName ? [`| ENS name | \`${f.ensName}\` |`] : []),
    `| Parent | \`${f.parent === "root" ? "root" : f.parent.slice(0, 8)}\` |`,
    `| Author key | \`${f.author.slice(0, 16)}…\` |`,
    `| Status | **${f.status}** (${cell(f.statusCode)}) |`,
    `| Why | ${cell(f.statusReason)} |`,
    `| Verified change | ${bp(f.verifiedDeltaBp)} (100 bp = 1% of the tasks) |`,
    `| Area · motif | ${cell(f.area)} · ${cell(f.motif)} |`,
    `| Proven wrong if | ${cell(f.falsifiedIf)} |`,
    "",
    "## Re-runs by independent keys",
    "",
  ];
  if (f.reports.length === 0) {
    lines.push("No key has re-run this version yet. It needs 2 before it is accepted or rejected.");
  } else {
    lines.push("| Key | Measured change | Counted |", "|---|---|---|");
    for (const r of f.reports) lines.push(`| \`${r.runner.slice(0, 16)}…\` | ${bp(r.deltaMedianBp)} | ${r.counted ? "yes" : "no (author or repeat key)"} |`);
  }
  lines.push("", "## The change to the harness", "");
  // A fence longer than any backtick run in the diff, so the diff cannot close it.
  const fence = "`".repeat(Math.max(3, ...[...f.diff.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  lines.push(f.diff.trim() ? `${fence}diff\n${f.diff.trimEnd()}\n${fence}` : "This version records no file change.");
  lines.push(
    "",
    "---",
    "",
    `Read from the ${f.source === "live" ? "live Petri log" : "saved tree snapshot, which may be behind the live log"} at ${new Date(at).toISOString()}.`,
    "Sold over x402 in USDC on Sepolia. Intercepta screened the payment before it was signed and before it was accepted.",
    "",
  );
  return lines.join("\n");
}
