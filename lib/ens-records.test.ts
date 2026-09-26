import assert from "node:assert/strict";
import { test } from "node:test";

import { type Hex, decodeFunctionData, encodeErrorResult, encodeFunctionResult } from "viem";

import { UniversalResolverV2Abi } from "../app/ens/_lib/ens/abis/UniversalResolverV2";
import { dnsEncode } from "../app/ens/_lib/ens/names";
import { resolverProfileAbi } from "../app/ens/_lib/ens/universal-resolver-v2";
import { ENS_SUFFIX, ensNames } from "./ens-name";
import {
  ALL_RECORD_KEYS, RECORD_KEYS, changedKeys, displayScore, nodeRecords, parseChecks, readRecords, treePlan,
} from "./ens-records";
import { parseNamesParam, resolveRecords } from "./ens-resolve";
import { isBlocked, isRoot, rootRerunBp } from "./format";
import snapshot from "./snapshot/petri-export.json";
import type { PetriExport } from "./types";

const data = snapshot as unknown as PetriExport;
const HARNESS = "petri-harness-v1";
const records = (id: string) =>
  nodeRecords(data.nodes.find((n) => n.id === id)!, data.nodes, data.bench.total, data.policy.minVerifications);

test("nodeRecords → readRecords round-trips every node in the snapshot", () => {
  assert.ok(data.nodes.length > 0);
  const ids = new Set(data.nodes.map((n) => n.id));
  for (const n of data.nodes) {
    const r = nodeRecords(n, data.nodes, data.bench.total, data.policy.minVerifications);
    assert.deepEqual(Object.keys(r), ALL_RECORD_KEYS, `${n.short}: every key, in write order`);
    const v = readRecords(r);
    assert.ok(v, `${n.short}: has a record`);
    assert.equal(v.id, n.id);
    assert.equal(v.parent, isRoot(n, ids) ? "" : n.parent);
    assert.equal(v.status, n.status);
    assert.equal(v.verdict, n.statusCode);
    assert.equal(v.hypothesis, n.hypothesis.trim());
    assert.equal(v.scoreBp, displayScore(n, data.nodes).bp);
    assert.equal(v.scoreSource, displayScore(n, data.nodes).source);
    assert.equal(v.deltaBp, n.verifiedDeltaBp);
    assert.equal(v.keys, n.verifications.filter((x) => x.counted).length);
    assert.equal(v.minKeys, data.policy.minVerifications);
    assert.equal(v.bench, data.bench.total);
    assert.equal(v.tokensPerTask, n.costs.tokensPerTask);
    assert.equal(v.blocked, isBlocked(n) ? n.detail.mechanical!.cls : "");
    assert.deepEqual(
      v.checks,
      n.verifications.map((x) => ({
        key: x.runnerLabel || x.runner.slice(0, 8),
        counted: x.counted,
        deltaBp: x.deltaMedianBp,
        parentBp: x.parent.medianBp,
        candidateBp: x.candidate.medianBp,
        runs: x.runs,
        why: x.counted ? "" : x.ignoredWhy,
      })),
    );
  }
});

test("an ignored check keeps its reason; a node with no checks stores none", () => {
  const withIgnored = data.nodes.find((n) => n.verifications.some((v) => !v.counted));
  assert.ok(withIgnored, "the snapshot has an ignored check");
  const v = readRecords(records(withIgnored.id))!;
  assert.ok(v.checks.some((c) => !c.counted && c.why.length > 0));
  const unchecked = data.nodes.find((n) => n.verifications.length === 0)!;
  assert.equal(records(unchecked.id)[RECORD_KEYS.checks], "");
  assert.deepEqual(readRecords(records(unchecked.id))!.checks, []);
});

test("score source: predicted for a blocked node, rerun for the root once a child was checked", () => {
  const blocked = data.nodes.find(isBlocked);
  assert.ok(blocked, "the snapshot has a blocked node");
  assert.equal(records(blocked.id)[RECORD_KEYS.scoreSource], "predicted");
  assert.equal(readRecords(records(blocked.id))!.scoreSource, "predicted");

  const ids = new Set(data.nodes.map((n) => n.id));
  const root = data.nodes.find((n) => isRoot(n, ids))!;
  const rerun = rootRerunBp(root, data.nodes);
  assert.notEqual(rerun, null, "a child of the root was checked");
  const r = readRecords(records(root.id))!;
  assert.equal(r.scoreSource, "rerun");
  assert.equal(r.scoreBp, rerun);
  assert.equal(r.parent, "");
});

