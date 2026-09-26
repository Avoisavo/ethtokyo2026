import { randomUUID } from "node:crypto";

import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload } from "@x402/core/types";
import type { ClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

import { quickScanAddress, scanMessage } from "../intercepta/client";
import type { InterceptaConfig } from "../intercepta/config";
import {
  addressVerdict,
  assetCheck,
  authorizationCheck,
  decide,
  internalCheck,
  limitCheck,
  messageCheck,
  payToFormatCheck,
  messageVerdict,
  payToCheck,
  validityCheck,
  type Check,
} from "../intercepta/decision";
import { authorizationProblems, jsonSafe } from "./authorization";
import type { PayerConfig } from "./config";
import { SEPOLIA, sameAddress } from "./network";
import { appendPaymentRecord } from "./record";
import type { PayMode, PaymentRecord, Product, VerifierProfile, VerifierReply } from "./types";

/**
 * The Petri agent paying a seller over x402, with Intercepta in the payment path.
 * It buys a verification run (POST) or a version's markdown file (GET); the
 * checks are the same for both.
 *
 *   1. POST the verifier. It answers 402 with PAYMENT-REQUIRED: price, token, payTo.
 *   2. Petri's own limits, no network: fee cap, Circle USDC only, authorization lifetime.
 *   3. x402 spend controls: a second, independent cap inside the x402 client.
 *   4. Intercepta Quick Scan on payTo, in onBeforePaymentCreation. Nothing is built yet.
 *   5. The scheme builds the EIP-3009 authorization and hands it to the signer.
 *      The signer checks it against the 402, sends the exact typed data to
 *      Intercepta Scan Message, and signs only when every check passed.
 *   6. POST again with PAYMENT-SIGNATURE. The verifier screens the payer, runs
 *      `petri verify`, and settles on Sepolia only after the report exists.
 *
 * Every attempt is recorded, including the ones stopped before signing. An
 * error that no check decided holds; the agent never pays by default.
 */

export type PayInput = {
  url: string;
  versionId: string;
  verifier: VerifierProfile;
  mode: PayMode;
  /** Defaults to a verification run. */
  product?: Product;
  payer: PayerConfig;
  /** Null when INTERCEPTA_API_KEY is missing: every payment then holds. */
  intercepta: InterceptaConfig | null;
  fetch?: typeof fetch;
  now?: () => number;
  /** Tests turn this off. */
  record?: boolean;
};

/** Thrown from the signer to stop before a signature exists. */
class StopBeforeSigning extends Error {}

export async function payForVerification(p: PayInput): Promise<PaymentRecord> {
  const now = p.now ?? Date.now;
  const f = p.fetch ?? fetch;
  const t0 = now();
  const account = privateKeyToAccount(p.payer.key);
  const rec: PaymentRecord = {
    kind: "petri/payment-check/1",
    id: randomUUID(),
    at: t0,
    mode: p.mode,
    product: p.product ?? "verification",
    versionId: p.versionId,
    verifier: p.verifier,
    url: p.url,
    payer: account.address,
    requirements: null,
    intercepta: [],
    typedData: null,
    decision: null,
    signed: false,
    sent: false,
    outcome: "error",
    verifierReply: null,
    elapsedMs: 0,
  };
  const checks: Check[] = [];
  const method = p.product === "markdown" ? "GET" : "POST";

  try {
    // 1. Ask for the work. A verifier that can run it answers 402.
    const r1 = await f(p.url, { method, headers: { accept: "application/json" }, cache: "no-store" });
    const body1 = (await r1.json().catch(() => null)) as Record<string, unknown> | null;
    if (r1.status !== 402) {
      rec.verifierReply = { ok: false, ...(body1 as VerifierReply | null), status: r1.status };
      rec.error = `The verifier answered ${r1.status}, not 402. ${String(body1?.detail ?? body1?.code ?? "")}`.trim();
      return rec;
    }
    const reader = new x402HTTPClient(new x402Client());
    const required = reader.getPaymentRequiredResponse((n) => r1.headers.get(n), body1 ?? undefined);
    const req = required.accepts.find((a) => a.scheme === "exact" && a.network === SEPOLIA.caip2);
    if (!req) {
      rec.decision = decide([assetCheck(false, "The verifier offers no exact USDC payment on Sepolia.")]);
      rec.outcome = "rejected";
      return rec;
    }
    rec.requirements = {
      scheme: req.scheme,
      network: req.network,
      asset: req.asset,
      amount: req.amount,
      payTo: req.payTo,
      maxTimeoutSeconds: req.maxTimeoutSeconds,
    };

    // 2. Petri's own limits. They cost no Intercepta request.
    if (p.mode === "screened") {
      const method = (req.extra as { assetTransferMethod?: string } | undefined)?.assetTransferMethod ?? "eip3009";
      checks.push(
        limitCheck(BigInt(req.amount), p.payer.maxAtomic),
        assetCheck(
          sameAddress(req.asset, SEPOLIA.usdc) && method === "eip3009",
          sameAddress(req.asset, SEPOLIA.usdc)
            ? method === "eip3009"
              ? "Circle USDC on Sepolia, EIP-3009 transfer authorization."
              : `Transfer method ${method} is not allowed. Petri signs EIP-3009 only.`
            : `${req.asset} is not Circle USDC on Sepolia.`,
        ),
        validityCheck(req.maxTimeoutSeconds, p.payer.maxValiditySeconds),
      );
      const badPayTo = payToFormatCheck(req.payTo);
      if (badPayTo) checks.push(badPayTo);
      rec.decision = decide(checks);
      if (rec.decision.action !== "pay") {
        rec.outcome = rec.decision.action === "reject" ? "rejected" : "held";
        return rec;
      }
    }

    const signer: ClientEvmSigner = {
      address: account.address,
      // 5. The exact EIP-712 object exists here, and no signature does yet.
      async signTypedData(td) {
        rec.typedData = jsonSafe(td) as Record<string, unknown>;
        if (p.mode === "preview") throw new StopBeforeSigning("preview");
        if (!checks.some((c) => c.id === "payto")) throw new StopBeforeSigning("payto_not_screened");

        const problems = authorizationProblems(td, req, account.address, Math.floor(now() / 1000), p.payer.maxValiditySeconds);
        checks.push(authorizationCheck(problems));
        if (problems.length === 0) {
          const call = p.intercepta?.scanMessage
            ? await scanMessage({ from: account.address, typedData: td, chainId: SEPOLIA.screenChainId }, p.intercepta.client)
            : null;
          if (call) rec.intercepta.push(call);
          checks.push(messageCheck(messageVerdict(call)));
        }
        rec.decision = decide(checks);
        if (rec.decision.action !== "pay") throw new StopBeforeSigning(rec.decision.code);
        return account.signTypedData(td as Parameters<typeof account.signTypedData>[0]);
      },
    };

    const client = new x402Client()
      .register(SEPOLIA.caip2, new ExactEvmScheme(signer))
      // 3. x402's own cap. It is also required: Sepolia USDC is not one of x402's default assets.
      .setSpendControls({
        allowedAssets: [
          {
            network: SEPOLIA.caip2,
            asset: SEPOLIA.usdc,
            maxAmountPerPayment: (p.mode === "preview" ? BigInt(req.amount) : p.payer.maxAtomic).toString(),
          },
        ],
      })
      // 4. Screen the wallet the money would go to, before the authorization is built.
      .onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
        if (p.mode === "preview") return;
        const call = p.intercepta ? await quickScanAddress(r.payTo, p.intercepta.client) : null;
        if (call) rec.intercepta.push(call);
        checks.push(payToCheck(addressVerdict(call, p.intercepta?.thresholds)));
        rec.decision = decide(checks);
        if (rec.decision.action !== "pay") return { abort: true, reason: rec.decision.code };
      });

    const hc = new x402HTTPClient(client);
    let payload: PaymentPayload;
    try {
      payload = await hc.createPaymentPayload({ ...required, accepts: [req] });
    } catch (e) {
      // No path through here signed anything.
      if (p.mode === "preview") {
        rec.outcome = rec.typedData ? "previewed" : "error";
        if (!rec.typedData) rec.error = String(e instanceof Error ? e.message : e);
        return rec;
      }
      if (rec.decision && rec.decision.action !== "pay") {
        rec.outcome = rec.decision.action === "reject" ? "rejected" : "held";
        return rec;
      }
      const message = String(e instanceof Error ? e.message : e);
      checks.push(internalCheck(message, /spend/i.test(message)));
      rec.decision = decide(checks);
      rec.outcome = rec.decision.action === "reject" ? "rejected" : "held";
      rec.error = message;
      return rec;
    }
    if (p.mode === "preview") {
      // Unreachable: the preview signer always throws. Kept so a preview can never send.
      rec.outcome = "error";
      rec.error = "preview produced a payload";
      return rec;
    }
    rec.signed = true;

    // 6. Pay. The verifier screens the payer, runs the verification, then settles.
    const r2 = await f(p.url, {
      method,
      headers: { accept: "application/json", ...hc.encodePaymentSignatureHeader(payload) },
      cache: "no-store",
    });
    rec.sent = true;
    const raw2 = (await r2.json().catch(() => null)) as (VerifierReply & { markdown?: unknown }) | null;
    // The file goes to `delivered`, once, not into the reply as well.
    const { markdown, ...body2 } = raw2 ?? {};
    if (typeof markdown === "string") {
      rec.delivered = { file: body2.file ?? `petri-${p.versionId.slice(0, 8)}.md`, bytes: Buffer.byteLength(markdown), markdown };
    }
    rec.verifierReply = { ok: r2.ok, ...body2, status: r2.status };
    // 202 settlement_pending is 2xx too: paid means the verifier itself says ok.
    if (r2.ok && body2?.ok !== false) {
      rec.outcome = "paid";
      if (!rec.verifierReply.settlement) {
        try {
          const s = hc.getPaymentSettleResponse((n) => r2.headers.get(n));
          rec.verifierReply.settlement = { success: s.success, transaction: s.transaction, network: s.network, payer: s.payer };
        } catch {
          // The body already carries the settlement when the verifier is Petri's own route.
        }
      }
    } else if (rec.verifierReply.settlement?.transaction) {
      // Broadcast, not confirmed: the money may have moved. Never record it as refused.
      rec.outcome = rec.verifierReply.settlement.success ? "paid" : "pending";
    } else {
      rec.outcome = "refused";
      if (!raw2) rec.error = `The verifier failed with HTTP ${r2.status} and settled nothing. The authorization expires unused at its validBefore.`;
      if (r2.status === 402) {
        try {
          rec.refusedReason = hc.getPaymentRequiredResponse((n) => r2.headers.get(n), body2 ?? undefined).error;
        } catch {
          // No PAYMENT-REQUIRED header: the body's code says why.
        }
      }
    }
    return rec;
  } catch (e) {
    rec.error = String(e instanceof Error ? e.message : e);
    if (!rec.signed && p.mode === "screened") {
      checks.push(internalCheck(rec.error, false));
      rec.decision = decide(checks);
      rec.outcome = "held";
    } else {
      rec.outcome = "error";
    }
    return rec;
  } finally {
    rec.elapsedMs = now() - t0;
    if (p.record !== false) appendPaymentRecord(rec);
  }
}
