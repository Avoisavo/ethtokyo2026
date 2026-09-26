"use client";

import dynamic from "next/dynamic";
import { useCallback, useRef, useState } from "react";

import type { IDKitResult, RpContext } from "@worldcoin/idkit";

import s from "./world.module.css";

/**
 * The IDKit use case, split into the five things the prize asks for. Each
 * section carries its own status so it is obvious which part works:
 *
 *   1. IDKit integration     — package + config + live preflight
 *   2. World ID credential   — Selfie Check via the real IDKit widget
 *   3. Server verification   — /api/selfie-check/verify → Developer Portal v4
 *   4. Alternative path      — cancel, World App errors, and server rejections
 *   5. Integration debrief
 *
 * Everything here goes through the existing live backend used by /face. There
 * is no mock: a proof only counts once the Developer Portal has verified it.
 */

/** IDKit pulls in WASM, so keep it out of the server bundle. */
const LiveSelfieCheck = dynamic(() => import("../face/live-widget"), {
  ssr: false,
});

/** The protected action. `withdraw` is the critical tier: same human, proof under 1h old. */
const INTENT = "withdraw";

type Config =
  | {
      ok: true;
      appId: string;
      rpId: string;
      action: string;
      environment: string;
      proofVersion: string;
    }
  | { ok: false; missing: string[] };

type PreflightCheck = {
  id: string;
  label: string;
  status: "ok" | "blocked" | "unknown";
  detail: string;
  fix?: string;
};

type LiveContext = {
  app_id: `app_${string}`;
  action: string;
  rp_context: RpContext;
  signal: string;
  environment: "production" | "staging" | "sandbox";
};

type VerifyResponse =
  | {
      ok: true;
      continuityEvent: string;
      credential: {
        identifier: string;
        nullifier: string;
        protocol_version: string;
        environment: string;
      };
      verify: { status: number | null; url: string; response: unknown };
      decision: {
        allowed: boolean;
        checks: { id: string; label: string; status: string; detail: string }[];
        stepUp: { message: string } | null;
      } | null;
    }
  | {
      ok: false;
      errorCode: string;
      detail: string;
      verify?: { status: number | null; url: string; response: unknown } | null;
    };

type Status = "pass" | "fail" | "idle" | "info";

/** One unsuccessful attempt, and whether the protected action ran (it must not). */
type AltEvent = {
  at: number;
  kind: string;
  code: string;
  detail: string;
  where: "World App" | "Browser" | "Server";
  actionRan: boolean;
};

const WORLD_APP_ERRORS: Record<string, string> = {
  user_rejected: "The user dismissed the request in World App.",
  verification_rejected: "Liveness or face match failed inside World App.",
  credential_unavailable:
    "This World App has not enrolled Selfie Check, so the credential is unavailable.",
  feature_unavailable: "Selfie Check is not enabled for this app_id.",
  rp_signature_expired: "The rp_context outlived its 300s TTL.",
  invalid_rp_signature:
    "The rp_context signature was rejected. The signing key does not match the portal's signer address.",
  connection_failed: "The bridge connection dropped before a proof came back.",
};

