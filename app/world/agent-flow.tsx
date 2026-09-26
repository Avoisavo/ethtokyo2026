"use client";

import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";

import { Dot, Row, Section, type Status } from "./ui";
import s from "./world.module.css";

/**
 * World ID for Agents, sections 6–11:
 *
 *   6.  Agent integration      — OIDC client config + live preflight
 *   7.  Agent asks for approval — device authorization, user code + QR
 *   8.  Backend validation     — ID token signature, issuer, audience, freshness
 *   9.  Protected agent action — runs only after 8 passes
 *   10. Unsuccessful path      — denied, expired, cancelled, forged, other human
 *   11. Integration debrief
 *
 * The browser never sees the client secret, the device code or the ID token.
 * It only renders what /api/world/agent/* decided.
 */

export type AgentPageConfig =
  | { ok: true; clientId: string; issuer: string }
  | { ok: false; missing: string[] };

type PreCheck = { id: string; label: string; status: "ok" | "blocked"; detail: string; fix?: string };
type Check = { id: string; label: string; status: "pass" | "fail"; detail: string };

type Attempt = {
  id: string;
  task: { label: string; detail: string };
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  startedAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled" | "rejected" | "error";
  code?: string;
  detail?: string;
  checks?: Check[];
  subShort?: string;
  acr?: string;
  authTime?: number;
  executed?: { at: number; receipt: string };
};

type LogRow = { at: number; path: string; code: string; detail: string; stoppedBy: string };

const PATH_LABEL: Record<string, string> = {
  denied: "Human denied",
  expired: "Request expired",
  cancelled: "Cancelled by agent",
  rejected: "Token rejected",
  error: "IdP error",
};

