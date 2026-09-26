/**
 * The document set of a version: the harness files it ships, plus a short
 * `harness.md` that maps them to the nine parts of a harness. Read from the
 * engine's object store under petri/.petri. Server only.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { PETRI_ROOT } from "../tree";

/** The nine parts of a harness, and the file that holds each one in this tree. */
export const PARTS: { part: string; what: string; file: string }[] = [
  { part: "Instructions", what: "Who the AI is and the rules it follows.", file: "harness/prompt.ts" },
  { part: "Tools", what: "What the AI reads: the task, the starter files and the symbols it must export.", file: "harness/retrieval.ts" },
  { part: "The loop", what: "Ask the model, run what it asks for, give the result back, repeat.", file: "harness/loop.ts" },
  { part: "Context management", what: "What goes into the prompt, and what is cut when it is too long.", file: "harness/prompt.ts" },
  { part: "Memory", what: "What the harness keeps between steps of one task.", file: "harness/loop.ts" },
  { part: "Recovery", what: "What it does after an empty or bad answer.", file: "harness/recovery.ts" },
  { part: "Limits", what: "The most calls, tokens and time it may spend.", file: "harness/contract.ts" },
  { part: "Output checking", what: "How it takes the code out of the answer.", file: "harness/loop.ts" },
  { part: "Logging", what: "The record of every step, kept by the engine outside the harness.", file: "harness/index.ts" },
];

const shard = (id: string) => [id.slice(0, 2), id.slice(2)] as const;

/** The harness snapshot id of a version, from its manifest. */
export function harnessIdOf(nodeId: string): string {
  const [aa, rest] = shard(nodeId);
  const file = path.join(PETRI_ROOT, ".petri", "nodes", aa, rest, "manifest.json");
  if (!existsSync(file)) throw new Error(`No manifest for version ${nodeId.slice(0, 8)} at ${file}`);
  return (JSON.parse(readFileSync(file, "utf8")) as { harness: string }).harness;
}

/** The files of a harness snapshot, by path. */
export function harnessFiles(harnessId: string): Record<string, string> {
  const [aa, rest] = shard(harnessId);
  const file = path.join(PETRI_ROOT, ".petri", "objects", aa, `${rest}.json`);
  if (!existsSync(file)) throw new Error(`No harness object ${harnessId.slice(0, 8)} at ${file}`);
  return (JSON.parse(readFileSync(file, "utf8")) as { files: Record<string, string> }).files;
}

/**
 * The document set of a version: `harness.md` first, then each file under its
 * bare name (`prompt.ts`). Any markdown the snapshot holds is kept as well.
 */
export function versionDocs(nodeId: string, hypothesis: string): Record<string, string> {
  const files = harnessFiles(harnessIdOf(nodeId));
  const docs: Record<string, string> = {};
  const lines = [
    `# Harness of version ${nodeId.slice(0, 8)}`,
    "",
    hypothesis,
    "",
    "| Part | What it does | File |",
    "|---|---|---|",
    ...PARTS.map((p) => `| ${p.part} | ${p.what} | \`${path.basename(p.file)}\` |`),
    "",
    `Files: ${Object.keys(files).map((f) => `\`${path.basename(f)}\``).join(", ")}.`,
    "",
  ];
  docs["harness.md"] = lines.join("\n");
  for (const [p, text] of Object.entries(files)) docs[path.basename(p)] = text;
  return docs;
}
