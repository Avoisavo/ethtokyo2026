import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { getAgentConfig } from "@/lib/world-agent/config";
import { pollDeviceToken, validateIdToken } from "@/lib/world-agent/oidc";
import {
  getAttempt,
  getOwner,
  publicAttempt,
  saveAttempt,
  setOwner,
  shortSub,
  type Attempt,
} from "@/lib/world-agent/store";

/**
 * Advance one approval attempt. The browser calls this on a timer; the server
 * decides whether it is time to poll the IdP, and it alone decides whether
 * the agent's action runs.
 */
export async function POST(request: Request) {
  const result = getAgentConfig();
  if (!result.ok) return NextResponse.json({ ok: false, code: "not_configured" }, { status: 503 });
  const config = result.config;

  const { id } = (await request.json().catch(() => ({}))) as { id?: string };
  const a = id ? getAttempt(id) : undefined;
  if (!a) return NextResponse.json({ ok: false, code: "unknown_attempt" }, { status: 404 });

  const done = () => NextResponse.json({ ok: true, attempt: publicAttempt(a) });
  if (a.status !== "pending" || a.inFlight) return done();

  const now = Date.now();
  if (a.deadline != null && now >= a.deadline) {
    return finish(a, "expired", "agent_timeout", "The agent's approval window closed before the human approved.");
  }
  if (now >= a.expiresAt) {
    return finish(a, "expired", "expired_token", "The device code expired before approval.");
  }
  if (now < a.nextPollAt) return done();

  a.inFlight = true;
  try {
    const res = await pollDeviceToken(config, a.deviceCode);
    a.nextPollAt = Date.now() + a.interval * 1000;
    const err = res.json.error;

    // Cancelled while the request was in flight: never act on a late approval.
    if ((a.status as Attempt["status"]) !== "pending") return done();

    if (err === "authorization_pending") return done();
    if (err === "slow_down") {
      a.interval += 5;
      a.nextPollAt = Date.now() + a.interval * 1000;
      return done();
    }
    if (err === "access_denied") return finish(a, "denied", err, "The human denied the request in the World ID app.");
    if (err === "expired_token") return finish(a, "expired", err, "The device code expired before approval.");
    if (err || !res.json.id_token) {
      return finish(a, "error", err ?? `http_${res.status}`, res.json.error_description ?? "Token endpoint error.");
    }

    // Approved at the IdP. Now validate before trusting anything in it.
    const v = await validateIdToken(config, res.json.id_token, Math.floor(a.startedAt / 1000));
    a.checks = v.checks;
    a.subShort = v.claims.sub ? shortSub(v.claims.sub) : undefined;
    a.acr = v.claims.acr;
    a.authTime = v.claims.auth_time;
    if (!v.ok) {
      const failed = v.checks.find((c) => c.status === "fail");
      return finish(a, "rejected", `invalid_${failed?.id ?? "token"}`, failed?.detail ?? "ID token failed validation.");
    }

    // Same human as the agent's owner? The first approval binds the owner.
    const owner = getOwner();
    const sub = v.claims.sub!;
    if (owner && (owner.iss !== v.claims.iss || owner.sub !== sub)) {
      a.checks.push({
        id: "owner",
        label: "Agent owner",
        status: "fail",
        detail: `A different human approved (${shortSub(sub)}), not the owner ${shortSub(owner.sub)}.`,
      });
      return finish(a, "rejected", "identity_mismatch", "Approved by a different World ID than the agent's owner.");
    }
    if (!owner) setOwner({ iss: v.claims.iss!, sub, boundAt: Date.now() });
    a.checks.push({
      id: "owner",
      label: "Agent owner",
      status: "pass",
      detail: owner ? "Same human who owns this agent." : "First approval: this human is now bound as the agent's owner.",
    });

    // The protected agent action. Simulated: no funds move.
    a.status = "approved";
    a.executed = { at: Date.now(), receipt: `sim_${randomUUID().slice(0, 8)}` };
    saveAttempt(a);
    return done();
  } catch (e) {
    return finish(a, "error", "idp_unreachable", e instanceof Error ? e.message : String(e));
  } finally {
    a.inFlight = false;
  }
}

function finish(a: Attempt, status: Attempt["status"], code: string, detail: string) {
  a.status = status;
  a.code = code;
  a.detail = detail;
  saveAttempt(a);
  return NextResponse.json({ ok: true, attempt: publicAttempt(a) });
}
