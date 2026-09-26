import type { NextRequest } from "next/server";

import { getVerifierConfig } from "@/lib/pay/config";
import { versionMarkdown } from "@/lib/pay/markdown-source";
import { sameAddress } from "@/lib/pay/network";
import { PROFILE_PARAM, getVerifierServer, nextAdapter, offer, paymentKeyOfHeader, profileOf } from "@/lib/pay/verifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * GET /api/versions/:versionId/markdown?seller=honest|rogue|greedy
 *
 * A Petri version's record as a markdown file, sold over x402: its hypothesis,
 * status, the re-runs by other keys and the change it made. Without
 * PAYMENT-SIGNATURE it answers 402 with the price and wallet. With one, the
 * in-process facilitator checks the signature, the seller screens the payer
 * with Intercepta, settles on Sepolia, and only then sends the file.
 *
 * Unlike a verification run, a file can be bought again and again.
 * `rogue` and `greedy` are the demo sellers: they quote and never accept.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/versions/[versionId]/markdown">) {
  const cfg = getVerifierConfig();
  if (!cfg.ok) {
    return json(503, { ok: false, code: "not_configured", detail: cfg.problems.map((p) => `${p.name}: ${p.issue}`).join(" ") });
  }
  const { versionId } = await ctx.params;
  if (!/^[0-9a-f]{8,64}$/.test(versionId)) return json(400, { ok: false, code: "bad_version_id", detail: "8 to 64 hex characters." });

  const profile = profileOf(req.nextUrl.searchParams.get(PROFILE_PARAM.markdown));
  const header = req.headers.get("payment-signature") ?? req.headers.get("x-payment") ?? undefined;
  if (header && profile !== "honest") {
    return json(403, { ok: false, code: "demo_seller_never_accepts_payment", detail: `The ${profile} seller exists to be refused.` });
  }

  // Build the file before asking for money: a version that does not exist is a 404, never a charge.
  const file = await versionMarkdown(versionId, cfg.config.petriHome);
  if (!file.ok) return json(file.status, { ok: false, code: file.code, detail: file.detail });

  const server = getVerifierServer(cfg.config);
  const key = header ? paymentKeyOfHeader(header) : null;
  if (header && key === null) {
    return json(400, { ok: false, code: "unsupported_payment", detail: "PAYMENT-SIGNATURE must hold exactly one EIP-3009 authorization." });
  }
  if (key && (server.usedNonces.has(key) || server.pendingNonces.has(key))) {
    return json(409, { ok: false, code: "authorization_reused", detail: "This authorization was already used." });
  }
  if (key) server.pendingNonces.add(key);

  try {
    let result;
    try {
      await server.ready;
      result = await server.http.processHTTPRequest({ adapter: nextAdapter(req), path: req.nextUrl.pathname, method: "GET", paymentHeader: header });
    } catch (e) {
      return json(502, { ok: false, code: "facilitator_error", detail: String(e instanceof Error ? e.message : e) });
    }
    const payerScreen = key ? server.payerScreens.get(key) : undefined;

    if (result.type === "payment-error") {
      const h = new Headers(result.response.headers);
      h.set("content-type", "application/json");
      h.set("cache-control", "no-store");
      const body = header
        ? { ok: false, code: "payment_refused", detail: "The payment was not accepted. PAYMENT-REQUIRED carries the reason.", payerScreen }
        : { ok: false, code: "payment_required", detail: `Pay with x402 to download ${file.file}.`, file: file.file };
      return new Response(JSON.stringify(body), { status: result.response.status, headers: h });
    }
    if (result.type !== "payment-verified") return json(500, { ok: false, code: "route_not_priced" });
    if (key) server.usedNonces.add(key);

    // Backstop: only a payment to the honest offer, at its price, is ever settled here.
    const honest = offer(cfg.config, "honest", "markdown");
    if (!sameAddress(result.paymentRequirements.payTo, honest.payTo) || result.paymentRequirements.amount !== honest.amountAtomic.toString()) {
      await result.cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: 409 }).catch(() => undefined);
      return json(409, { ok: false, code: "offer_mismatch", detail: "This payment is not for the honest seller's wallet and price. Not settled." });
    }

    let settled;
    try {
      settled = await server.http.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        undefined,
        undefined,
        result.beforeHandlerSettlement,
      );
    } catch (e) {
      return json(502, { ok: false, code: "settle_failed", detail: String(e instanceof Error ? e.message : e), payerScreen });
    }
    const settlement = {
      success: settled.success,
      transaction: settled.transaction,
      network: settled.network,
      payer: settled.payer,
      errorReason: settled.success ? undefined : settled.errorReason,
    };
    // Broadcast but not confirmed: the money may be on its way, so the buyer still gets the file.
    const pending = !settled.success && settled.errorReason === "settlement_pending" && !!settled.transaction;
    const h = new Headers(settled.headers);
    h.set("content-type", "application/json");
    h.set("cache-control", "no-store");
    if (!settled.success && !pending) {
      return new Response(JSON.stringify({ ok: false, code: "settle_failed", detail: settled.errorReason, payerScreen, settlement }), { status: 502, headers: h });
    }
    return new Response(
      JSON.stringify({
        ok: settled.success,
        ...(pending ? { code: "settlement_pending", detail: "The transfer was broadcast and is not confirmed yet." } : {}),
        file: file.file,
        markdown: file.markdown,
        source: file.source,
        payerScreen,
        settlement,
      }),
      { status: settled.success ? 200 : 202, headers: h },
    );
  } finally {
    if (key) server.pendingNonces.delete(key);
  }
}

function json(status: number, body: unknown) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
