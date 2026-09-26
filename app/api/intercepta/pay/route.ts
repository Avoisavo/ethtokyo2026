import type { NextRequest } from "next/server";

import { getInterceptaConfig } from "@/lib/intercepta/config";
import { payForVerification } from "@/lib/pay/agent";
import { getPayerConfig } from "@/lib/pay/config";
import { readPaymentRecords } from "@/lib/pay/record";
import type { PayMode, Product } from "@/lib/pay/types";
import { profileOf } from "@/lib/pay/verifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "cache-control": "no-store" };

/**
 * POST /api/intercepta/pay  {versionId, verifier: honest|rogue|greedy, mode: screened|preview, product: verification|markdown}
 *
 * Runs the Petri agent once against a seller and returns its payment record:
 * the 402, every Intercepta call, the decision, and the settlement when it paid.
 * The payer key never leaves the server. One blocking request: an honest run
 * takes about a minute (Intercepta, `petri verify`, a Sepolia transaction).
 *
 * This spends the payer's USDC, so a production build runs it only with
 * PETRI_PAY_LIVE=1.
 */
export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === "production" && process.env.PETRI_PAY_LIVE?.trim() !== "1") {
    return Response.json(
      { ok: false, code: "live_payments_off", detail: "Set PETRI_PAY_LIVE=1 to let this deployment pay verifiers. Locally, use npm run dev." },
      { status: 403, headers: NO_STORE },
    );
  }
  const body = (await request.json().catch(() => ({}))) as { versionId?: unknown; verifier?: unknown; mode?: unknown; product?: unknown };
  const versionId = String(body.versionId ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{8,64}$/.test(versionId)) {
    return Response.json({ ok: false, code: "bad_version_id", detail: "8 to 64 hex characters." }, { status: 400, headers: NO_STORE });
  }
  const verifier = profileOf(typeof body.verifier === "string" ? body.verifier : null);
  const mode: PayMode = body.mode === "preview" ? "preview" : "screened";
  const product: Product = body.product === "markdown" ? "markdown" : "verification";

  const payer = getPayerConfig();
  if (!payer.ok) {
    return Response.json(
      { ok: false, code: "not_configured", detail: payer.problems.map((p) => `${p.name}: ${p.issue}`).join(" ") },
      { status: 503, headers: NO_STORE },
    );
  }
  const intercepta = getInterceptaConfig();
  const base = (process.env.PETRI_VERIFIER_URL?.trim() || request.nextUrl.origin).replace(/\/+$/, "");
  const record = await payForVerification({
    url:
      product === "markdown"
        ? `${base}/api/versions/${versionId}/markdown?seller=${verifier}`
        : `${base}/api/verifier/verify/${versionId}?verifier=${verifier}`,
    versionId,
    verifier,
    mode,
    product,
    payer: payer.config,
    intercepta: intercepta.ok ? intercepta.config : null,
  });
  return Response.json({ ok: true, record }, { headers: NO_STORE });
}

/** GET /api/intercepta/pay: the newest payment records, from petri/.petri/payments.jsonl. */
export async function GET() {
  return Response.json({ ok: true, records: readPaymentRecords(20) }, { headers: NO_STORE });
}
