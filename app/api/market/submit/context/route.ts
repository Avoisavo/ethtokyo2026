import { NextResponse } from "next/server";
import { signRequest } from "@worldcoin/idkit/signing";

import { ConfigError, requireConfig } from "@/lib/world/idkit/config";
import { SUBMIT_ACTION } from "@/lib/market/world";
import { findVersion } from "@/lib/market/service";
import { handle, body } from "../../_shared";

export const dynamic = "force-dynamic";

/**
 * A signed request for the "submit for free" proof. The signal is the version
 * id, so the proof cannot be replayed to submit another version.
 */
export async function POST(request: Request) {
  const { id } = await body<{ id?: string }>(request);
  return handle(async () => {
    let config;
    try {
      config = requireConfig();
    } catch (e) {
      if (e instanceof ConfigError) return NextResponse.json({ ok: false, error: "World ID is not configured.", problems: e.problems }, { status: 503 }) as never;
      throw e;
    }
    const v = await findVersion(String(id ?? ""));
    const signed = signRequest({ signingKeyHex: config.signingKey, action: SUBMIT_ACTION, ttl: 300 });
    return {
      app_id: config.appId,
      action: SUBMIT_ACTION,
      environment: config.environment,
      signal: v.node.id,
      rp_context: { rp_id: config.rpId, nonce: signed.nonce, created_at: signed.createdAt, expires_at: signed.expiresAt, signature: signed.sig },
    };
  });
}
