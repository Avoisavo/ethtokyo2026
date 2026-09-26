"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { InterceptaCall, MessageScan, QuickScan } from "@/lib/intercepta/client";
import { formatUsdc, type Check } from "@/lib/intercepta/decision";
import type { PayMode, PaymentRecord, Product, VerifierProfile } from "@/lib/pay/types";

import { Dot, Row, Section, type Status } from "@/app/world/ui";
import s from "@/app/world/world.module.css";
import x from "./intercepta.module.css";

/**
 * The /intercepta page, sections 1–10. The agent buys a version's record as a
 * markdown file over x402. (The verification-run seller, POST
 * /api/verifier/verify/:versionId, still works through the API, and its old
 * records still display here.)
 *
 *   1.  Setup                 — keys, balances, engine (no Intercepta request spent)
 *   2.  The job               — what to buy, a version, a seller, pay or preview
 *   3.  HTTP 402              — what the verifier asked for
 *   4.  Petri's limits        — fee cap, asset, authorization lifetime
 *   5.  Quick Scan on payTo   — Intercepta, before the authorization exists
 *   6.  The authorization     — EIP-3009 typed data + Intercepta Scan Message
 *   7.  Decision              — pay, hold or reject; signed or not
 *   8.  The seller's side     — payer screen, Sepolia settlement, the file or petri verify
 *   9.  Stopped payments      — every held, rejected or refused attempt
 *   10. Record                — petri/.petri/payments.jsonl
 *
 * The browser never sees a key. It renders what /api/intercepta/* decided.
 */

export type VersionOption = { id: string; short: string; label: string; hypothesis: string; status: string; keys: number; scored: boolean };

type PreCheck = { id: string; label: string; status: "ok" | "blocked" | "warn"; detail: string; fix?: string };
type Preflight = {
  checks: PreCheck[];
  payer: string | null;
  verifier: { payTo: string; relayer: string; rogue: string; fee: string; markdownFee: string; greedyFee: string; screenPayer: boolean } | null;
};

const EXPLORER = "https://sepolia.etherscan.io";
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

const OUTCOME: Record<PaymentRecord["outcome"], { text: string; status: Status }> = {
  paid: { text: "Paid and settled", status: "pass" },
  held: { text: "Held before signing", status: "info" },
  rejected: { text: "Rejected before signing", status: "fail" },
  previewed: { text: "Preview: built, not signed", status: "info" },
  pending: { text: "Paid, settlement not confirmed yet", status: "info" },
  refused: { text: "Signed, refused by the seller", status: "fail" },
  error: { text: "Error", status: "fail" },
};

/** Formats atomic USDC from verifier data without trusting its shape: a bad value never crashes the page. */
const usdc = (atomic: unknown): string => (typeof atomic === "string" && /^\d+$/.test(atomic) ? formatUsdc(BigInt(atomic)) : String(atomic));


/** Saves the bought file in the browser. */
function download(file: string, markdown: string) {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: file });
  a.click();
  URL.revokeObjectURL(url);
}

const checkStatus = (c: Check | undefined): Status =>
  !c ? "idle" : c.status === "pass" ? "pass" : c.status === "fail" ? "fail" : c.status === "hold" ? "info" : "idle";

