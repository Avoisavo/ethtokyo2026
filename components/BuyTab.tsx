"use client";

import { useEffect, useState } from "react";

import { ensAppUrl, shortLabel } from "@/lib/ens/name";
import { BuyPanel } from "./BuyPanel";

type Published = { version: string; files: string[]; docs: Record<string, string> };

/** The Buy tab of an accepted version: pay once, then the encrypted files it opens. */
export function BuyTab({ id, name }: { id: string; name: string }) {
  // A purchase publishes the files, so the list below reads ENS again after one.
  const [reads, setReads] = useState(0);
  return (
    <div className="buy-tab">
      <p className="eyebrow">Buy · 1 USDC</p>
      <h2>Use this harness</h2>
      <BuyPanel id={id} name={name} onOwned={() => setReads((n) => n + 1)} />
      <AgentBuy name={name} />
      <EncryptedFiles id={id} name={name} reads={reads} />
    </div>
  );
}

/**
 * The encrypted files as ENS holds them: one text record per file on the
 * version name. Anyone can read the ciphertext. Only a buyer's key opens it.
 */
function EncryptedFiles({ id, name, reads }: { id: string; name: string; reads: number }) {
  const [data, setData] = useState<Published | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The parent keys this tab by version, so a new version starts with empty state.
  useEffect(() => {
    let live = true;
    fetch(`/api/market/bought?id=${id}`, { cache: "no-store" })
      .then((res) => res.json() as Promise<Published & { ok: boolean; error?: string }>)
      .then((d) => {
        if (!live) return;
        if (d.ok) setData(d);
        else setError(d.error ?? "ENS did not answer.");
      })
      .catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [id, reads]);

  const version = data?.version ?? name;
  return (
    <section className="buy buy-enc">
      <h3>Where the encrypted files are</h3>
      <p>
        Each file is a text record <code>petri.doc.&lt;file&gt;</code> on{" "}
        <a href={ensAppUrl(version)} target="_blank" rel="noreferrer"><code>{version}</code></a>.
        Anyone can read the ciphertext. Only the key sealed to a buyer opens it.
      </p>
      {error ? (
        <p className="err">Could not read the records: {error}</p>
      ) : !data ? (
        <p>Reading the records on ENS…</p>
      ) : data.files.length === 0 ? (
        <p>Not on ENS yet. The platform encrypts the files and writes them to this name when the first buyer pays.</p>
      ) : (
        <dl className="ens-records">
          {data.files.map((f) => {
            const blob = data.docs[f] ?? "";
            return (
              <div key={f} className="ens-row">
                <dt>petri.doc.{f}</dt>
                <dd>{blob === "" ? <span className="ens-unset">not set</span> : <span title={blob}>{blob.slice(0, 64)}… ({blob.length} chars)</span>}</dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}

/**
 * The same version, bought by an agent over x402. Intercepta screens the
 * seller's wallet and the exact authorization before the agent signs, and the
 * payment settles in Circle USDC on Sepolia. See /intercepta for every attempt.
 */
function AgentBuy({ name }: { name: string }) {
  const [copied, setCopied] = useState(false);
  const cmd = `npm run agent:buy -- ${shortLabel(name)}`;
  return (
    <section className="buy act-steps">
      <h3>Or let your agent buy it · x402, screened by Intercepta</h3>
      <p>
        Run this from the repository root while the web app runs. The agent reads the 402, checks the price, the token and the
        lifetime, asks Intercepta about the seller&apos;s wallet and the exact authorization, and signs only when every check
        passes. It pays 0.01 Circle USDC on Sepolia and saves the file to <code>bought/</code>.
      </p>
      <div className="checkit-cmd">
        <code>{cmd}</code>
        <button type="button" className="btn btn-sm" onClick={() => { void navigator.clipboard?.writeText(cmd); setCopied(true); }}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <p className="muted">Every attempt, paid or stopped, is on <a href="/intercepta">the Intercepta page</a>.</p>
    </section>
  );
}
