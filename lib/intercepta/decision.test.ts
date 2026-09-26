import assert from "node:assert/strict";
import { test } from "node:test";

import { quickScanAddress, scanMessage, toInterceptaTypedData, type InterceptaCall, type MessageScan, type QuickScan } from "./client";
import {
  addressVerdict,
  decide,
  formatUsdc,
  limitCheck,
  messageCheck,
  messageVerdict,
  payToCheck,
  payerCheck,
  validityCheck,
} from "./decision";

const ok = <T>(body: T, endpoint: "quick-scan" | "scan-message" = "quick-scan"): InterceptaCall<T> => ({
  endpoint,
  subject: "0xabc",
  at: 0,
  latencyMs: 1,
  cached: false,
  ok: true,
  status: 200,
  body,
});
const down = (error: string): InterceptaCall<QuickScan> => ({
  endpoint: "quick-scan",
  subject: "0xabc",
  at: 0,
  latencyMs: 1,
  cached: false,
  ok: false,
  status: 403,
  error,
});

// The live answer for 0x098B…2f96 on 2026-09-27, without txsCount as Intercepta sends it.
const SANCTIONED: QuickScan = {
  toxicScore: 100,
  traits: [
    { risk: 100, name: "known_scammer", description: "The address has a confirmed history of malicious activity." },
    { risk: 100, name: "sanction_address", description: "The address is officially listed as sanctioned." },
    { risk: 100, name: "blacklist", description: "The address appears on external or internal blacklist sources." },
  ],
};

test("addressVerdict: a fresh address is clear, a sanctioned one blocks", () => {
  assert.equal(addressVerdict(ok({ toxicScore: 0, traits: [] })).level, "clear");
  const v = addressVerdict(ok(SANCTIONED));
  assert.equal(v.level, "block");
  assert.match(v.reasons.join(" "), /sanction_address/);
});

test("addressVerdict: soft traits and mid scores hold, thresholds are configurable", () => {
  assert.equal(addressVerdict(ok({ toxicScore: 10, traits: [{ risk: 20, name: "mixer_transfers", description: "d" }] })).level, "caution");
  assert.equal(addressVerdict(ok({ toxicScore: 40, traits: [] })).level, "caution");
  assert.equal(addressVerdict(ok({ toxicScore: 85, traits: [] })).level, "block");
  assert.equal(addressVerdict(ok({ toxicScore: 40, traits: [] }), { blockScore: 90, holdScore: 50 }).level, "clear");
  assert.equal(addressVerdict(ok({ toxicScore: 5, traits: [{ risk: 1, name: "some_new_trait", description: "d" }] })).level, "caution");
});

test("addressVerdict: no answer is unavailable, no call is skipped, and both hold the payment", () => {
  const unavailable = addressVerdict(down("This authentication key is incorrect or doesn’t exist"));
  assert.equal(unavailable.level, "unavailable");
  assert.equal(payToCheck(unavailable).status, "hold");
  assert.equal(payToCheck(addressVerdict(null)).status, "hold");
  assert.equal(payToCheck(addressVerdict(null)).code, "screening_disabled");
});

test("messageVerdict: the live answers for a clean and a sanctioned recipient", () => {
  const clean: MessageScan = {
    messageType: "TransferWithAuthorization",
    riskGroup: "Low",
    detectors: [],
    addresses: [{ address: "0x338054cda3715cbd6e5024709dfd172472e546f6", type: "eoa", detectors: [] }],
  };
  assert.equal(messageVerdict(ok(clean, "scan-message")).level, "clear");

  const flagged: MessageScan = {
    messageType: "TransferWithAuthorization",
    riskGroup: "High",
    detectors: [{ code: "KNOWN_MALICIOUS", description: "Spender address flagged in phishing list." }],
    addresses: [{ address: "0x098b716b8aaf21512996dc57eb0615e2383e2f96", type: "eoa", detectors: ["KNOWN_MALICIOUS"] }],
  };
  const v = messageVerdict(ok(flagged, "scan-message"));
  assert.equal(v.level, "block");
  assert.equal(messageCheck(v).code, "intercepta_message_block:KNOWN_MALICIOUS");
});

test("messageVerdict: Medium holds, an unparsed Low holds, an address-level detector blocks", () => {
  assert.equal(messageVerdict(ok({ messageType: "TransferWithAuthorization", riskGroup: "Medium", detectors: [], addresses: [] }, "scan-message")).level, "caution");
  // The JSON-string form of `message` comes back Low with no type: Intercepta parsed nothing.
  assert.equal(messageVerdict(ok({ messageType: null, riskGroup: "Low", detectors: [], addresses: [] }, "scan-message")).level, "caution");
  const perAddress = messageVerdict(
    ok({ messageType: "TransferWithAuthorization", riskGroup: "Low", detectors: [], addresses: [{ address: "0x1", type: "eoa", detectors: ["WALLET_DRAINER"] }] }, "scan-message"),
  );
  assert.equal(perAddress.level, "block");
  assert.equal(messageCheck(messageVerdict(null)).status, "skipped");
});