export default function PayFlow({
  versions,
  initialVersion,
  missing,
  initialRecords,
}: {
  versions: VersionOption[];
  initialVersion: string;
  missing: string[];
  initialRecords: PaymentRecord[];
}) {
  const [pre, setPre] = useState<Preflight | null>(null);
  const [preBusy, setPreBusy] = useState(false);
  const product: Product = "markdown";
  const [versionId, setVersionId] = useState(initialVersion);
  const [verifier, setVerifier] = useState<VerifierProfile>("rogue");
  const [busy, setBusy] = useState<PayMode | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<PaymentRecord[]>(initialRecords);
  const [current, setCurrent] = useState<PaymentRecord | null>(null);

  // Any version can be bought as markdown. Only a scored one can be verified.
  const choices = useMemo(() => versions.filter((v) => product === "markdown" || v.scored), [versions, product]);
  const vid = choices.some((v) => v.id === versionId) ? versionId : (choices[0]?.id ?? "");

  const runPreflight = useCallback(async () => {
    setPreBusy(true);
    try {
      const res = await fetch("/api/intercepta/preflight", { cache: "no-store" });
      setPre((await res.json()) as Preflight);
    } finally {
      setPreBusy(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/intercepta/preflight", { cache: "no-store" })
      .then((res) => res.json() as Promise<Preflight>)
      .then((data) => {
        if (alive) setPre(data);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // An honest run takes about a minute. Show the clock while it runs.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [busy]);

  const pay = useCallback(
    async (mode: PayMode) => {
      setBusy(mode);
      setError(null);
      const t = Date.now();
      setStartedAt(t);
      setNow(t);
      try {
        const res = await fetch("/api/intercepta/pay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ versionId: vid, verifier, mode, product }),
        });
        const data = (await res.json()) as { ok: boolean; record?: PaymentRecord; code?: string; detail?: string };
        if (!data.ok || !data.record) {
          setError(`${data.code ?? res.status}: ${data.detail ?? ""}`);
          return;
        }
        setCurrent(data.record);
        setRecords((prev) => [data.record!, ...prev].slice(0, 20));
        if (data.record.outcome === "paid") void runPreflight();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [vid, verifier, product, runPreflight],
  );

  const r = current;
  // Records written before markdown existed carry no product: they are verification runs.
  const shownProduct: Product = r ? (r.product ?? "verification") : product;
  const checks = r?.decision?.checks ?? [];
  const find = (id: Check["id"]) => checks.find((c) => c.id === id);
  const quick = r?.intercepta.find((c) => c.endpoint === "quick-scan") as InterceptaCall<QuickScan> | undefined;
  const message = r?.intercepta.find((c) => c.endpoint === "scan-message") as InterceptaCall<MessageScan> | undefined;
  const payerScreen = r?.verifierReply?.payerScreen;
  const td = r?.typedData as { domain?: Record<string, unknown>; message?: Record<string, string>; primaryType?: string } | null;

  /* ------------------------------------------------------------------ status */

  const s1: Status = missing.length > 0 ? "fail" : !pre ? "idle" : pre.checks.some((c) => c.status === "blocked") ? "fail" : pre.checks.some((c) => c.status === "warn") ? "info" : "pass";
  const s3: Status = !r ? "idle" : r.requirements ? "pass" : "fail";
  const limits = [find("limit"), find("asset"), find("validity")].filter(Boolean) as Check[];
  const s4: Status = !r || r.mode === "preview" ? "idle" : limits.some((c) => c.status === "fail") ? "fail" : limits.length ? "pass" : "idle";
  const s5: Status = !r || r.mode === "preview" ? "idle" : checkStatus(find("payto"));
  const authC = find("authorization");
  const msgC = find("message");
  const s6: Status =
    !r || !r.typedData
      ? "idle"
      : r.mode === "preview"
        ? "info"
        : authC?.status === "fail" || msgC?.status === "fail"
          ? "fail"
          : msgC?.status === "hold" || (authC?.status === "pass" && (!msgC || msgC.status === "skipped"))
            ? "info"
            : authC
              ? "pass"
              : "idle";
  const s7: Status = !r ? "idle" : r.mode === "preview" ? "info" : !r.decision ? "fail" : { pay: "pass", hold: "info", reject: "fail" }[r.decision.action] as Status;
  const settlement = r?.verifierReply?.settlement;
  const s8: Status = !r?.sent ? "idle" : r.outcome === "paid" ? "pass" : r.outcome === "pending" ? "info" : "fail";
  const stopped = records.filter((p) => p.outcome === "held" || p.outcome === "rejected" || p.outcome === "refused");
  const s9: Status = stopped.length ? "pass" : "idle";

  const summary: [number, string, Status][] = [
    [1, "Setup", s1],
    [2, "The job", r ? OUTCOME[r.outcome].status : "idle"],
    [3, "HTTP 402", s3],
    [4, "Petri's limits", s4],
    [5, "Quick Scan: payTo", s5],
    [6, "Authorization", s6],
    [7, "Decision", s7],
    [8, "Seller's side", s8],
    [9, "Stopped payments", s9],
    [10, "Record", records.length ? "pass" : "idle"],
  ];

  const selected = versions.find((v) => v.id === vid);
  const md = product === "markdown";
  const role = md ? "seller" : "verifier";
  const cards = useMemo(
    () =>
      [
        {
          id: "honest" as const,
          name: `Honest ${role}`,
          fee: (md ? pre?.verifier?.markdownFee : pre?.verifier?.fee) ?? "0.01 USDC",
          payTo: pre?.verifier?.payTo,
          note: md ? "A clean wallet. Settles on Sepolia, then sends the file." : "A clean wallet. Runs a real petri verify and settles on Sepolia.",
        },
        {
          id: "rogue" as const,
          name: `Rogue ${role}`,
          fee: (md ? pre?.verifier?.markdownFee : pre?.verifier?.fee) ?? "0.01 USDC",
          payTo: pre?.verifier?.rogue,
          note: "Its payout wallet is on Intercepta's known-risk list (a sanctioned mainnet address). It never receives funds.",
        },
        { id: "greedy" as const, name: `Greedy ${role}`, fee: pre?.verifier?.greedyFee ?? "0.75 USDC", payTo: pre?.verifier?.payTo, note: "Asks more than Petri's per-payment limit." },
      ] satisfies { id: VerifierProfile; name: string; fee: string; payTo?: string; note: string }[],
    [pre, md, role],
  );

  return (
    <div className={s.column}>
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
      <Section n={1} title="Setup" status={s1} statusText={{ pass: "Ready", fail: "Blocked", info: "Ready, with warnings", idle: "Checking…" }[s1]}>
        <p>
          Two wallets and one key. The Petri agent pays with Sepolia USDC and needs no ETH. The seller&apos;s relayer
          pays the gas to settle. Intercepta screens every payment. This check spends no Intercepta request.
        </p>
        {missing.length > 0 ? (
          <div className={s.error}>
            <strong>Not configured.</strong> Add to <code>.env.local</code>, then restart <code>npm run dev</code>:
            <ul>
              {missing.map((m) => (
                <li key={m}>
                  <code>{m}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className={s.actions}>
          <button className="btn" onClick={runPreflight} disabled={preBusy}>
            {preBusy ? "Checking…" : "Check again"}
          </button>
        </div>
        {pre ? (
          <ul className={s.checks}>
            {pre.checks.map((c) => (
              <li key={c.id}>
                <Dot status={c.status === "ok" ? "pass" : c.status === "warn" ? "info" : "fail"} />
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
      <Section n={2} title="The job: the agent buys a version as markdown" status={r ? OUTCOME[r.outcome].status : "idle"} statusText={r ? OUTCOME[r.outcome].text : "Not run yet"}>
        <label className={s.select}>
          Version
          <select value={vid} onChange={(e) => setVersionId(e.target.value)}>
            {choices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.short} · {v.status} · {v.keys} key{v.keys === 1 ? "" : "s"} · {v.label}
              </option>
            ))}
          </select>
        </label>
        {selected ? <p className="muted">{selected.hypothesis}</p> : null}
        <div className={x.cards} role="radiogroup" aria-label="Seller">
          {cards.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={verifier === c.id}
              className={`${x.card} ${verifier === c.id ? x.cardOn : ""}`}
              onClick={() => setVerifier(c.id)}
            >
              <span className={x.cardName}>{c.name}</span>
              <span className={x.cardFee}>{c.fee}</span>
              <code className={x.cardAddr}>{c.payTo ? short(c.payTo) : "—"}</code>
              <span className="muted">{c.note}</span>
            </button>
          ))}
        </div>
        <div className={s.actions}>
          <button className="btn btn-primary" onClick={() => pay("screened")} disabled={busy != null || !vid}>
            {busy === "screened" ? `Paying… ${Math.round((now - startedAt) / 1000)} s` : md ? "Pay and download" : "Pay and verify"}
          </button>
          <button className="btn" onClick={() => pay("preview")} disabled={busy != null || !vid}>
            {busy === "preview" ? "Building…" : "Preview without screening"}
          </button>
        </div>
        <p className="muted">
          <strong>Preview</strong> is the agent before this feature: it takes the 402 and builds the authorization it
          would sign, with no checks. It never signs. An honest paid run makes three Intercepta scans and one Sepolia
          transaction{md ? "." : <>, plus a real <code>petri verify</code> (~22 s).</>}
        </p>
        {error ? <div className={s.error}>{error}</div> : null}
      </Section>

      {/* ------------------------------------------------------------ 3 */}
      <Section n={3} title="The seller asks for payment (HTTP 402)" status={s3} statusText={{ pass: "402 received", fail: "No 402", info: "", idle: "Not run yet" }[s3]}>
        {r?.requirements ? (
          <dl className={s.fields}>
            <Row k="Scheme" v={`${r.requirements.scheme} (x402 v2)`} />
            <Row k="Network" v={r.requirements.network} />
            <Row k="Amount" v={usdc(r.requirements.amount)} />
            <Row k="Token" v={r.requirements.asset} />
            <Row k="payTo" v={r.requirements.payTo} />
            <Row k="Valid for" v={`${r.requirements.maxTimeoutSeconds} s`} />
          </dl>
        ) : r ? (
          <div className={s.error}>{r.error ?? "The verifier did not answer with a payment request."}</div>
        ) : (
          <p className="muted">The seller&apos;s price, token and wallet appear here, decoded from its PAYMENT-REQUIRED header.</p>
        )}
      </Section>

      {/* ------------------------------------------------------------ 4 */}
      <Section n={4} title="Petri's own limits (no network)" status={s4} statusText={{ pass: "Within limits", fail: "Refused", info: "", idle: r?.mode === "preview" ? "Skipped in preview" : "Not run yet" }[s4]}>
        <p>
          Checked before any Intercepta request is spent. x402&apos;s spend controls enforce the same cap a second time
          inside the x402 client.
        </p>
        <CheckList checks={limits} empty={r?.mode === "preview" ? "Preview skips every check." : "Not run yet."} />
      </Section>

      {/* ------------------------------------------------------------ 5 */}
      <Section
        n={5}
        title="Intercepta Quick Scan on payTo"
        status={s5}
        statusText={{ pass: "Clear", fail: "Blocked", info: "Held", idle: r?.mode === "preview" ? "Skipped in preview" : "Not run yet" }[s5]}
      >
        <p>
          Runs in x402&apos;s <code>onBeforePaymentCreation</code> hook, before the authorization exists. Intercepta has no
          testnet data, so it scores this address by its mainnet history.
        </p>
        {find("payto") ? <CheckList checks={[find("payto")!]} /> : null}
        {quick ? <QuickScanView call={quick} /> : <p className="muted">{r && r.mode !== "preview" && !find("payto") ? "Not reached: an earlier check stopped the payment." : "Not run yet."}</p>}
      </Section>

      {/* ------------------------------------------------------------ 6 */}
      <Section
        n={6}
        title="The payment authorization and Intercepta Scan Message"
        status={s6}
        statusText={{ pass: "Matches, clear", fail: "Refused", info: r?.mode === "preview" ? "Built, not signed" : msgC?.status === "hold" ? "Held" : "Matches; Scan Message off", idle: "Not built" }[s6]}
      >
        <p>
          The x402 scheme builds an EIP-3009 <code>TransferWithAuthorization</code> and hands it to Petri&apos;s signer. The
          signer checks it against the 402 and sends the exact typed data to Scan Message, under mainnet chain id 1. It
          signs only after both pass.
        </p>
        {td?.message && td.primaryType === "TransferWithAuthorization" ? (
          <dl className={s.fields}>
            <Row k="Type" v={td.primaryType ?? "—"} />
            <Row k="from" v={td.message.from} />
            <Row k="to" v={td.message.to} />
            <Row k="value" v={usdc(td.message.value)} />
            <Row k="validBefore" v={new Date(Number(td.message.validBefore) * 1000).toLocaleTimeString()} />
            <Row k="nonce" v={short(td.message.nonce)} />
            <Row k="Token (domain)" v={`${String(td.domain?.name)} v${String(td.domain?.version)} · chain ${String(td.domain?.chainId)}`} />
          </dl>
        ) : td ? (
          <pre className={x.raw}>{JSON.stringify(td, null, 2)}</pre>
        ) : (
          <p className="muted">{r && r.mode === "screened" ? "Not built: an earlier check stopped the payment." : "Not built yet."}</p>
        )}
        {r?.mode === "preview" && r.typedData ? (
          <div className={s.locked}>
            <strong>Without screening, the agent signs this now</strong>, sending {td?.message?.value ? usdc(td.message.value) : "the fee"} to{" "}
            <code>{td?.message?.to}</code>. The preview stopped here. Nothing was signed.
          </div>
        ) : null}
        <CheckList checks={[authC, msgC].filter(Boolean) as Check[]} />
        {message ? <MessageView call={message} /> : null}
      </Section>

      {/* ------------------------------------------------------------ 7 */}
      <Section n={7} title="Decision" status={s7} statusText={r ? (r.mode === "preview" ? "Preview" : (r.decision?.action.toUpperCase() ?? "No decision")) : "Not run yet"}>
        {r && r.mode === "screened" && r.decision ? (
          <div className={`${x.verdict} ${x[`verdict_${r.decision.action}`]}`}>
            <span className={x.verdictWord}>{r.decision.action.toUpperCase()}</span>
            <code>{r.decision.code}</code>
            {r.decision.reasons.length ? (
              <ul>
                {r.decision.reasons.map((why) => (
                  <li key={why}>{why}</li>
                ))}
              </ul>
            ) : (
              <span className="muted">Every check passed.</span>
            )}
          </div>
        ) : null}
        {r ? (
          <div className={r.signed ? s.unlocked : s.locked}>
            {r.signed ? (
              <>
                <strong>Signed and sent</strong> to the seller.{" "}
                {r.outcome === "paid"
                  ? "It settled on Sepolia."
                  : r.outcome === "pending"
                    ? "The transfer was broadcast and is not confirmed yet. Check the transaction below."
                    : "The seller did not settle it. An unsettled authorization stays valid until its validBefore."}
              </>
            ) : (
              <>
                <strong>Signature: not created.</strong> Nothing left the wallet.
              </>
            )}
          </div>
        ) : (
          <p className="muted">Reject beats hold, and hold beats pay. Any error, timeout or missing scan holds.</p>
        )}
      </Section>

      {/* ------------------------------------------------------------ 8 */}
      <Section n={8} title={`The seller's side: payer screen, settlement, ${shownProduct === "markdown" ? "the file" : "petri verify"}`} status={s8} statusText={{ pass: "Settled", fail: "Refused", info: "", idle: r?.signed ? "" : "Not reached" }[s8]}>
        <p>
          The seller checks the signature with its in-process facilitator and screens the payer with Intercepta in
          x402&apos;s <code>onAfterVerify</code> hook.{" "}
          {shownProduct === "markdown" ? (
            <>Then it settles on Sepolia and sends the file.</>
          ) : (
            <>
              Then it runs <code>petri verify</code> with its own key and settles only after the report exists.
            </>
          )}
        </p>
        {r?.sent ? (
          <>
            {payerScreen ? <CheckList checks={[payerScreen.check]} /> : null}
            {r.verifierReply?.repeat ? (
              <div className={s.locked}>
                <strong>Demo repeat run.</strong> This verifier&apos;s key had already reported on this version, so this report
                is stored but does not count. Without demo mode the verifier refuses before asking for money.
              </div>
            ) : null}
            {r.delivered ? (
              <>
                <div className={s.unlocked}>
                  <strong>Delivered:</strong> <code>{r.delivered.file}</code> ({r.delivered.bytes} bytes){" "}
                  <button className="btn btn-sm" onClick={() => download(r.delivered!.file, r.delivered!.markdown)}>
                    Download
                  </button>
                </div>
                <pre className={x.raw}>{r.delivered.markdown}</pre>
              </>
            ) : null}
            {r.verifierReply?.verification ? (
              <dl className={s.fields}>
                <Row k="Report" v={r.verifierReply.verification.report} />
                <Row k="Runner" v={short(r.verifierReply.verification.runner)} />
                <Row k="Delta" v={`${r.verifierReply.verification.deltaMedianBp} bp`} />
                <Row k="Version status" v={`${r.verifierReply.verification.status} (${r.verifierReply.verification.statusCode})`} />
              </dl>
            ) : null}
            {settlement?.transaction ? (
              <div className={settlement.success ? s.unlocked : s.locked}>
                <strong>{settlement.success ? "Settled on Sepolia:" : `Not confirmed (${settlement.errorReason ?? "unknown"}):`}</strong>{" "}
                <a href={`${EXPLORER}/tx/${settlement.transaction}`} target="_blank" rel="noreferrer">
                  {short(settlement.transaction)} ↗
                </a>
              </div>
            ) : null}
            {r.outcome !== "paid" && r.outcome !== "pending" ? (
              <div className={s.error}>
                <code>{r.verifierReply?.code ?? r.verifierReply?.status}</code> {r.refusedReason ? `(${r.refusedReason}) ` : ""}
                {r.verifierReply?.detail ?? ""}
              </div>
            ) : null}
          </>
        ) : (
          <p className="muted">Reached only when Petri signs and sends the payment.</p>
        )}
      </Section>

      {/* ------------------------------------------------------------ 9 */}
      <Section n={9} title="Stopped payments" status={s9} statusText={stopped.length ? `${stopped.length} stopped` : "None yet"}>
        <p>Try the rogue seller (Intercepta blocks it) and the greedy one (over Petri&apos;s limit).</p>
        {stopped.length ? (
          <table className={s.table}>
            <thead>
              <tr>
                <th>Seller · product</th>
                <th>Stopped by</th>
                <th>Code</th>
                <th>Signed?</th>
                <th>Funds moved?</th>
              </tr>
            </thead>
            <tbody>
              {stopped.map((p) => {
                const by = p.decision?.checks.find((c) => c.status === "fail" || c.status === "hold");
                return (
                  <tr key={p.id} className={p.id === r?.id ? s.chosen : undefined}>
                    <td>
                      {p.verifier} · {(p.product ?? "verification") === "markdown" ? ".md" : "verify"}
                      <div className="muted">{new Date(p.at).toLocaleTimeString()}</div>
                    </td>
                    <td>{p.outcome === "refused" ? "Verifier" : (by?.label ?? "Petri agent")}</td>
                    <td>
                      <code>{p.outcome === "refused" ? (p.refusedReason ?? p.verifierReply?.code) : (p.decision?.code ?? p.outcome)}</code>
                    </td>
                    <td>{p.signed ? "Yes" : "No"}</td>
                    <td>{p.verifierReply?.settlement?.transaction ? "Maybe: see the transaction" : "No"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="muted">No stopped payments yet.</p>
        )}
      </Section>

      {/* ------------------------------------------------------------ 10 */}
      <Section n={10} title="Record: petri/.petri/payments.jsonl" status={records.length ? "pass" : "idle"} statusText={`${records.length} record${records.length === 1 ? "" : "s"}`}>
        <p>Every attempt is one line, with the raw Intercepta responses. Click one to show it above.</p>
        {records.length ? (
          <table className={s.table}>
            <thead>
              <tr>
                <th>When</th>
                <th>Seller · product</th>
                <th>Version</th>
                <th>Outcome</th>
                <th>Intercepta</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {records.map((p) => (
                <tr key={p.id} className={p.id === r?.id ? s.chosen : undefined} onClick={() => setCurrent(p)} style={{ cursor: "pointer" }}>
                  <td>{new Date(p.at).toLocaleTimeString()}</td>
                  <td>
                    {p.verifier} · {(p.product ?? "verification") === "markdown" ? ".md" : "verify"}
                    {p.mode === "preview" ? <span className="muted"> (preview)</span> : null}
                  </td>
                  <td>
                    <code>{p.versionId.slice(0, 8)}</code>
                  </td>
                  <td>
                    <Dot status={OUTCOME[p.outcome].status} /> {OUTCOME[p.outcome].text}
                  </td>
                  <td>
                    {p.intercepta.map((c) => `${c.endpoint} ${c.ok ? c.status : "error"} ${c.latencyMs} ms${c.cached ? " (cached)" : ""}`).join(" · ") || "—"}
                  </td>
                  <td>{(p.elapsedMs / 1000).toFixed(1)} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No records yet.</p>
        )}
        {r ? (
          <details>
            <summary>Raw record</summary>
            <pre className={x.raw}>{JSON.stringify(r, null, 2)}</pre>
          </details>
        ) : null}
      </Section>
    </div>
  );
}

function CheckList({ checks, empty }: { checks: Check[]; empty?: string }) {
  if (!checks.length) return empty ? <p className="muted">{empty}</p> : null;
  return (
    <ul className={s.checks}>
      {checks.map((c) => (
        <li key={c.id}>
          <Dot status={checkStatus(c)} />
          <div>
            <strong>{c.label}</strong> <code>{c.code}</code>
            <div className="muted">{c.detail}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function QuickScanView({ call }: { call: InterceptaCall<QuickScan> }) {
  return (
    <>
      <dl className={s.fields}>
        <Row k="Address" v={call.subject} />
        <Row k="HTTP" v={`${call.status ?? "no answer"} in ${call.latencyMs} ms${call.cached ? " (cached)" : " (live)"}`} />
        {call.ok ? <Row k="Toxic score" v={String(call.body.toxicScore)} /> : <Row k="Error" v={call.error} />}
      </dl>
      {call.ok && call.body.traits.length ? (
        <table className={s.table}>
          <thead>
            <tr>
              <th>Trait</th>
              <th>Risk</th>
              <th>Intercepta says</th>
            </tr>
          </thead>
          <tbody>
            {call.body.traits.map((t) => (
              <tr key={t.name}>
                <td>
                  <code>{t.name}</code>
                </td>
                <td>{t.risk}</td>
                <td>{t.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <details>
        <summary>Raw Quick Scan response</summary>
        <pre className={x.raw}>{JSON.stringify(call.ok ? call.body : { error: call.error }, null, 2)}</pre>
      </details>
    </>
  );
}

function MessageView({ call }: { call: InterceptaCall<MessageScan> }) {
  return (
    <>
      <dl className={s.fields}>
        <Row k="HTTP" v={`${call.status ?? "no answer"} in ${call.latencyMs} ms`} />
        {call.ok ? (
          <>
            <Row k="Message type" v={call.body.messageType ?? "not recognised"} />
            <Row k="Risk group" v={call.body.riskGroup} />
            <Row k="Detectors" v={call.body.detectors.map((d) => d.code).join(", ") || "none"} />
            <Row
              k="Addresses"
              v={(call.body.addresses ?? []).map((a) => `${short(a.address)}${a.detectors.length ? ` [${a.detectors.join(", ")}]` : ""}`).join(" · ") || "none"}
            />
          </>
        ) : (
          <Row k="Error" v={call.error} />
        )}
      </dl>
      <details>
        <summary>Raw Scan Message response</summary>
        <pre className={x.raw}>{JSON.stringify(call.ok ? call.body : { error: call.error }, null, 2)}</pre>
      </details>
    </>
  );
}
