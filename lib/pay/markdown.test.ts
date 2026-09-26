import assert from "node:assert/strict";
import { test } from "node:test";

import { ensNames } from "../ens/name";
import snapshot from "../snapshot/petri-export.json";
import type { PetriExport } from "../types";
import { diffSummary, factsFromExport, factsFromShow, renderMarkdown, type ShowNode } from "./markdown";

const data = snapshot as unknown as PetriExport;

test("renderMarkdown: every version in the snapshot renders with its facts", () => {
  const names = ensNames(data.nodes, "petri-harness-v1");
  for (const n of data.nodes) {
    const md = renderMarkdown(factsFromExport(n, names.get(n.id) ?? null, "snapshot"), 0);
    assert.ok(md.startsWith(`# Petri version ${n.id.slice(0, 8)}`), n.short);
    assert.ok(md.includes(n.id), `${n.short}: the full id`);
    assert.ok(md.includes(`**Status:** ${n.status}`), `${n.short}: the status`);
    assert.ok(md.includes("saved snapshot"), "a snapshot file says it may be behind");
    assert.ok(md.trim().split("\n").length <= 14, `${n.short}: about ten lines`);
  }
});

test("factsFromShow: one row per key, counted from the acceptance rule, repeats noted", () => {
  const node: ShowNode = {
    id: "e1adae18".padEnd(64, "0"),
    manifest: { parent: "ecc7cdb0".padEnd(64, "0"), author: "a".repeat(64) },
    detail: { proposal: { hypothesis: "h", falsifiedIf: "f", primaryArea: "prompt", motif: "short-prompt" } },
    status: "rejected",
    statusCode: "REGRESSION",
    statusReason: "r",
    verifiedDeltaBp: -7000,
    verifications: [
      { pub: "b", body: { runner: "b".repeat(64), deltaMedianBp: -7000 } },
      { pub: "b", body: { runner: "b".repeat(64), deltaMedianBp: -7000 } },
      { pub: "a", body: { runner: "a".repeat(64), deltaMedianBp: 100 } },
      { pub: "c", body: { runner: "c".repeat(64), deltaMedianBp: -7000 } },
    ],
    diff: "--- a\n+++ b\n+x",
  };
  // The rule counted b and c: never the author a, and b only once.
  const f = factsFromShow(node, "n028", null, ["b".repeat(64), "c".repeat(64)]);
  assert.deepEqual(f.reports.map((r) => [r.runner[0], r.counted, r.repeats]), [["b", true, 1], ["a", false, 0], ["c", true, 0]]);
  const md = renderMarkdown(f, 0);
  assert.ok(md.includes("live Petri log"));
  assert.ok(md.includes("bbbbbbbb -7000 bp (+1 repeat report, not counted), aaaaaaaa +100 bp (not counted), cccccccc -7000 bp"));
  assert.ok(renderMarkdown(factsFromShow(node, "n028", null, null), 0).includes("count unknown"));
  assert.ok(md.includes("**Changed:** b (+1 −0)"));
});

test("diffSummary: files and line counts from a unified diff", () => {
  const diff = "--- a/harness/prompt.ts\n+++ b/harness/prompt.ts\n@@ -1,3 +1,2 @@\n-a\n-b\n+c\n same\n--- a/x.ts\n+++ b/x.ts\n+y\n";
  assert.equal(diffSummary(diff), "harness/prompt.ts (+1 −2), x.ts (+1 −0)");
  assert.equal(diffSummary(""), "no file change");
});