export default function AgentFlow({ config }: { config: AgentPageConfig }) {
  const [pre, setPre] = useState<PreCheck[] | null>(null);
  const [owner, setOwner] = useState<{ sub: string; boundAt: number } | null>(null);
  const [preBusy, setPreBusy] = useState(false);

  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [timeout, setTimeoutSec] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [log, setLog] = useState<LogRow[]>([]);
  const [executed, setExecuted] = useState<{ at: number; receipt: string; task: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  const runPreflight = useCallback(async () => {
    setPreBusy(true);
    try {
      const res = await fetch("/api/world/agent/preflight", { cache: "no-store" });
      const data = (await res.json()) as { checks: PreCheck[]; owner: typeof owner };
      setPre(data.checks);
      setOwner(data.owner);
    } finally {
      setPreBusy(false);
    }
  }, []);

  /** Fold a finished attempt into the log / the executed action. */
  const settle = useCallback((a: Attempt) => {
    if (a.status === "approved" && a.executed) {
      setExecuted({ ...a.executed, task: a.task.label });
    } else if (a.status !== "pending") {
      setLog((prev) => [
        {
          at: Date.now(),
          path: PATH_LABEL[a.status] ?? a.status,
          code: a.code ?? a.status,
          detail: a.detail ?? "",
          stoppedBy: a.status === "denied" ? "Human (World approval page)" : a.status === "cancelled" ? "Agent" : "Backend",
        },
        ...prev,
      ]);
    }
  }, []);

  // Poll the backend while an attempt is pending. The server paces the calls
  // to the IdP by its `interval`; this only asks "anything new?".
  useEffect(() => {
    if (attempt?.status !== "pending") return;
    const id = attempt.id;
    const t = setInterval(async () => {
      setNow(Date.now());
      const res = await fetch("/api/world/agent/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = (await res.json()) as { attempt?: Attempt };
      if (!data.attempt) return;
      setAttempt(data.attempt);
      if (data.attempt.status !== "pending") {
        settle(data.attempt);
        if (data.attempt.status === "approved") void runPreflight();
      }
    }, 2000);
    return () => clearInterval(t);
  }, [attempt?.id, attempt?.status, settle, runPreflight]);

  const start = useCallback(async () => {
    setBusy("start");
    setStartError(null);
    try {
      const res = await fetch("/api/world/agent/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeoutSeconds: timeout || undefined }),
      });
      const data = (await res.json()) as { ok: boolean; attempt?: Attempt; code?: string; detail?: string };
      if (!data.ok || !data.attempt) {
        setStartError(`${data.code}: ${data.detail ?? ""}`);
        return;
      }
      setNow(Date.now());
      setAttempt(data.attempt);
    } finally {
      setBusy(null);
    }
  }, [timeout]);

  const cancel = useCallback(async () => {
    if (!attempt) return;
    const res = await fetch("/api/world/agent/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: attempt.id }),
    });
    const data = (await res.json()) as { attempt?: Attempt };
    if (data.attempt) {
      setAttempt(data.attempt);
      if (data.attempt.status === "cancelled") settle(data.attempt);
    }
  }, [attempt, settle]);

  const forged = useCallback(async () => {
    setBusy("forged");
    try {
      const res = await fetch("/api/world/agent/forged", { method: "POST" });
      const data = (await res.json()) as { ok: boolean; accepted?: boolean; checks?: Check[]; detail?: string };
      const failed = data.checks?.find((c) => c.status === "fail");
      setLog((prev) => [
        {
          at: Date.now(),
          path: "Forged ID token",
          code: data.accepted ? "ACCEPTED" : `invalid_${failed?.id ?? "token"}`,
          detail: data.ok ? (failed?.detail ?? "") : (data.detail ?? "Request failed"),
          stoppedBy: "Backend",
        },
        ...prev,
      ]);
    } finally {
      setBusy(null);
    }
  }, []);

  const resetOwner = useCallback(async () => {
    setBusy("reset");
    try {
      await fetch("/api/world/agent/reset", { method: "POST" });
      await runPreflight();
      setResetMsg(
        `Owner cleared at ${new Date().toLocaleTimeString()}. The next approval binds a new owner. To test a different human, bind one World ID first, then approve the next request with another.`,
      );
    } finally {
      setBusy(null);
    }
  }, [runPreflight]);

  /* ------------------------------------------------------------------ status */

  const s6: Status = !config.ok
    ? "fail"
    : pre == null
      ? "info"
      : pre.some((c) => c.status === "blocked")
        ? "fail"
        : "pass";
  const s7: Status =
    attempt == null
      ? "idle"
      : attempt.status === "approved"
        ? "pass"
        : attempt.status === "rejected" || attempt.status === "error"
          ? "fail"
          : "info";
  const s8: Status = !attempt?.checks ? "idle" : attempt.checks.every((c) => c.status === "pass") ? "pass" : "fail";
  const s9: Status = executed ? "pass" : "idle";
  const s10: Status = log.length === 0 ? "idle" : log.some((r) => r.code === "ACCEPTED") ? "fail" : "pass";

  const s7Text =
    attempt == null
      ? "Not tested yet"
      : {
          pending: "Waiting for the human",
          approved: "Human approved",
          denied: "Denied",
          expired: "Expired",
          cancelled: "Cancelled",
          rejected: "Rejected",
          error: `Error: ${attempt.code}`,
        }[attempt.status];

  const summary: [number, string, Status][] = [
    [6, "Agent integration", s6],
    [7, "Approval request", s7],
    [8, "Backend validation", s8],
    [9, "Protected action", s9],
    [10, "Unsuccessful path", s10],
    [11, "Integration debrief", "pass"],
  ];

  const secondsLeft = attempt ? Math.max(0, Math.round((attempt.expiresAt - now) / 1000)) : 0;

  return (
    <div className={s.column}>
      <header className={s.head}>
        <span className="tag tag-real">Best Use of World ID for Agents · sections 6–11</span>
        <h2 className={s.colTitle}>An AI agent can&apos;t spend your money until you approve it with World ID</h2>
        <p className={s.lede}>
          Before running a payment, the agent asks for approval. You approve on World&apos;s approval page with a fresh proof (mocked in the event sandbox). The
          backend validates the ID token and checks that the approver is the agent&apos;s owner. Only then does the
          action run.
        </p>
      </header>

      <ol className={s.summary} aria-label="Agent section status">
        {summary.map(([n, label, st]) => (
          <li key={n}>
            <a href={`#s${n}`}>
              <Dot status={st} />
              <span className={s.num}>{n}</span>
              <span>{label}</span>
            </a>
          </li>
        ))}
      </ol>

      {/* ------------------------------------------------------------ 6 */}
      <Section
        n={6}
        title="World ID for Agents integration"
        status={s6}
        statusText={{ pass: "Working", fail: "Blocked", info: "Configured, preflight not run", idle: "" }[s6]}
      >
        <p>
          The agent&apos;s backend is a confidential OIDC client of the sandbox World ID IdP. It uses the{" "}
          <strong>device authorization grant</strong>: the agent never needs a browser callback, and every approval
          requires a fresh World ID proof.
        </p>
        {config.ok ? (
          <dl className={s.fields}>
            <Row k="Issuer" v={config.issuer} />
            <Row k="Client ID" v={config.clientId} />
            <Row k="Grant" v="device_code" />
            <Row k="Agent owner" v={owner ? `${owner.sub} (bound)` : "none yet, first approval binds it"} />
          </dl>
        ) : (
          <div className={s.error}>
            <strong>Not configured.</strong> Add to <code>.env.local</code>:
            <ul>
              {config.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        <div className={s.actions}>
          <button className="btn" onClick={runPreflight} disabled={preBusy}>
            {preBusy ? "Checking…" : "Run preflight"}
          </button>
        </div>
        {pre ? (
          <ul className={s.checks}>
            {pre.map((c) => (
              <li key={c.id}>
                <Dot status={c.status === "ok" ? "pass" : "fail"} />
                <div>
                  <strong>{c.label}</strong> <span className="muted">{c.detail}</span>
                  {c.fix ? <div className={s.fix}>Fix: {c.fix}</div> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {/* ------------------------------------------------------------ 7 */}
      <Section n={7} title="Agent asks the human for approval" status={s7} statusText={s7Text}>
        <div className={s.task}>
          <div className="muted">Agent task</div>
          <strong>Send 25 USDC to merchant.eth</strong>
          <div className="muted">
            The agent found an invoice and wants to pay it on your behalf. The transfer is simulated; no funds move.
          </div>
        </div>
        <div className={s.actions}>
          <button
            className="btn btn-primary"
            onClick={start}
            disabled={!config.ok || busy != null || attempt?.status === "pending"}
          >
            {busy === "start" ? "Requesting…" : "Run agent task"}
          </button>
          <label className={s.select}>
            Approval window
            <select value={timeout} onChange={(e) => setTimeoutSec(Number(e.target.value))}>
              <option value={0}>20 min (World default)</option>
              <option value={30}>30 s (to test expiry)</option>
            </select>
          </label>
        </div>
        {startError ? <div className={s.error}>{startError}</div> : null}
        {attempt?.status === "pending" ? (
          <div className={s.approval}>
            <div className={s.qr}>
              <QRCodeSVG value={attempt.verificationUriComplete} size={148} marginSize={2} />
            </div>
            <div className={s.approvalText}>
              <div className="muted">Open the link (or scan with your phone camera) and approve on World&apos;s page. Check the code matches.</div>
              <div className={s.userCode}>{attempt.userCode}</div>
              <a href={attempt.verificationUriComplete} target="_blank" rel="noreferrer">
                Open approval link ↗
              </a>
              <div className="muted">Expires in {secondsLeft}s · checking every few seconds</div>
              <div>
                <button className="btn" onClick={cancel}>
                  Cancel request
                </button>
              </div>
            </div>
          </div>
        ) : attempt ? (
          <p className="muted">
            Last request: <code>{attempt.status}</code>
            {attempt.code ? (
              <>
                {" "}
                (<code>{attempt.code}</code>)
              </>
            ) : null}
            . Run the task again to make a new request.
          </p>
        ) : null}
      </Section>

      {/* ------------------------------------------------------------ 8 */}
      <Section
        n={8}
        title="Validate the result on the backend"
        status={s8}
        statusText={{ pass: "Valid", fail: "Rejected", info: "", idle: "Not tested yet" }[s8]}
      >
        <p>
          When World approves, the backend redeems the device code for an ID token and validates it itself: the RS256
          signature against World&apos;s JWKS, issuer, audience, expiry, and <code>auth_time</code> inside this attempt.
          It also checks that the approver is the agent&apos;s owner. The browser never gets the token.
        </p>
        {attempt?.checks ? (
          <>
            <ul className={s.checks}>
              {attempt.checks.map((c) => (
                <li key={c.id}>
                  <Dot status={c.status} />
                  <div>
                    <strong>{c.label}</strong> <span className="muted">{c.detail}</span>
                  </div>
                </li>
              ))}
            </ul>
            <dl className={s.fields}>
              <Row k="Subject (pairwise)" v={attempt.subShort ?? "—"} />
              <Row k="acr" v={attempt.acr ?? "—"} />
              <Row
                k="Proved at"
                v={attempt.authTime ? new Date(attempt.authTime * 1000).toLocaleTimeString() : "—"}
              />
            </dl>
          </>
        ) : (
          <p className="muted">Nothing to validate yet. Approve a request in section 7.</p>
        )}
      </Section>

      {/* ------------------------------------------------------------ 9 */}
      <Section
        n={9}
        title="Protected agent action"
        status={s9}
        statusText={{ pass: "Executed", fail: "", info: "", idle: "Locked" }[s9]}
      >
        <div className={executed ? s.unlocked : s.locked}>
          <strong>Send 25 USDC to merchant.eth:</strong>{" "}
          {executed
            ? `Executed at ${new Date(executed.at).toLocaleTimeString()} · receipt ${executed.receipt} (simulated)`
            : "Locked. It runs only after section 8 passes."}
        </div>
      </Section>

      {/* ------------------------------------------------------------ 10 */}
      <Section
        n={10}
        title="Unsuccessful path: the action does not run"
        status={s10}
        statusText={
          {
            pass: `${log.length} unsuccessful attempt${log.length === 1 ? "" : "s"}, action blocked`,
            fail: "A forged token was accepted",
            info: "",
            idle: "Not tested yet",
          }[s10]
        }
      >
        <p>
          To test these: click <strong>Deny</strong> on World&apos;s approval page, choose the 30 s window and let it expire, click{" "}
          <strong>Cancel request</strong>, or send a forged token to the real validator. To test a different human,
          reset the owner and approve from another World ID.
        </p>
        <div className={s.actions}>
          <button className="btn" onClick={forged} disabled={!config.ok || busy != null}>
            {busy === "forged" ? "Sending…" : "Forged ID token"}
          </button>
          <button className="btn" onClick={resetOwner} disabled={!config.ok || busy != null}>
            {busy === "reset" ? "Resetting…" : "Reset agent owner"}
          </button>
        </div>
        {resetMsg ? <p className="muted">{resetMsg}</p> : null}
        {log.length > 0 ? (
          <table className={s.table}>
            <thead>
              <tr>
                <th>Path</th>
                <th>Stopped by</th>
                <th>Code</th>
                <th>Action ran?</th>
              </tr>
            </thead>
            <tbody>
              {log.map((r) => (
                <tr key={r.at + r.code}>
                  <td>
                    {r.path}
                    <div className="muted">{r.detail}</div>
                  </td>
                  <td>{r.stoppedBy}</td>
                  <td>
                    <code>{r.code}</code>
                  </td>
                  <td>No</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No unsuccessful attempts yet.</p>
        )}
      </Section>

      {/* ------------------------------------------------------------ 11 */}
      <Section n={11} title="Integration debrief" status="pass" statusText="Written">
        <dl className={s.debrief}>
          <dt>Time to first success</dt>
          <dd>
            One working session on 2026-09-26: reading the guides, registering the client, writing the device flow and
            JWKS validation. The first approved and validated request ran the agent action at 7:28 PM local time. The
            only failed attempt before it was approving an old, already-cancelled code by mistake. The backend correctly
            ignored that one.
          </dd>
          <dt>Friction</dt>
          <dd>
            <ul>
              <li>
                The public <code>/docs</code> page lists no endpoints or fields. The real guides (<code>oidc</code>,{" "}
                <code>step-up</code>) are only in the MCP server, so reading them takes a JSON-RPC client.
              </li>
              <li>
                Sandbox rejects <code>http://localhost</code> callbacks, and a device-only client still has to register
                an HTTPS redirect URI it never uses.
              </li>
              <li>
                The device grant ignores <code>max_age</code>, <code>prompt</code> and <code>acr_values</code>. Freshness
                is implied, so the backend has to check <code>auth_time</code> against the attempt start itself.
              </li>
            </ul>
          </dd>
          <dt>Missing capability / docs</dt>
          <dd>
            <ul>
              <li>We found no official JS helper for the device grant plus ID-token validation, so we wrote the JWKS check ourselves.</li>
              <li>
                No binding message. The approval page shows only the user code, not <em>what</em> the agent wants to
                do. With two requests open, it&apos;s easy to approve the wrong one, which happened to us.
              </li>
            </ul>
          </dd>
          <dt>The one improvement with the biggest impact</dt>
          <dd>
            Let the agent attach a short, human-readable action description to the device request (like CIBA&apos;s{" "}
            <code>binding_message</code>) and show it on the approval screen, so people approve a specific action, not
            just a login.
          </dd>
        </dl>
      </Section>
    </div>
  );
}
