import assert from "node:assert/strict";
import { test } from "node:test";

import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { InterceptaConfig } from "../intercepta/config";
import { DEFAULT_THRESHOLDS } from "../intercepta/decision";
import { payForVerification } from "./agent";
import { authorizationProblems } from "./authorization";
import type { PayerConfig } from "./config";
import { SEPOLIA } from "./network";

/**
 * The agent against a fake verifier and a fake Intercepta. No network, no
 * Intercepta request, no Sepolia transaction: `fetch` is injected.
 */

const KEY = `0x${"11".repeat(32)}` as Hex;
const PAYER = privateKeyToAccount(KEY).address;
const CLEAN = "0x338054CdA3715cBd6E5024709DfD172472E546F6";
const ROGUE = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
const URL = "http://verifier.test/api/verifier/verify/e1adae18?verifier=honest";
const NOW = 1_790_000_000_000;

const payer: PayerConfig = { key: KEY, address: PAYER, maxAtomic: 500_000n, maxValiditySeconds: 300, rpcUrl: "" };
const intercepta: InterceptaConfig = {
  client: { apiKey: "test", cacheTtlMs: 0, baseUrl: "http://intercepta.test" },
  thresholds: DEFAULT_THRESHOLDS,
  scanMessage: true,
};

const SANCTIONED = { toxicScore: 100, traits: [{ risk: 100, name: "sanction_address", description: "Sanctioned." }] };

type Fake = {
  payTo?: string;
  amount?: string;
  maxTimeoutSeconds?: number;
  quick?: (address: string) => Response;
  message?: (body: { message: { message: { to: string } } }) => Response;
};

function fakeNetwork(o: Fake) {
  const calls: { url: string; paid: boolean }[] = [];
  const f = (async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    calls.push({ url, paid: headers.has("payment-signature") });
    if (url.startsWith("http://intercepta.test")) {
      if (url.includes("/quick-scan")) {
        const address = url.split("/account/")[1].split("/")[0];
        return o.quick?.(address) ?? Response.json(address === ROGUE.toLowerCase() ? SANCTIONED : { toxicScore: 0, traits: [] });
      }
      const body = JSON.parse(String(init.body));
      return (
        o.message?.(body) ??
        Response.json(
          body.message.message.to.toLowerCase() === ROGUE.toLowerCase()
            ? { messageType: "TransferWithAuthorization", riskGroup: "High", detectors: [{ code: "KNOWN_MALICIOUS", description: "Flagged." }], addresses: [] }
            : { messageType: "TransferWithAuthorization", riskGroup: "Low", detectors: [], addresses: [] },
          { status: 201 },
        )
      );
    }
    if (headers.has("payment-signature")) {
      return Response.json({
        ok: true,
        verification: { report: "r1", runner: "k1", deltaMedianBp: -7000, status: "rejected", statusCode: "REGRESSION", statusReason: "" },
        settlement: { success: true, transaction: "0xabc", network: SEPOLIA.caip2 },
      });
    }
    const required = {
      x402Version: 2,
      error: "Payment required",
      resource: { url: URL, description: "Petri verification run", mimeType: "application/json" },
      accepts: [
        {
          scheme: "exact",
          network: SEPOLIA.caip2,
          amount: o.amount ?? "10000",
          asset: SEPOLIA.usdc,
          payTo: o.payTo ?? CLEAN,
          maxTimeoutSeconds: o.maxTimeoutSeconds ?? 300,
          extra: { name: "USDC", version: "2" },
        },
      ],
    };
    return new Response("{}", {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required as Parameters<typeof encodePaymentRequiredHeader>[0]) },
    });
  }) as unknown as typeof fetch;
  const interceptaCalls = () => calls.filter((c) => c.url.startsWith("http://intercepta.test")).length;
  const paidCalls = () => calls.filter((c) => c.paid).length;
  return { fetch: f, interceptaCalls, paidCalls };
}

const run = (net: ReturnType<typeof fakeNetwork>, extra: Partial<Parameters<typeof payForVerification>[0]> = {}) =>
  payForVerification({
    url: URL,
    versionId: "e1adae18",
    verifier: "honest",
    mode: "screened",
    payer,
    intercepta: { ...intercepta, client: { ...intercepta.client, fetch: net.fetch } },
    fetch: net.fetch,
    // The real clock: the x402 scheme stamps validBefore with Date.now().
    record: false,
    ...extra,
  });

test("a clean verifier within the limit: screened, signed, paid", async () => {
  const net = fakeNetwork({});
  const r = await run(net);
  assert.equal(r.outcome, "paid");
  assert.equal(r.decision?.action, "pay");
  assert.equal(r.signed, true);
  assert.equal(net.interceptaCalls(), 2, "Quick Scan on payTo, then Scan Message");
  assert.equal(net.paidCalls(), 1);
  assert.equal(r.verifierReply?.settlement?.transaction, "0xabc");
  assert.deepEqual(r.decision?.checks.map((c) => c.id), ["limit", "asset", "validity", "payto", "authorization", "message"]);
});

