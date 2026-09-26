import { NextResponse } from "next/server";

import { getAgentConfig } from "@/lib/world/agent/config";
import { firstKid, forgeIdToken, validateIdToken } from "@/lib/world/agent/oidc";

/**
 * Run the real validator on a token signed by a key the IdP never published,
 * as if a client sent it claiming the human approved.
 */
export async function POST() {
  const result = getAgentConfig();
  if (!result.ok) return NextResponse.json({ ok: false, code: "not_configured" }, { status: 503 });
  const config = result.config;
  try {
    const token = forgeIdToken(config, await firstKid(config));
    const v = await validateIdToken(config, token, Math.floor(Date.now() / 1000) - 5);
    return NextResponse.json({ ok: true, accepted: v.ok, checks: v.checks });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "idp_unreachable", detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
