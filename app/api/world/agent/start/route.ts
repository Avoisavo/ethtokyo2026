import { NextResponse } from "next/server";

import { getAgentConfig } from "@/lib/world/agent/config";
import { startDeviceAuthorization } from "@/lib/world/agent/oidc";
import { TASK, newAttemptId, publicAttempt, saveAttempt } from "@/lib/world/agent/store";

/**
 * The agent asks for human approval before running its task.
 *
 * Starts a device authorization at the IdP. The device code stays on the
 * server; the browser only gets the user code and the approval link.
 */
export async function POST(request: Request) {
  const result = getAgentConfig();
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, code: "not_configured", detail: result.problems.map((p) => p.name).join(", ") },
      { status: 503 },
    );
  }
  const body = (await request.json().catch(() => ({}))) as { timeoutSeconds?: number };

  let started;
  try {
    started = await startDeviceAuthorization(result.config);
  } catch (err) {
    return NextResponse.json(
      { ok: false, code: "idp_unreachable", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
  const j = started.json;
  if (started.status !== 200 || !j.device_code || !j.verification_uri_complete) {
    return NextResponse.json(
      {
        ok: false,
        code: j.error ?? `http_${started.status}`,
        detail: j.error_description ?? "The IdP did not start a device authorization.",
      },
      { status: 502 },
    );
  }

  const now = Date.now();
  const timeout = Number(body.timeoutSeconds);
  const attempt = {
    id: newAttemptId(),
    task: TASK,
    deviceCode: j.device_code,
    userCode: j.user_code ?? "",
    verificationUri: j.verification_uri ?? "",
    verificationUriComplete: j.verification_uri_complete,
    startedAt: now,
    expiresAt: now + (j.expires_in ?? 1200) * 1000,
    deadline: Number.isFinite(timeout) && timeout > 0 ? now + timeout * 1000 : null,
    interval: j.interval ?? 5,
    nextPollAt: now + (j.interval ?? 5) * 1000,
    inFlight: false,
    status: "pending" as const,
  };
  saveAttempt(attempt);
  return NextResponse.json({ ok: true, attempt: publicAttempt(attempt) });
}