test("decide: reject beats hold, hold beats pay", () => {
  const pass = limitCheck(10_000n, 500_000n);
  const hold = payToCheck(addressVerdict(down("timeout")));
  const fail = validityCheck(86_400, 300);
  assert.equal(decide([pass]).action, "pay");
  assert.equal(decide([pass]).code, "all_checks_passed");
  assert.equal(decide([pass, hold]).action, "hold");
  const d = decide([pass, hold, fail]);
  assert.equal(d.action, "reject");
  assert.equal(d.code, "validity_too_long");
  assert.equal(d.reasons.length, 2);
});

test("limitCheck and formatUsdc: 0.75 is over a 0.50 limit", () => {
  const c = limitCheck(750_000n, 500_000n);
  assert.equal(c.status, "fail");
  assert.equal(c.code, "over_limit");
  assert.equal(formatUsdc(10_000n), "0.01 USDC");
  assert.equal(formatUsdc(500_000n), "0.5 USDC");
  assert.equal(formatUsdc(2_000_000n), "2 USDC");
});

test("payerCheck: the verifier turns a sanctioned payer away, and screening off lets it through", () => {
  assert.equal(payerCheck(addressVerdict(ok(SANCTIONED))).status, "fail");
  assert.equal(payerCheck(addressVerdict(down("x"))).status, "hold");
  assert.equal(payerCheck(addressVerdict(null)).status, "skipped");
  assert.equal(decide([payerCheck(addressVerdict(null))]).action, "pay");
});

test("toInterceptaTypedData: bigints become strings and EIP712Domain lists the domain fields", () => {
  const out = toInterceptaTypedData({
    domain: { name: "USDC", version: "2", chainId: 11155111, verifyingContract: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
    types: { TransferWithAuthorization: [{ name: "value", type: "uint256" }] },
    primaryType: "TransferWithAuthorization",
    message: { value: 10_000n, validBefore: 1_790_000_600n },
  }) as { types: Record<string, { name: string }[]>; message: Record<string, unknown> };
  assert.deepEqual(out.types.EIP712Domain.map((f) => f.name), ["name", "version", "chainId", "verifyingContract"]);
  assert.equal(out.message.value, "10000");
  assert.equal(out.message.validBefore, "1790000600");
});

test("client: X-API-KEY header, a 403 becomes a failed call, nothing throws", async () => {
  let seen: Headers | null = null;
  const fetch403 = (async (_url: string, init: RequestInit) => {
    seen = new Headers(init.headers);
    return new Response(JSON.stringify({ status: 403, response: "This authentication key is incorrect or doesn’t exist", errors: [] }), { status: 403 });
  }) as unknown as typeof fetch;
  const call = await quickScanAddress("0xAAAA000000000000000000000000000000000001", { apiKey: "k", fetch: fetch403, cacheTtlMs: 0 });
  assert.equal(seen!.get("x-api-key"), "k");
  assert.equal(call.ok, false);
  assert.equal(call.ok ? "" : call.error, "This authentication key is incorrect or doesn’t exist");

  const boom = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const failed = await scanMessage({ from: "0x1", chainId: "1", typedData: { domain: {}, types: {}, primaryType: "X", message: {} } }, { apiKey: "k", fetch: boom });
  assert.equal(failed.ok, false);
});

test("client: Scan Message sends the typed data as an object and accepts 201", async () => {
  let sent: Record<string, unknown> | null = null;
  const fetch201 = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ messageType: "TransferWithAuthorization", riskGroup: "Low", detectors: [], addresses: [] }), { status: 201 });
  }) as unknown as typeof fetch;
  const call = await scanMessage(
    { from: "0xAbC", chainId: "1", website: "http://localhost:3000", typedData: { domain: { name: "USDC" }, types: {}, primaryType: "TransferWithAuthorization", message: { value: 1n } } },
    { apiKey: "k", fetch: fetch201 },
  );
  assert.equal(call.ok, true);
  assert.equal(typeof sent!.message, "object");
  assert.equal(sent!.from, "0xabc");
  assert.equal(sent!.website, undefined, "a localhost origin is never sent");
});

test("client: an unexpected body is a failed call, not a clean address", async () => {
  const weird = (async () => new Response(JSON.stringify({ hello: "world" }), { status: 200 })) as unknown as typeof fetch;
  const call = await quickScanAddress("0xAAAA000000000000000000000000000000000002", { apiKey: "k", fetch: weird, cacheTtlMs: 0 });
  assert.equal(call.ok, false);
  assert.equal(addressVerdict(call).level, "unavailable");
});