test("readRecords returns null without petri.id and falls back on bad values", () => {
  assert.equal(readRecords({}), null);
  assert.equal(readRecords({ [RECORD_KEYS.id]: "   ", [RECORD_KEYS.status]: "accepted" }), null);
  assert.equal(readRecords({ [RECORD_KEYS.id]: null }), null);

  const v = readRecords({
    [RECORD_KEYS.id]: "abc",
    [RECORD_KEYS.status]: "bogus",
    [RECORD_KEYS.scoreSource]: "guess",
    [RECORD_KEYS.score]: "12.5",
    [RECORD_KEYS.keys]: "two",
    [RECORD_KEYS.delta]: "",
  })!;
  assert.equal(v.status, "pending");
  assert.equal(v.scoreSource, "author");
  assert.equal(v.scoreBp, null);
  assert.equal(v.keys, 0);
  assert.equal(v.deltaBp, null);
  assert.equal(v.minKeys, null);
  assert.deepEqual(v.checks, []);
});

test("parseChecks drops malformed JSON and malformed entries", () => {
  assert.deepEqual(parseChecks(null), []);
  assert.deepEqual(parseChecks(""), []);
  assert.deepEqual(parseChecks("not json"), []);
  assert.deepEqual(parseChecks('{"key":"a"}'), []);
  const good = { key: "f311696f", counted: true, deltaBp: 7000, parentBp: 2500, candidateBp: 9500, runs: 5, why: "" };
  const parsed = parseChecks(JSON.stringify([
    good,
    null,
    "x",
    { ...good, counted: "yes" },
    { ...good, deltaBp: "7000" },
    { ...good, key: 7 },
    { ...good, runs: null },
    { key: "f54f86ab", counted: false, deltaBp: -100, parentBp: 1, candidateBp: 2, runs: 3 },
  ]));
  assert.deepEqual(parsed, [good, { key: "f54f86ab", counted: false, deltaBp: -100, parentBp: 1, candidateBp: 2, runs: 3, why: "" }]);
});

test("changedKeys: unset equals empty, and only the given keys are compared", () => {
  const want = { a: "1", b: "", c: "3" };
  assert.deepEqual(changedKeys(want, { a: "1", b: null, c: "3" }), []);
  assert.deepEqual(changedKeys(want, { a: "1", c: "3" }), []);
  assert.deepEqual(changedKeys(want, { a: "2", b: "x", c: "3" }), ["a", "b"]);
  assert.deepEqual(changedKeys(want, {}), ["a", "c"]);
  assert.deepEqual(changedKeys(want, { a: "2", b: "x" }, ["b"]), ["b"]);
  assert.deepEqual(changedKeys(want, { z: "stale" }, ["z"]), ["z"]);

  const r = records(data.nodes[0].id);
  assert.deepEqual(changedKeys(r, r), []);
  assert.deepEqual(changedKeys(r, { ...r, [RECORD_KEYS.status]: "rejected" }), [RECORD_KEYS.status]);
});

test("treePlan names every version once, the same names the page shows", () => {
  const plan = treePlan(data, HARNESS);
  const names = ensNames(data.nodes, HARNESS);
  assert.equal(plan.suffix, ENS_SUFFIX);
  assert.equal(plan.tree, data.tree);
  assert.equal(plan.names.length, data.nodes.length);
  assert.equal(new Set(plan.names.map((p) => p.name)).size, plan.names.length, "names are unique");
  for (const p of plan.names) {
    assert.equal(p.name, names.get(p.id));
    assert.ok(p.name.endsWith(".petri.eth"), p.name);
    assert.equal(p.records[RECORD_KEYS.id], p.id);
  }
  const seqs = plan.names.map((p) => data.nodes.find((n) => n.id === p.id)!.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "in proposal order");
  assert.equal(plan.names[0].name, `petriharnessv1.${ENS_SUFFIX}`);
});

test("parseNamesParam accepts names under petri.eth only", () => {
  assert.deepEqual(parseNamesParam("petri.eth"), { ok: true, names: ["petri.eth"] });
  assert.deepEqual(
    parseNamesParam(" addsigs.petriharnessv1.petri.eth, petriharnessv1.petri.eth,,ADDSIGS.petriharnessv1.petri.eth "),
    { ok: true, names: ["addsigs.petriharnessv1.petri.eth", "petriharnessv1.petri.eth"] },
  );
  const max = Array.from({ length: 64 }, (_, i) => `v${i}.petri.eth`).join(",");
  assert.equal(parseNamesParam(max).ok, true);

  for (const bad of [
    null, undefined, "", " , ,",
    "nick.eth",
    "xpetri.eth",
    "petri.eth.evil.eth",
    "a.petri.eth,nick.eth",
    Array.from({ length: 65 }, (_, i) => `v${i}.petri.eth`).join(","),
    `${"a".repeat(246)}.petri.eth`,
  ]) {
    const r = parseNamesParam(bad);
    assert.equal(r.ok, false, `rejects ${String(bad).slice(0, 40)}`);
    assert.ok(!r.ok && r.error.length > 0);
  }
  // 245 + ".petri.eth" is exactly 255 characters.
  assert.equal(parseNamesParam(`${"a".repeat(245)}.petri.eth`).ok, true);
});

