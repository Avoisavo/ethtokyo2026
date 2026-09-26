import type { NextRequest } from "next/server";

import { getVerifierConfig } from "@/lib/pay/config";
import { preflight, runVerify } from "@/lib/pay/petri-verify";
import { getVerifierServer, nextAdapter, paymentKeyOfHeader, profileOf } from "@/lib/pay/verifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/verifier/verify/:versionId?verifier=honest|rogue|greedy
 *
 * A Petri verifier sold over x402. Without PAYMENT-SIGNATURE it answers 402
 * with its price and wallet in PAYMENT-REQUIRED. With one, the in-process
 * facilitator checks the signature, the verifier screens the payer with
 * Intercepta, runs `petri verify`, and settles on Sepolia only after the
 * report exists. A failed run is never charged.
 *
 * `&repeat=1` is a demo mode: the verifier sells a run even when its key already
 * reported on the version. Petri counts one report per key per version, so that
 * report is stored but does not change the status. Without it, the verifier
 * refuses before quoting (409 already_verified). The buyer opts in; it knows the
 * report will not count.
 *
 * `rogue` (payTo is a known-risk mainnet address) and `greedy` (a 0.75 USDC fee)
 * are demo verifiers for the /intercepta page. They quote a price and never
 * accept a payment.
 */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/verifier/verify/[versionId]">) {
  const cfg = getVerifierConfig();
  if (!cfg.ok) {
    return json(503, { ok: false, code: "not_configured", detail: cfg.problems.map((p) => `${p.name}: ${p.issue}`).join(" ") });
  }
  const { versionId } = await ctx.params;
  if (!/^[0-9a-f]{8,64}$/.test(versionId)) return json(400, { ok: false, code: "bad_version_id", detail: "8 to 64 hex characters." });

  const profile = profileOf(req.nextUrl.searchParams.get("verifier"));
  const header = req.headers.get("payment-signature") ?? req.headers.get("x-payment") ?? undefined;

  // Gate 0: the demo verifiers only ever quote.
  if (header && profile !== "honest") {
    return json(403, { ok: false, code: "demo_verifier_never_accepts_payment", detail: `The ${profile} verifier exists to be refused.` });
  }

  // Gate 1: quote only for work that can run and count (or, in demo repeat mode, run).
  // Checked again before accepting.
  const repeat = req.nextUrl.searchParams.get("repeat") === "1";
  let runnerId: string | null = null;
  let alreadyVerified = false;
  if (profile === "honest") {
    const pf = await preflight(versionId, cfg.config.petriHome, { allowRepeat: repeat });
    if (!pf.ok) return json(pf.status, { ok: false, code: pf.code, detail: pf.detail });
    runnerId = pf.runnerId;
    alreadyVerified = pf.alreadyVerified;
  }

  // Gate 2: one run per authorization, and one paid run per version at a time.
  // Both are reserved before any await.
  const server = getVerifierServer(cfg.config);
  const nonce = header ? paymentKeyOfHeader(header) : null;
  if (header && nonce === null) {
    return json(400, { ok: false, code: "unsupported_payment", detail: "PAYMENT-SIGNATURE must hold exactly one EIP-3009 authorization." });
  }
  if (nonce && (server.usedNonces.has(nonce) || server.pendingNonces.has(nonce))) {
    return json(409, { ok: false, code: "authorization_reused", detail: "This authorization was already used." });
  }
  if (nonce && server.busyVersions.has(versionId)) {
    return json(409, { ok: false, code: "version_busy", detail: "A paid run of this version is in progress. Its report would make a second one not count." });
  }
  if (nonce) {
    server.pendingNonces.add(nonce);
    server.busyVersions.add(versionId);
  }

  try {
    // Gate 3: x402. No header: 402. A header: facilitator verify, then the payer screen.
    let result;
    try {
      await server.ready;
      result = await server.http.processHTTPRequest({
        adapter: nextAdapter(req),
        path: req.nextUrl.pathname,
        method: "POST",
        paymentHeader: header,
      });
    } catch (e) {
      return json(502, { ok: false, code: "facilitator_error", detail: String(e instanceof Error ? e.message : e) });
    }
    const payerScreen = nonce ? server.payerScreens.get(nonce) : undefined;

    if (result.type === "payment-error") {
      const h = new Headers(result.response.headers);
      h.set("content-type", "application/json");
      h.set("cache-control", "no-store");
      const body = header
        ? { ok: false, code: "payment_refused", detail: "The payment was not accepted. PAYMENT-REQUIRED carries the reason.", payerScreen }
        : { ok: false, code: "payment_required", detail: "Pay with x402 to run this verification.", runnerId };
      return new Response(JSON.stringify(body), { status: result.response.status, headers: h });
    }
    if (result.type !== "payment-verified") return json(500, { ok: false, code: "route_not_priced" });
    if (nonce) server.usedNonces.add(nonce);

    // Gate 4: the paid work, with the verifier's own key. Preflight runs again inside
    // the lock, so a report that could no longer count is never charged for.
    const home = cfg.config.petriHome!;
    const verification = await runVerify(versionId, home, () => preflight(versionId, home, { allowRepeat: repeat }));
    if (!verification.ok) {
      await result.cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: verification.status }).catch(() => undefined);
      return json(verification.status, {
        ok: false,
        code: verification.code,
        detail: `${verification.detail}\nNot settled. The authorization expires unused.`,
        payerScreen,
      });
    }

    // Gate 5: settle only now, after the report exists.
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
      return json(502, { ok: false, code: "settle_failed", detail: String(e instanceof Error ? e.message : e), payerScreen, verification });
    }
    const h = new Headers(settled.headers);
    h.set("content-type", "application/json");
    h.set("cache-control", "no-store");
    const settlement = {
      success: settled.success,
      transaction: settled.transaction,
      network: settled.network,
      payer: settled.payer,
      errorReason: settled.success ? undefined : settled.errorReason,
    };
    // Broadcast but not yet confirmed: the money may already be on its way. Never call it refused.
    const pending = !settled.success && settled.errorReason === "settlement_pending" && !!settled.transaction;
    return new Response(
      JSON.stringify(
        settled.success
          ? { ok: true, payerScreen, verification, settlement, repeat: alreadyVerified }
          : pending
            ? { ok: false, code: "settlement_pending", detail: "The transfer was broadcast and is not confirmed yet. Check the transaction.", payerScreen, verification, settlement }
            : { ok: false, code: "settle_failed", detail: settled.errorReason, payerScreen, verification, settlement },
      ),
      { status: settled.success ? 200 : pending ? 202 : 502, headers: h },
    );
  } finally {
    if (nonce) {
      server.pendingNonces.delete(nonce);
      server.busyVersions.delete(versionId);
    }
  }
}

function json(status: number, body: unknown) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