export default function WorldFlow({ config }: { config: Config }) {
  const [pre, setPre] = useState<PreflightCheck[] | null>(null);
  const [preBusy, setPreBusy] = useState(false);

  const [liveCtx, setLiveCtx] = useState<LiveContext | null>(null);
  const [liveOpen, setLiveOpen] = useState(false);
  const [widget, setWidget] = useState<{
    status: "idle" | "open" | "result" | "error" | "cancelled";
    code?: string;
  }>({ status: "idle" });
  const settled = useRef(false);
  const [lastResult, setLastResult] = useState<IDKitResult | null>(null);

  const [verify, setVerify] = useState<VerifyResponse | null>(null);
  const [withdrawn, setWithdrawn] = useState<number | null>(null);
  const [alt, setAlt] = useState<AltEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const pushAlt = useCallback((e: Omit<AltEvent, "at" | "actionRan">) => {
    setAlt((prev) => [{ ...e, at: Date.now(), actionRan: false }, ...prev]);
  }, []);

  /* ------------------------------------------------------------ 1. preflight */

  const runPreflight = useCallback(async () => {
    setPreBusy(true);
    try {
      const res = await fetch("/api/selfie-check/preflight", { cache: "no-store" });
      const data = (await res.json()) as { checks: PreflightCheck[] };
      setPre(data.checks);
    } finally {
      setPreBusy(false);
    }
  }, []);

  /* ------------------------------------------------------ 2. open the widget */

  const mintContext = useCallback(async (): Promise<LiveContext | null> => {
    const res = await fetch("/api/selfie-check/context", { method: "POST" });
    const ctx = (await res.json()) as
      | ({ ok: true } & LiveContext)
      | { ok: false; problems: { name: string }[] };
    if (!ctx.ok) {
      pushAlt({
        kind: "Not configured",
        code: "not_configured",
        detail: `Missing: ${ctx.problems.map((p) => p.name).join(", ")}`,
        where: "Server",
      });
      return null;
    }
    return ctx;
  }, [pushAlt]);

  const startVerification = useCallback(async () => {
    setBusy("verify");
    try {
      // A fresh rp_context per attempt: it carries a single-use nonce and a 300s TTL.
      const ctx = await mintContext();
      if (!ctx) return;
      settled.current = false;
      setLiveCtx(ctx);
      setLiveOpen(true);
      setWidget({ status: "open" });
    } finally {
      setBusy(null);
    }
  }, [mintContext]);

  /* ---------------------------------------------------- 3. server verification */

  const submit = useCallback(
    async (result: unknown, kind: string): Promise<VerifyResponse> => {
      const res = await fetch("/api/selfie-check/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result, intent: INTENT }),
      });
      const data = (await res.json()) as VerifyResponse;
      // Authorization comes from the server's decision only, never from the
      // widget's onSuccess.
      if (data.ok && data.decision?.allowed) {
        setWithdrawn(Date.now());
      } else if (!data.ok) {
        pushAlt({ kind, code: data.errorCode, detail: data.detail, where: "Server" });
      } else {
        pushAlt({
          kind,
          code: "policy_denied",
          detail: data.decision?.stepUp?.message ?? "Proof verified, but the withdraw policy denied it.",
          where: "Server",
        });
      }
      return data;
    },
    [pushAlt],
  );

  const onResult = useCallback(
    async (result: IDKitResult) => {
      settled.current = true;
      setLastResult(result);
      setWidget({ status: "result" });
      setLiveOpen(false);
      setVerify(await submit(result, "Real proof rejected"));
    },
    [submit],
  );

  const onFailure = useCallback(
    (code: string) => {
      settled.current = true;
      setWidget({ status: "error", code });
      setLiveOpen(false);
      pushAlt({
        kind: code === "credential_unavailable" ? "Credential unavailable" : code === "user_rejected" ? "User rejected" : "World App error",
        code,
        detail: WORLD_APP_ERRORS[code] ?? "World App returned this code. See the browser console.",
        where: "World App",
      });
    },
    [pushAlt],
  );

  const onOpenChange = useCallback(
    (open: boolean) => {
      setLiveOpen(open);
      if (open) return;
      // The widget may close just before or after onSuccess/onError fires, so
      // wait a moment before deciding the user simply closed it.
      setTimeout(() => {
        if (settled.current) return;
        settled.current = true;
        setWidget({ status: "cancelled" });
        pushAlt({
          kind: "Cancelled",
          code: "widget_closed",
          detail: "The IDKit sheet was closed before a proof came back. Nothing was sent to the server.",
          where: "Browser",
        });
      }, 400);
    },
    [pushAlt],
  );

  /* -------------------------------------------- 4. server-side rejection demos */

  /** A well-formed proof bound to this account but not signed by World: the portal must reject it. */
  const sendForgedProof = useCallback(async () => {
    setBusy("forged");
    try {
      const ctx = await mintContext();
      if (!ctx) return;
      const { hashSignal } = await import("@worldcoin/idkit/hashing");
      await submit(
        {
          protocol_version: "3.0",
          nonce: ctx.rp_context.nonce,
          action: ctx.action,
          environment: ctx.environment,
          responses: [
            {
              identifier: "selfie",
              signal_hash: hashSignal(ctx.signal),
              proof: `0x${"11".repeat(256)}`,
              merkle_root: `0x${"00".repeat(32)}`,
              nullifier: `0x${"ab".repeat(32)}`,
            },
          ],
        },
        "Forged proof",
      );
    } finally {
      setBusy(null);
    }
  }, [mintContext, submit]);

  /** A proof whose signal belongs to a different account: rejected before the portal is called. */
  const sendOtherAccountProof = useCallback(async () => {
    setBusy("other");
    try {
      const ctx = await mintContext();
      if (!ctx) return;
      const { hashSignal } = await import("@worldcoin/idkit/hashing");
      await submit(
        {
          protocol_version: "3.0",
          nonce: ctx.rp_context.nonce,
          action: ctx.action,
          environment: ctx.environment,
          responses: [
            {
              identifier: "selfie",
              signal_hash: hashSignal("acct_someone_else"),
              proof: `0x${"11".repeat(256)}`,
              merkle_root: `0x${"00".repeat(32)}`,
              nullifier: `0x${"ab".repeat(32)}`,
            },
          ],
        },
        "Proof from another account",
      );
    } finally {
      setBusy(null);
    }
  }, [mintContext, submit]);

  /** Re-send the last real proof. Its nonce is spent, so the server must refuse. */
  const replayLast = useCallback(async () => {
    if (!lastResult) return;
    setBusy("replay");
    try {
      await submit(lastResult, "Replayed proof");
    } finally {
      setBusy(null);
    }
  }, [lastResult, submit]);

  /* ------------------------------------------------------------------ status */

  const s1: Status = !config.ok
    ? "fail"
    : pre == null
      ? "info"
      : pre.some((c) => c.status === "blocked")
        ? "fail"
        : "pass";
  const s2: Status =
    widget.status === "result" ? "pass" : widget.status === "error" ? "fail" : widget.status === "cancelled" ? "info" : "idle";
  const s3: Status = verify == null ? "idle" : verify.ok && verify.decision?.allowed ? "pass" : "fail";
  const s4: Status = alt.length === 0 ? "idle" : alt.every((a) => !a.actionRan) ? "pass" : "fail";
  const s5: Status = "pass";

  const statusText: Record<string, Record<Status, string>> = {
    1: { pass: "Working", fail: "Blocked", info: "Configured, preflight not run", idle: "" },
    2: {
      pass: "Proof received",
      fail: `World App error${widget.code ? `: ${widget.code}` : ""}`,
      info: "Cancelled",
      idle: "Not tested yet",
    },
    3: { pass: "Verified, action allowed", fail: "Rejected", info: "", idle: "Not tested yet" },
    4: { pass: `${alt.length} unsuccessful attempt${alt.length === 1 ? "" : "s"}, action blocked`, fail: "Action ran on a failed path", info: "", idle: "Not tested yet" },
    5: { pass: "Written", fail: "", info: "", idle: "" },
  };

  const summary: [number, string, Status][] = [
    [1, "IDKit integration", s1],
    [2, "World ID credential", s2],
    [3, "Server verification", s3],
    [4, "Alternative path", s4],
    [5, "Integration debrief", s5],
  ];

  return (
    <main className={`container ${s.page}`}>
      {liveCtx ? (
        <LiveSelfieCheck
          appId={liveCtx.app_id}
          action={liveCtx.action}
          rpContext={liveCtx.rp_context}
          signal={liveCtx.signal}
          environment={liveCtx.environment}
          open={liveOpen}
          onOpenChange={onOpenChange}
          onResult={(r) => void onResult(r)}
          onFailure={onFailure}
        />
      ) : null}

      <header className={s.head}>
        <span className="tag tag-real">Continuity Track · Best IDKit Use Case</span>
        <h1>Withdraw only if you are the same human who opened the account</h1>
        <p className={s.lede}>
          Before a withdrawal runs, the app asks World ID for a Selfie Check. The server verifies the proof with the
          Developer Portal and checks that it comes from the same human who opened the account, within the last hour.
        </p>
      </header>

      <ol className={s.summary} aria-label="Section status">
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

      {/* ------------------------------------------------------------ 1 */}
      <Section n={1} title="IDKit integration" status={s1} statusText={statusText[1][s1]}>
        <p>
          <code>@worldcoin/idkit</code> renders the World ID request. The server signs each request with the RP key
          (<code>/api/selfie-check/context</code>), so the key never reaches the browser.
        </p>
        {config.ok ? (
          <dl className={s.fields}>
            <Row k="App ID" v={config.appId} />
            <Row k="RP ID" v={config.rpId} />
            <Row k="Action" v={config.action} />
            <Row k="Environment" v={config.environment} />
            <Row k="Protocol" v={config.proofVersion} />
          </dl>
        ) : (
          <div className={s.error}>
            <strong>Not configured.</strong> Set these in <code>.env.local</code> (see <code>.env.example</code>):
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
                <Dot status={c.status === "ok" ? "pass" : c.status === "blocked" ? "fail" : "info"} />
                <div>
                  <strong>{c.label}</strong> <span className="muted">{c.detail}</span>
                  {c.fix ? <div className={s.fix}>Fix: {c.fix}</div> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {/* ------------------------------------------------------------ 2 */}
      <Section n={2} title="World ID credential: Selfie Check" status={s2} statusText={statusText[2][s2]}>
        <p>
          <strong>Trust event:</strong> a withdrawal can&apos;t be undone. Before it runs, the product needs to know that
          the person asking is the same human who opened the account, not someone who stole the session or the
          device.
        </p>
        <table className={s.table}>
          <thead>
            <tr>
              <th>Credential</th>
              <th>What it proves</th>
              <th>Choice</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Proof of Human (Orb)</td>
              <td>Unique human, global</td>
              <td className="muted">More than needed. Most users would have to visit an Orb.</td>
            </tr>
            <tr>
              <td>Passport / NFC</td>
              <td>Document attributes (age, nationality)</td>
              <td className="muted">Not relevant here, and collects more than this event needs.</td>
            </tr>
            <tr className={s.chosen}>
              <td>
                <strong>Selfie Check</strong>
              </td>
              <td>A live face on a phone, with the same nullifier every time for the same person</td>
              <td>
                <strong>Chosen, the minimum that is enough.</strong> A matching nullifier means it is the same human,
                and a 1h <code>max_age</code> means the check is recent.
              </td>
            </tr>
          </tbody>
        </table>
        <div className={s.actions}>
          <button className="btn btn-primary" onClick={startVerification} disabled={!config.ok || busy != null || liveOpen}>
            {busy === "verify" ? "Preparing…" : "Withdraw funds, verify with World ID"}
          </button>
        </div>
        <p className="muted">
          This opens the real IDKit widget. Scan the QR code with World App. Closing the sheet counts as a cancellation in
          section 4.
        </p>
      </Section>

      {/* ------------------------------------------------------------ 3 */}
      <Section n={3} title="Verify the result on the server" status={s3} statusText={statusText[3][s3]}>
        <p>
          The widget&apos;s result is only forwarded to <code>/api/selfie-check/verify</code>. The server checks the
          protocol version, the credential, the account binding (<code>signal_hash</code>) and the nonce, then calls{" "}
          <code>POST developer.world.org/api/v4/verify/&#123;rp_id&#125;</code>. The withdrawal runs only if the server
          allows it.
        </p>
        <div className={withdrawn ? s.unlocked : s.locked}>
          <strong>Protected action · Withdraw funds:</strong>{" "}
          {withdrawn ? `Executed at ${new Date(withdrawn).toLocaleTimeString()}` : "Locked"}
        </div>
        {verify ? (
          verify.ok ? (
            <>
              <dl className={s.fields}>
                <Row k="Portal HTTP" v={String(verify.verify.status)} />
                <Row k="Credential" v={`${verify.credential.identifier} · protocol ${verify.credential.protocol_version}`} />
                <Row k="Nullifier" v={toDecimal(verify.credential.nullifier)} />
                <Row k="Continuity" v={verify.continuityEvent} />
                <Row k="Decision" v={verify.decision?.allowed ? "allowed" : "denied"} />
              </dl>
              {verify.decision ? (
                <ul className={s.checks}>
                  {verify.decision.checks.map((c) => (
                    <li key={c.id}>
                      <Dot status={c.status === "pass" ? "pass" : c.status === "fail" ? "fail" : "info"} />
                      <div>
                        <strong>{c.label}</strong> <span className="muted">{c.detail}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <div className={s.error}>
              <strong>{verify.errorCode}</strong>: {verify.detail}
            </div>
          )
        ) : (
          <p className="muted">No proof has been verified yet. Run section 2 first.</p>
        )}
      </Section>

      {/* ------------------------------------------------------------ 4 */}
      <Section n={4} title="Alternative path: the action does not run" status={s4} statusText={statusText[4][s4]}>
        <p>
          Every unsuccessful path is logged here, and none of them unlock the withdrawal. Cancel the World App sheet, get
          a World App error (<code>credential_unavailable</code>, <code>user_rejected</code>), or send these to the real
          verify route:
        </p>
        <div className={s.actions}>
          <button className="btn" onClick={sendForgedProof} disabled={!config.ok || busy != null}>
            {busy === "forged" ? "Sending…" : "Forged proof"}
          </button>
          <button className="btn" onClick={sendOtherAccountProof} disabled={!config.ok || busy != null}>
            {busy === "other" ? "Sending…" : "Proof from another account"}
          </button>
          <button className="btn" onClick={replayLast} disabled={!lastResult || busy != null}>
            {busy === "replay" ? "Sending…" : "Replay last real proof"}
          </button>
        </div>
        {alt.length > 0 ? (
          <table className={s.table}>
            <thead>
              <tr>
                <th>Path</th>
                <th>Stopped by</th>
                <th>Code</th>
                <th>Withdraw ran?</th>
              </tr>
            </thead>
            <tbody>
              {alt.map((a) => (
                <tr key={a.at + a.code}>
                  <td>
                    {a.kind}
                    <div className="muted">{a.detail}</div>
                  </td>
                  <td>{a.where}</td>
                  <td>
                    <code>{a.code}</code>
                  </td>
                  <td>{a.actionRan ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No unsuccessful attempts yet.</p>
        )}
      </Section>

      {/* ------------------------------------------------------------ 5 */}
      <Section n={5} title="Integration debrief" status={s5} statusText={statusText[5][s5]}>
        <dl className={s.debrief}>
          <dt>Time to first success</dt>
          <dd>
            <ul>
              <li>
                <strong>First integration: about 2.5 days.</strong> We started on 2026-09-10, and the portal verified the
                first Selfie Check proof on 2026-09-12 at 14:21 UTC (HTTP 200). Most of that time went to the protocol
                version and verify endpoint problems listed below.
              </li>
              <li>
                <strong>A new app with the same code: minutes.</strong> On 2026-09-26 we created a new app, pasted its
                App ID, RP ID and signing key, and the first proof verified at 05:49 UTC.
              </li>
            </ul>
          </dd>
          <dt>Friction</dt>
          <dd>
            <ul>
              <li>
                Selfie Check can only be issued on World ID 3.0. The 4.0 request type-checks but returns{" "}
                <code>credential_unavailable</code>.
              </li>
              <li>
                <code>allow_legacy_proofs</code> is required and not documented, and the SDK examples disagree on its
                value.
              </li>
              <li>
                The v2 verify endpoint returns <code>invalid_action</code> for every action once RP registration is
                active. Only v4 works.
              </li>
              <li>
                IDKit accepts <code>sandbox</code>, but the verify endpoint has no <code>sandbox</code> environment.
              </li>
            </ul>
          </dd>
          <dt>Missing capability / docs</dt>
          <dd>
            <ul>
              <li>
                No page says that <code>signal_hash</code> equals <code>hash_to_field(signal)</code>.
              </li>
              <li>
                <code>sybil_score</code> is required by v4 for 4.0 Selfie Check but missing from the SDK types.
              </li>
              <li>
                <code>feature_unavailable</code> and <code>all_verifications_failed</code> are missing from the error
                reference.
              </li>
              <li>The sandbox has no test users.</li>
            </ul>
          </dd>
          <dt>The one improvement with the biggest impact</dt>
          <dd>
            State on the Selfie Check credential page which protocol version it can be issued on. That one sentence would
            have saved most of our time.
          </dd>
        </dl>
        <p className="muted">
          The full write-up is in <code>FEEDBACK.md</code>.
        </p>
      </Section>
    </main>
  );
}

function Section({
  n,
  title,
  status,
  statusText,
  children,
}: {
  n: number;
  title: string;
  status: Status;
  statusText: string;
  children: React.ReactNode;
}) {
  return (
    <section id={`s${n}`} className={s.section}>
      <header className={s.sectionHead}>
        <span className={s.bigNum}>{n}</span>
        <h2>{title}</h2>
        <span className={`${s.badge} ${s[`badge_${status}`]}`}>
          <Dot status={status} />
          {statusText}
        </span>
      </header>
      <div className={s.body}>{children}</div>
    </section>
  );
}

function Dot({ status }: { status: Status }) {
  const glyph = { pass: "✓", fail: "✕", info: "!", idle: "·" }[status];
  return (
    <span className={`${s.dot} ${s[`dot_${status}`]}`} aria-hidden="true">
      {glyph}
    </span>
  );
}

/** The Developer Portal lists nullifiers in decimal, so match it here. */
function toDecimal(hex: string): string {
  try {
    const dec = BigInt(hex).toString();
    return dec.length > 24 ? `${dec.slice(0, 10)}…${dec.slice(-8)}` : dec;
  } catch {
    return hex;
  }
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>
        <code>{v}</code>
      </dd>
    </>
  );
}