// --- resolveRecords against a fake Universal Resolver --------------------------
// Sepolia has no resolver on petri.eth yet, so these are the only way to reach
// the batch, fallback and error branches.

type Reader = NonNullable<NonNullable<Parameters<typeof resolveRecords>[1]>["client"]>;
const RESOLVER = "0x1111111111111111111111111111111111111111";
const MULTICALL = "0xac9650d8"; // multicall(bytes[])
const textAnswer = (s: string) => encodeFunctionResult({ abi: resolverProfileAbi, functionName: "text", result: s });
const batchAnswer = (answers: Hex[]) => encodeFunctionResult({ abi: resolverProfileAbi, functionName: "multicall", result: answers });
/** Shaped like a viem revert: extractRevertData finds `data`. */
const reverted = (data: Hex) => Object.assign(new Error("execution reverted"), { data });
/** The key of a single text(node, key) call. */
const keyOf = (call: Hex) => {
  const { functionName, args } = decodeFunctionData({ abi: resolverProfileAbi, data: call });
  assert.equal(functionName, "text");
  return args[1] as string;
};

/** A fake UR: `answer` gets the DNS-encoded name and call data, and returns the result or throws. */
function fakeUr(answer: (dnsName: Hex, call: Hex) => Hex) {
  const calls: Hex[] = [];
  const client = {
    readContract: async ({ args }: { args: [Hex, Hex] }) => {
      calls.push(args[1]);
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      return [answer(args[0], args[1]), RESOLVER] as const;
    },
  } as unknown as Reader;
  return { client, calls };
}

test("resolveRecords: no resolver on the path reads as unpublished, not as an error", async () => {
  const name = "addsigs.petriharnessv1.petri.eth";
  const ur = fakeUr((dns) => {
    throw reverted(encodeErrorResult({ abi: UniversalResolverV2Abi, errorName: "ResolverNotFound", args: [dns] }));
  });
  const [r] = await resolveRecords([name], { client: ur.client, keys: ["description", "petri.id"] });
  assert.deepEqual(r, { name, resolver: null, texts: { description: null, "petri.id": null } });
  assert.equal(ur.calls.length, 1, "no per-key fallback");
});

test("resolveRecords: an RPC failure is an error with no texts", async () => {
  const ur = fakeUr(() => {
    throw Object.assign(new Error("fetch failed"), { shortMessage: "HTTP request failed." });
  });
  const [r] = await resolveRecords(["petri.eth"], { client: ur.client });
  assert.deepEqual(r, { name: "petri.eth", resolver: null, texts: {}, error: "HTTP request failed." });
});

test("resolveRecords: one call per name; unset, failed and empty answers read as null; order kept", async () => {
  const keys = ["description", "url", "petri.id", "petri.status"];
  const failed = encodeErrorResult({ abi: UniversalResolverV2Abi, errorName: "ResolverError", args: ["0x"] });
  const ur = fakeUr((dns, call) => {
    assert.ok(call.startsWith(MULTICALL));
    return batchAnswer([textAnswer(`hi ${dns}`), textAnswer(""), failed, "0x"]);
  });
  const names = Array.from({ length: 20 }, (_, i) => `v${i}.petri.eth`);
  const results = await resolveRecords(names, { client: ur.client, keys });
  assert.equal(ur.calls.length, names.length);
  assert.deepEqual(results.map((r) => r.name), names);
  for (const r of results) {
    assert.equal(r.error, undefined);
    assert.equal(r.resolver, RESOLVER);
    assert.deepEqual(r.texts, { description: `hi ${dnsEncode(r.name)}`, url: null, "petri.id": null, "petri.status": null });
  }
});

test("resolveRecords: a resolver that refuses the batch is read key by key", async () => {
  const ur = fakeUr((_, call) => {
    if (call.startsWith(MULTICALL)) {
      throw reverted(encodeErrorResult({ abi: UniversalResolverV2Abi, errorName: "UnsupportedResolverProfile", args: [MULTICALL] }));
    }
    if (keyOf(call) === "description") return textAnswer("from one key");
    throw reverted(encodeErrorResult({ abi: UniversalResolverV2Abi, errorName: "ResolverError", args: ["0x"] }));
  });
  const [r] = await resolveRecords(["petri.eth"], { client: ur.client, keys: ["description", "url"] });
  assert.deepEqual(r, { name: "petri.eth", resolver: RESOLVER, texts: { description: "from one key", url: null } });
  assert.equal(ur.calls.length, 3, "the batch, then one call per key");
});

test("resolveRecords: an invalid name fails without a call", async () => {
  const ur = fakeUr(() => "0x");
  const [r] = await resolveRecords(["a..petri.eth"], { client: ur.client });
  assert.deepEqual(r, { name: "a..petri.eth", resolver: null, texts: {}, error: "invalid name" });
  assert.equal(ur.calls.length, 0);
});