test("a sanctioned payTo: rejected by Quick Scan before the authorization exists", async () => {
  const net = fakeNetwork({ payTo: ROGUE });
  const r = await run(net, { verifier: "rogue" });
  assert.equal(r.outcome, "rejected");
  assert.equal(r.decision?.code, "intercepta_block:sanction_address");
  assert.equal(r.signed, false);
  assert.equal(r.typedData, null, "the scheme never built the authorization");
  assert.equal(net.interceptaCalls(), 1);
  assert.equal(net.paidCalls(), 0);
});

test("a fee over the limit: rejected with no Intercepta request", async () => {
  const net = fakeNetwork({ amount: "750000" });
  const r = await run(net, { verifier: "greedy" });
  assert.equal(r.outcome, "rejected");
  assert.equal(r.decision?.code, "over_limit");
  assert.equal(net.interceptaCalls(), 0);
  assert.equal(net.paidCalls(), 0);
});

test("a verifier asking for a day-long authorization: rejected before screening", async () => {
  const net = fakeNetwork({ maxTimeoutSeconds: 86_400 });
  const r = await run(net);
  assert.equal(r.decision?.code, "validity_too_long");
  assert.equal(net.interceptaCalls(), 0);
});

test("Intercepta down (403 or timeout): held, never paid", async () => {
  for (const quick of [
    () => new Response(JSON.stringify({ status: 403, response: "bad key" }), { status: 403 }),
    () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    },
  ]) {
    const net = fakeNetwork({ quick });
    const r = await run(net);
    assert.equal(r.outcome, "held");
    assert.equal(r.decision?.code, "screening_unavailable");
    assert.equal(r.signed, false);
    assert.equal(net.paidCalls(), 0);
  }
});

test("no Intercepta key: held as screening_disabled", async () => {
  const net = fakeNetwork({});
  const r = await run(net, { intercepta: null });
  assert.equal(r.outcome, "held");
  assert.equal(r.decision?.code, "screening_disabled");
  assert.equal(net.paidCalls(), 0);
});

test("Scan Message says High on a clean payTo: rejected before the signature", async () => {
  const net = fakeNetwork({
    message: () =>
      Response.json({ messageType: "TransferWithAuthorization", riskGroup: "High", detectors: [{ code: "WALLET_DRAINER", description: "d" }], addresses: [] }, { status: 201 }),
  });
  const r = await run(net);
  assert.equal(r.outcome, "rejected");
  assert.equal(r.decision?.code, "intercepta_message_block:WALLET_DRAINER");
  assert.ok(r.typedData, "the authorization was built and scanned");
  assert.equal(r.signed, false);
  assert.equal(net.paidCalls(), 0);
});

test("preview: the agent before this feature builds the rogue authorization and never signs", async () => {
  const net = fakeNetwork({ payTo: ROGUE });
  const r = await run(net, { mode: "preview", verifier: "rogue" });
  assert.equal(r.outcome, "previewed");
  assert.equal((r.typedData as { message: { to: string } }).message.to.toLowerCase(), ROGUE.toLowerCase());
  assert.equal(r.signed, false);
  assert.equal(net.interceptaCalls(), 0);
  assert.equal(net.paidCalls(), 0);
});

test("a verifier that does not answer 402: an error, nothing signed", async () => {
  const f = (async () => Response.json({ ok: false, code: "engine_not_installed" }, { status: 503 })) as unknown as typeof fetch;
  const r = await payForVerification({ url: URL, versionId: "e1adae18", verifier: "honest", mode: "screened", payer, intercepta, fetch: f, record: false });
  assert.equal(r.outcome, "error");
  assert.equal(r.verifierReply?.code, "engine_not_installed");
  assert.equal(r.signed, false);
});

test("authorizationProblems: catches a swapped recipient and an over-long lifetime", () => {
  const td = {
    domain: { name: "USDC", version: "2", chainId: SEPOLIA.chainId, verifyingContract: SEPOLIA.usdc },
    types: {},
    primaryType: "TransferWithAuthorization",
    message: { from: PAYER, to: ROGUE, value: 10_000n, validAfter: 0n, validBefore: BigInt(NOW / 1000 + 86_400), nonce: "0x01" },
  };
  const problems = authorizationProblems(td, { asset: SEPOLIA.usdc, payTo: CLEAN, amount: "10000" }, PAYER, NOW / 1000, 300);
  assert.equal(problems.length, 2);
  assert.match(problems.join(" "), /to is not the payTo/);
  assert.match(problems.join(" "), /validBefore/);
});
