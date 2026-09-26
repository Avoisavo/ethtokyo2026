import assert from "node:assert/strict";
import { test } from "node:test";

import snapshot from "../snapshot/petri-export.json";
import type { PetriExport } from "../types";
import { parseNamesParam } from "./resolve";
import { ENS_SUFFIX, REAL_TREE, ensNames, treeName } from "./name";

const TREE_NAME = treeName(REAL_TREE);
import { ALL_RECORD_KEYS, RECORD_KEYS, changedKeys, nodeRecords, readRecords, treePlan } from "./records";

const data = snapshot as unknown as PetriExport;
const HARNESS = REAL_TREE;
const records = (id: string) =>
  nodeRecords(data.nodes.find((n) => n.id === id)!, data.nodes, data.bench.total, data.policy.minVerifications);

test("nodeRecords → readRecords round-trips every node in the snapshot", () => {
  for (const n of data.nodes) {
    const r = records(n.id);
    assert.deepEqual(Object.keys(r), ALL_RECORD_KEYS, `${n.short}: every key, in write order`);
    const v = readRecords(r)!;
    assert.equal(v.id, n.id);
    assert.equal(v.hypothesis, n.hypothesis);
    assert.equal(v.parent, n.parent === "root" ? "" : n.parent);
    assert.equal(v.verifiers.length, Math.min(2, n.verifications.filter((x) => x.counted).length));
  }
});

test("an accepted version names its two verifiers and its delta", () => {
  const accepted = data.nodes.find((n) => n.status === "accepted")!;
  const r = records(accepted.id);
  assert.equal(r[RECORD_KEYS.status], "accepted");
  assert.match(r[RECORD_KEYS.delta], /^\+\d+bp$/);
  assert.match(r[RECORD_KEYS.score], /^\d+\/\d+$/);
  assert.match(r[RECORD_KEYS.verifier1], /^0x[0-9a-f]{64}$/);
  assert.match(r[RECORD_KEYS.verifier2], /^0x[0-9a-f]{64}$/);
  assert.notEqual(r[RECORD_KEYS.verifier1], r[RECORD_KEYS.verifier2]);
});

test("the root is the baseline: no parent, no delta", () => {
  const root = data.nodes.find((n) => n.parent === "root")!;
  const r = records(root.id);
  assert.equal(r[RECORD_KEYS.status], "baseline");
  assert.equal(r[RECORD_KEYS.parent], "");
  assert.equal(r[RECORD_KEYS.delta], "");
  assert.equal(readRecords(r)!.status, "baseline");
});

test("readRecords returns null without petri.id and falls back on bad values", () => {
  assert.equal(readRecords({}), null);
  assert.equal(readRecords({ [RECORD_KEYS.id]: "   ", [RECORD_KEYS.status]: "accepted" }), null);
  const v = readRecords({ [RECORD_KEYS.id]: "abc", [RECORD_KEYS.status]: "bogus" })!;
  assert.equal(v.status, "pending");
  assert.deepEqual(v.verifiers, []);
});

test("changedKeys lists only the keys that differ; an unset record equals empty", () => {
  const r = records(data.nodes[0].id);
  assert.deepEqual(changedKeys(r, r), []);
  assert.deepEqual(changedKeys(r, { ...r, [RECORD_KEYS.status]: "rejected" }), [RECORD_KEYS.status]);
  assert.deepEqual(changedKeys({ a: "" }, {}), []);
});

test("treePlan names every version once, the same names the page shows", () => {
  const plan = treePlan(data, HARNESS);
  const names = ensNames(data.nodes, HARNESS);
  assert.equal(plan.suffix, ENS_SUFFIX);
  assert.equal(plan.names.length, data.nodes.length);
  assert.equal(new Set(plan.names.map((p) => p.name)).size, plan.names.length, "names are unique");
  for (const p of plan.names) {
    assert.equal(p.name, names.get(p.id));
    assert.equal(p.records[RECORD_KEYS.id], p.id);
  }
  assert.equal(plan.names[0].name, `v1.accepted.${TREE_NAME}`);
});

test("parseNamesParam accepts names under petri.eth only", () => {
  assert.deepEqual(parseNamesParam("petri.eth"), { ok: true, names: ["petri.eth"] });
  assert.deepEqual(
    parseNamesParam(` v2.accepted.${TREE_NAME}, v1.accepted.${TREE_NAME},,V2.accepted.${TREE_NAME} `),
    { ok: true, names: [`v2.accepted.${TREE_NAME}`, `v1.accepted.${TREE_NAME}`] },
  );
  assert.equal(parseNamesParam("vitalik.eth").ok, false);
  assert.equal(parseNamesParam("").ok, false);
});
