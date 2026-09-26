import { NextResponse } from "next/server";

import { getAgentConfig } from "@/lib/world/agent/config";
import { discover, probeClient } from "@/lib/world/agent/oidc";
import { getOwner, shortSub } from "@/lib/world/agent/store";

type Check = { id: string; label: string; status: "ok" | "blocked"; detail: string; fix?: string };

/** Check the agent's OIDC client end to end without starting a real approval. */
export async function GET() {
  const result = getAgentConfig();
  const checks: Check[] = [];

  if (!result.ok) {
    for (const p of result.problems) {
      checks.push({ id: p.name, label: p.name, status: "blocked", detail: p.issue, fix: p.fix });
    }
    return NextResponse.json({ configured: false, checks, owner: null });
  }
  const config = result.config;
  checks.push({
    id: "env",
    label: "Credentials",
    status: "ok",
    detail: `Client ${config.clientId} · ${config.authMethod} · issuer ${config.issuer}`,
  });

  try {
    const d = await discover(config.issuer);
    const deviceOk = typeof d.device_authorization_endpoint === "string";
    checks.push({
      id: "discovery",
      label: "OIDC discovery",
      status: deviceOk && d.issuer === config.issuer ? "ok" : "blocked",
      detail: deviceOk ? `Device endpoint: ${d.device_authorization_endpoint}` : "No device_authorization_endpoint advertised.",
    });
  } catch (err) {
    checks.push({
      id: "discovery",
      label: "OIDC discovery",
      status: "blocked",
      detail: err instanceof Error ? err.message : String(err),
      fix: "Check network access to the issuer.",
    });
    return NextResponse.json({ configured: true, checks, owner: null });
  }

  // A made-up device code: bad credentials fail as invalid_client, good ones
  // pass authentication and fail as invalid_grant.
  try {
    const probe = await probeClient(config);
    const code = String(probe.json.error ?? `HTTP ${probe.status}`);
    const authOk = code !== "invalid_client" && probe.status !== 401;
    checks.push({
      id: "client",
      label: "Client authentication",
      status: authOk ? "ok" : "blocked",
      detail: authOk
        ? `Credentials accepted (probe answered ${code}, as expected for a fake device code).`
        : `The IdP rejected the client credentials (${code}).`,
      fix: authOk ? undefined : "Check client ID, secret and WORLD_AGENT_AUTH_METHOD match the portal registration.",
    });
  } catch (err) {
    checks.push({
      id: "client",
      label: "Client authentication",
      status: "blocked",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const owner = getOwner();
  return NextResponse.json({
    configured: true,
    checks,
    owner: owner ? { sub: shortSub(owner.sub), boundAt: owner.boundAt } : null,
  });
}
