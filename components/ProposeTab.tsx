"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Address, erc20Abi } from "viem";
import { useConnection, usePublicClient, useWriteContract } from "wagmi";
import type { IDKitResult, RpContext } from "@worldcoin/idkit";

import { addresses, explorerAddress, explorerTx } from "@/app/ens/_lib/ens/contracts";
import { CHAIN_ID } from "@/app/ens/_lib/wagmi";
import { moveName, shortLabel } from "@/lib/ens/name";
import type { ExportVerification, NodeStatus } from "@/lib/types";
import { QRCodeSVG } from "qrcode.react";
import verifierWallets from "@/lib/market/verifier-wallets.json";
import { NameLink } from "./BuyPanel";

/** One wallet made for each Petri verifier key. The engine signs with the key; the wallet is its address on chain. */
const VERIFIER_WALLETS = verifierWallets as Record<string, string>;

/** IDKit pulls in WASM, so keep it out of the server bundle. */
const LiveSelfieCheck = dynamic(() => import("@/app/world/live-widget"), { ssr: false });

/** What `pnpm demo:propose` wrote to the Petri folder. */
type Found = { parent: string; parentId: string; change: string; perf: number; tokens: number; speed: number; diff: string; at: number };

const PLATFORM = process.env.NEXT_PUBLIC_PETRI_ENS_ADDRESS as Address | undefined;
const STAKE = 5_000_000n; // 5 USDC, 6 decimals. The same as STAKE_USDC on the server.

type Pay = "world" | "stake";
type ServerStep = { state: "run" | "done"; detail?: string; tx?: string };
type WorldCtx = { app_id: `app_${string}`; action: string; environment: "production" | "staging" | "sandbox"; signal: string; rp_context: RpContext };

/**
 * The Propose tab: copy the commands and run them in your own terminal. The
 * demo run writes the change and its 3 claimed trade-offs to the Petri folder,
 * the tab finds them, and you submit them to the market. A World ID human
 * submits free with a real Selfie Check scan. Without World ID, the author
 * stakes 5 USDC. Every step after that is real and on Sepolia.
 */
export function ProposeTab({ parentId, name }: {
  /** The full id of the parent version. The World ID proof signs it. */
  parentId: string;
  /** The ENS name of the parent version. */
  name: string;
}) {
  const short = shortLabel(name);
  const { address, isConnected, chainId } = useConnection();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { mutateAsync: write } = useWriteContract();
  const router = useRouter();

  const [copied, setCopied] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  // The server allows the demo World ID only with PETRI_DEMO_WORLD_ID=1.
  const [demoOk, setDemoOk] = useState(false);
  const [demoRun, setDemoRun] = useState(false);
  const pc = (n: number) => `${n > 0 ? "+" : ""}${n}`;
  const cmd = `pnpm demo:propose --parent ${name} \\\n  --perf 10 --tokens -5 --speed -3 \\\n  --change "Add one repair turn after an empty reply, so a draft with no code block gets a second chance."`;

  // Look for the proposal file every 2 s, until one for this parent shows up.
  useEffect(() => {
    let live = true;
    const look = async () => {
      const res = await fetch("/api/market/proposal", { cache: "no-store" }).catch(() => null);
      const data = res ? ((await res.json()) as { proposal: Found | null; demo?: boolean }) : null;
      if (!live) return;
      setDemoOk(!!data?.demo);
      const p = data?.proposal;
      setFound(p && p.parent === short ? p : null);
    };
    void look();
    const t = window.setInterval(() => void look(), 2_000);
    return () => { live = false; window.clearInterval(t); };
  }, [short]);
  const ran = found !== null;

  const [pay, setPay] = useState<Pay>("world");
  const [stage, setStage] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [server, setServer] = useState<Record<string, ServerStep>>({});
  const [done, setDone] = useState<{ name: string; round: string; until: number } | null>(null);
  const [payTx, setPayTx] = useState<string | null>(null);
  const [world, setWorld] = useState<WorldCtx | null>(null);
  const [worldOpen, setWorldOpen] = useState(false);
  const settled = useRef(false);

  const reset = () => { setError(null); setFailed(false); setServer({}); setDone(null); setPayTx(null); };
  const fail = (e: unknown) => {
    setError((e as { shortMessage?: string }).shortMessage ?? (e as Error).message);
    setFailed(true);
  };

  /** Sends the proposal and ticks each step as the platform streams it. */
  const submit = async (proof: { result?: IDKitResult; txHash?: string; demo?: boolean }) => {
    setStage(2);
    const res = await fetch("/api/market/submit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent: parentId, wallet: address, proposal: { claim: { change: found!.change, perf: found!.perf, tokens: found!.tokens, speed: found!.speed }, diff: found!.diff }, ...proof }),
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = JSON.parse(buf.slice(0, nl)) as { step?: string; state?: "run" | "done"; detail?: string; tx?: string; name?: string; round?: string; until?: number; error?: string };
        buf = buf.slice(nl + 1);
        if (line.error) throw new Error(line.error);
        if (line.step === "done") setDone({ name: line.name!, round: line.round!, until: line.until! });
        else if (line.step) setServer((s0) => ({ ...s0, [line.step!]: { state: line.state!, detail: line.detail, tx: line.tx } }));
      }
    }
    setStage(3);
    // The new version is in the market state now, so the tree shows it under the parent.
    router.refresh();
  };

  const startWorld = async () => {
    reset();
    setDemoRun(false);
    setStage(0);
    try {
      // A fresh rp_context per attempt: a single-use nonce that lives 300 s. The signal is the parent id.
      const res = await fetch("/api/market/submit/context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: parentId }) });
      const ctx = (await res.json()) as { ok: boolean; error?: string } & WorldCtx;
      if (!ctx.ok) throw new Error(ctx.error ?? "World ID is not configured.");
      settled.current = false;
      setWorld(ctx);
      setWorldOpen(true);
      setStage(1);
    } catch (e) { fail(e); }
  };

  /** The World ID step without a scan: the same flow, recorded on ENS as free:demo. */
  const startDemo = async () => {
    reset();
    setDemoRun(true);
    setStage(0);
    await new Promise((r) => window.setTimeout(r, 600));
    setStage(1);
    await new Promise((r) => window.setTimeout(r, 900));
    try { await submit({ demo: true }); } catch (e) { fail(e); }
  };

  const onWorldResult = async (result: IDKitResult) => {
    settled.current = true;
    setWorldOpen(false);
    try { await submit({ result }); } catch (e) { fail(e); }
  };

  const stake = async () => {
    if (!address || !client || !PLATFORM) return;
    reset();
    try {
      setStage(0);
      const est = await client.estimateFeesPerGas();
      const tip = est.maxPriorityFeePerGas * 3n > 3_000_000_000n ? est.maxPriorityFeePerGas * 3n : 3_000_000_000n;
      const hash = await write({
        address: addresses.MockUSDC, abi: erc20Abi, functionName: "transfer", args: [PLATFORM, STAKE], chainId: CHAIN_ID,
        maxPriorityFeePerGas: tip, maxFeePerGas: est.maxFeePerGas * 2n + tip,
      });
      setPayTx(hash);
      setStage(1);
      await client.waitForTransactionReceipt({ hash, pollingInterval: 1_000 });
      await submit({ txHash: hash });
    } catch (e) { fail(e); }
  };

  const busy = stage !== null && stage < 3 && !failed;

  /** Every step, always on screen: done, running (a spinner), waiting, or failed. */
  const flow = stage === null ? null : (() => {
    const mine = (at: number) => (at < stage ? "done" : at === stage ? (failed ? "fail" : "run") : "wait");
    const theirs = (key: string) => {
      const got = server[key];
      if (got?.state === "done" || stage > 2) return "done";
      if (got?.state === "run") return failed ? "fail" : "run";
      return "wait";
    };
    const detail = (key: string, wait: ReactNode) => server[key]?.detail ?? wait;
    const rows: { what: string; state: string; note: ReactNode; tx?: string }[] = [
      ...(pay === "world" ? [
        { what: "The platform opens a World ID request", state: mine(0), note: "Selfie Check, signed for this parent version" },
        demoRun
          ? { what: "Demo World ID", state: mine(1), note: "no phone scan. ENS records it as free:demo" }
          : { what: "Scan the QR code with World App", state: mine(1), note: "a live face on your phone. No account, no wallet" },
      ] : [
        { what: `Stake 5 USDC in MetaMask`, state: mine(0), note: "a transfer to the platform wallet" },
        { what: "Stake confirmed on Sepolia", state: mine(1), note: payTx ? <a href={explorerTx(payTx)} target="_blank" rel="noreferrer">{payTx.slice(0, 10)}…</a> : "waiting for the block" },
      ]),
      { what: pay === "world" ? "The platform checks your proof" : "The platform checks your stake", state: theirs("check"), note: detail("check", pay === "world" ? "with the World Developer Portal. 3 free submits a day" : "5 USDC, used once") },
      { what: "Intercepta checks your wallet", state: theirs("screen"), note: detail("screen", "Quick Scan: any record of scams, sanctions or blacklists. A flagged wallet stops here") },
      { what: "Your version gets its ENS name", state: theirs("name"), tx: server.name?.tx, note: server.name?.detail ? <NameLink name={server.name.detail} /> : "the next v<n> in the pending folder" },
      { what: "The records and your claim are written", state: theirs("records"), tx: server.records?.tx, note: detail("records", "petri.claim, marked as a claim until verifiers measure it") },
      { what: "The change is encrypted onto the name", state: theirs("files"), tx: server.files?.tx, note: detail("files", "harness.md and the patch. Only picked verifiers get the key") },
      { what: "The verify round opens", state: theirs("round"), tx: server.round?.tx, note: done ? <><NameLink name={done.round} /> · until {new Date(done.until * 1000).toLocaleTimeString()}</> : detail("round", "5 minutes to join. World ID verifiers weigh more") },
    ];
    return (
      <ol className="buy-flow" aria-live="polite">
        {rows.map((r, i) => (
          <li key={i} className={`buy-step ${r.state}`}>
            <span className="buy-mark" aria-hidden="true">{r.state === "done" ? "✓" : r.state === "fail" ? "✕" : r.state === "run" ? <span className="spinner" /> : i + 1}</span>
            <span>
              <b>{r.what}</b><small> · {r.note}</small>
              {r.tx && <small> · <a href={explorerTx(r.tx)} target="_blank" rel="noreferrer">tx {r.tx.slice(0, 8)}…</a></small>}
            </span>
          </li>
        ))}
      </ol>
    );
  })();

  return (
    <div className="act-tab propose">
      {world && (
        <LiveSelfieCheck
          appId={world.app_id} action={world.action} rpContext={world.rp_context} signal={world.signal} environment={world.environment}
          open={worldOpen}
          onOpenChange={(open) => {
            setWorldOpen(open);
            if (!open && !settled.current) { settled.current = true; fail(new Error("The World ID sheet was closed before a proof came back.")); }
          }}
          onResult={(r) => void onWorldResult(r)}
          onFailure={(code) => { settled.current = true; setWorldOpen(false); fail(new Error(`World App: ${code}`)); }}
        />
      )}

      <p className="eyebrow">Propose · from {short}</p>
      <h2>Propose a change to {short}</h2>

      <section className="propose-step act-steps">
        <h3><span className="propose-n">1</span>Run it in your terminal <span className="tag-demo">Demo run</span></h3>
        <p className="muted">From the <code>petri</code> folder of the repo. Set your change and your 3 claims, + is better. The command writes the patch and the claim, and does not change the log.</p>
        {[{ what: "Read the digest", c: "pnpm petri digest" }, { what: "Propose the change", c: cmd }].map((x) => (
          <div key={x.c}>
            <p className="checkit-what">{x.what}</p>
            <div className="checkit-cmd">
              <code>{x.c}</code>
              <button type="button" className="btn btn-sm" onClick={() => { void navigator.clipboard?.writeText(x.c); setCopied(x.c); }}>{copied === x.c ? "Copied" : "Copy"}</button>
            </div>
          </div>
        ))}
      </section>

      <section className={`propose-step${ran ? "" : " is-off"}`}>
        <h3><span className="propose-n">2</span>Your proposal</h3>
        {!found ? (
          <p className="muted"><span className="spinner spinner-inline" /> Waiting for the command…</p>
        ) : (
          <div className="found">
            <p><b>{found.change}</b></p>
            <div className="found-stats">
              <span><em>Performance</em>{pc(found.perf)}%</span>
              <span><em>Token savings</em>{pc(found.tokens)}%</span>
              <span><em>Speed</em>{pc(found.speed)}%</span>
            </div>
            <p className="muted">Your claim against {short}. It stays a claim until the verifiers measure it. Made {new Date(found.at).toLocaleTimeString()}.</p>
            <details className="term-diff">
              <summary>Show the change · 3 new functions</summary>
              <pre>{found.diff.split("\n").map((l, i) => <div key={i} className={l.startsWith("+") ? "d-add" : l.startsWith("-") ? "d-del" : "d-head"}>{l}</div>)}</pre>
            </details>
          </div>
        )}
      </section>

      <section className={`propose-step${ran ? "" : " is-off"}`}>
        <h3><span className="propose-n">3</span>Submit it to the market</h3>
        <div className="pay-pick" role="radiogroup" aria-label="How you submit">
          <label className={pay === "world" ? "on" : ""}>
            <input type="radio" name={`pay-${short}`} checked={pay === "world"} disabled={!ran || busy} onChange={() => setPay("world")} />
            <b>World ID · free</b><small>A unique human submits free, 3 a day. Intercepta checks your wallet&apos;s history too.</small>
          </label>
          <label className={pay === "stake" ? "on" : ""}>
            <input type="radio" name={`pay-${short}`} checked={pay === "stake"} disabled={!ran || busy} onChange={() => setPay("stake")} />
            <b>No World ID · stake 5 USDC</b><small>The stake stops spam. Intercepta checks your wallet before it counts.</small>
          </label>
        </div>
        {pay === "world" ? (
          <div className="propose-row">
            <button type="button" className="btn btn-primary" disabled={!ran || busy || !isConnected} onClick={() => void startWorld()}>{isConnected ? "Verify with World ID" : "Connect your wallet first"}</button>
            {demoOk && <button type="button" className="btn" disabled={!ran || busy || !isConnected} onClick={() => void startDemo()}>Demo World ID · no scan</button>}
          </div>
        ) : (
          <button type="button" className="btn btn-primary" disabled={!ran || busy || !isConnected || chainId !== CHAIN_ID} onClick={() => void stake()}>
            {isConnected ? "Stake 5 USDC and submit" : "Connect your wallet first"}
          </button>
        )}
        {flow}
        {error && <p className="err">{error}</p>}
        {done && <p className="propose-done">In the market: <NameLink name={done.name} />. Verifiers can join the round now.</p>}
      </section>
    </div>
  );
}

type DemoRound = {
  id: string; version: string; verifier: string; wallet: string; until: number;
  txs: Record<string, string | undefined>; vote?: string; closed?: boolean;
  /** The verifier name's expiry, read from its registry, and whether it still resolves. */
  expiry: number; live: boolean;
};

/**
 * The Verify tab. The World ID scan and the stake are demo steps. After them,
 * the platform writes for real on Sepolia: the round and your verifier name
 * (10 minutes), your verifier wallet, and the access control that lets only
 * that wallet write petri.vote. You re-run the version with `pnpm demo:verify`,
 * vote on chain with `pnpm demo:vote`, and the platform closes the access.
 */
export function VerifyTab({ versionId, name, scored, status, verifications = [], reason = "" }: {
  /** The full id of the version. */
  versionId: string;
  /** The ENS name of the version. The CLI takes its label, v<n>, as the id. */
  name: string;
  scored: boolean;
  status: NodeStatus;
  /** The checks by other keys, from the log. */
  verifications?: ExportVerification[];
  /** Why the version has its status. */
  reason?: string;
}) {
  const short = shortLabel(name);
  const pending = moveName(name, "pending");
  const [how, setHow] = useState<"world" | "stake">("world");
  const price = 5;
  // The person's own wallet. Intercepta checks it before the platform opens any access.
  const { address: person, isConnected: connected } = useConnection();
  // 0 nothing yet · 1 the scan or the stake runs · 2 the platform writes · 3 picked · 4 the key is sealed · 5 the files are open
  const [stage, setStage] = useState(0);
  const [server, setServer] = useState<Record<string, ServerStep>>({});
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [ran, setRan] = useState(false);
  const [round, setRound] = useState<DemoRound | null>(null);
  const [copied, setCopied] = useState("");
  const [clock, setClock] = useState(0);
  // A demo code, the same for one version every time.
  const code = [...pending].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(36).toUpperCase().padStart(8, "X").slice(0, 8).replace(/^(.{4})/, "$1-");

  // The real verify writes to the log. LiveRefresh announces it.
  useEffect(() => {
    const on = () => { if (stage >= 5) setRan(true); };
    window.addEventListener("petri:detected", on);
    return () => window.removeEventListener("petri:detected", on);
  }, [stage]);

  // A demo round that already ran for this version shows as it ended.
  useEffect(() => {
    void fetch("/api/market/demo-verify", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ round: DemoRound | null }>)
      .then((d) => {
        if (d.round?.id !== versionId) return;
        setRound(d.round);
        setClock(Math.floor(Date.now() / 1000));
        setStage(5);
        setRan(true);
      })
      .catch(() => {});
    // The × on the tree starts the demo again.
    const reset = () => { setStage(0); setServer({}); setFiles(null); setRan(false); setRound(null); setError(null); };
    window.addEventListener("petri:demo-reset", reset);
    return () => window.removeEventListener("petri:demo-reset", reset);
  }, [versionId]);

  // A yes vote with the access closed: the tree shows the version accepted.
  useEffect(() => {
    if (round?.closed && round.vote?.startsWith("yes")) window.dispatchEvent(new CustomEvent("petri:voted", { detail: versionId }));
  }, [round?.closed, round?.vote, versionId]);

  // After the join, read the round every 2 s: the vote and the close come from the terminal.
  useEffect(() => {
    if (stage < 3 || round?.closed) return;
    const look = async () => {
      const res = await fetch("/api/market/demo-verify", { cache: "no-store" }).catch(() => null);
      const data = res ? ((await res.json()) as { round: DemoRound | null }) : null;
      if (data?.round && data.round.id === versionId) setRound(data.round);
      setClock(Math.floor(Date.now() / 1000));
    };
    void look();
    const t = window.setInterval(() => void look(), 2_000);
    return () => window.clearInterval(t);
  }, [stage, versionId, round?.closed]);

  const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
  /** The platform writes the round, your name and the access control, then the files open. */
  const join = async () => {
    setError(null);
    setServer({});
    setStage(2);
    try {
      const res = await fetch("/api/market/demo-verify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ step: "join", id: versionId, human: how, person }),
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = JSON.parse(buf.slice(0, nl)) as { step?: string; state?: "run" | "done"; detail?: string; tx?: string; error?: string };
          buf = buf.slice(nl + 1);
          if (line.error) throw new Error(line.error);
          if (line.step && line.step !== "done") setServer((s0) => ({ ...s0, [line.step!]: { state: line.state!, detail: line.detail, tx: line.tx } }));
        }
      }
      setStage(3);
      await wait(800);
      setStage(4);
      const got = await fetch(`/api/market/verifier-files?id=${versionId}`, { cache: "no-store" }).catch(() => null);
      const data = got ? ((await got.json()) as { ok: boolean; files?: Record<string, string> }) : null;
      await wait(600);
      setFiles(data?.ok && data.files ? data.files : {});
      setStage(5);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const stake = async () => { setStage(1); await wait(1500); await join(); };

  const theirs = (key: string) => (server[key]?.state === "done" || stage >= 3 ? "done" : server[key]?.state === "run" ? (error ? "fail" : "run") : "wait");
  const secs = round ? Math.max(0, round.expiry - clock) : 0;
  const left = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const expires = round ? new Date(round.expiry * 1000).toLocaleTimeString() : "";
  const rows: { what: string; state: string; note: ReactNode; tx?: string }[] = stage < 1 ? [] : [
    { what: how === "world" ? "World ID approved" : `${price} USDC staked`, state: stage >= 2 ? "done" : "run", note: how === "world" ? "a unique human, weight 3 · demo" : "weight 1 · demo" },
    { what: "Intercepta checks your wallet", state: theirs("screen"), note: server.screen?.detail ?? "Quick Scan: any record of scams, sanctions or blacklists. A flagged wallet gets no name and no access" },
    {
      what: "Your verifier name", state: theirs("verifier"), tx: server.verifier?.tx ?? round?.txs.verifier,
      note: (server.verifier?.detail ?? round?.verifier)
        ? <><NameLink name={(server.verifier?.detail ?? round?.verifier)!} /> · {round ? (round.live ? `expires ${expires} · ${left} left` : `expired at ${expires}`) : "10 minutes"}</>
        : "verifier1.<version> · 10 minutes",
    },
    { what: "Access control open", state: theirs("open"), tx: server.open?.tx ?? round?.txs.open, note: server.open?.detail ?? "only your verifier wallet may write petri.vote" },
    { what: "The file key is sealed onto your name", state: stage >= 4 ? "done" : stage === 3 ? "run" : "wait", note: "only you open it" },
    { what: "Open your key and decrypt the files", state: stage >= 5 ? "done" : stage === 4 ? "run" : "wait", note: files ? `${Object.keys(files).length} files` : "in this browser only" },
    { what: ran ? "Your verify run is signed" : "Run the verify", state: ran ? "done" : stage >= 5 ? "run" : "wait", note: ran ? "the record landed in the log" : "step 2 or 3 below" },
    { what: round?.vote ? `You voted ${round.vote}` : "Vote on chain", state: round?.vote ? "done" : ran ? "run" : "wait", note: round?.vote ? "your wallet wrote petri.vote" : "step 4 below" },
    { what: "Access control closed", state: round?.closed ? "done" : round?.vote ? "run" : "wait", tx: round?.txs.close, note: round?.closed ? "your wallet can write petri.vote no more" : "after your vote" },
  ];

  const cmd = `pnpm demo:verify ${short}`;
  const voteCmd = `pnpm demo:vote ${short} yes`;
  const prompt = [
    `You are a Petri verifier. You were picked to verify ${pending}.`,
    "1. Go to the petri folder of this repo and run: pnpm install",
    `2. Run: ${cmd}`,
    "   It makes your verifier key in ~/my-verifier if you have none, then re-runs the version and its parent and signs the result.",
    `3. If it is better than the parent, run: ${voteCmd}   Else run: pnpm demo:vote ${short} no`,
    "4. Tell me the delta it printed and the vote transaction.",
  ].join("\n");
  const copyBox = (c: string) => (
    <div className="checkit-cmd">
      <code>{c}</code>
      <button type="button" className="btn btn-sm" onClick={() => { void navigator.clipboard?.writeText(c); setCopied(c); }}>{copied === c ? "Copied" : "Copy"}</button>
    </div>
  );

  // An accepted or rejected version, or the demo round once its vote is in and the access
  // is closed: the round is over, and nobody may join or vote. Every step shows its tx.
  if (round?.closed || (status !== "pending" && !round)) {
    return <ClosedView short={short} name={name} status={round?.vote ? (round.vote.startsWith("yes") ? "accepted" : "rejected") : status} round={round} verifications={verifications} reason={reason} />;
  }

  return (
    <div className="act-tab propose">
      <p className="eyebrow">Verify · {short}</p>
      <h2>Verify {short}</h2>

      <section className="propose-step">
        <h3><span className="propose-n">1</span>Join the verify round</h3>
        <div className="pay-pick" role="radiogroup" aria-label="How you join">
          <label className={how === "world" ? "on" : ""}>
            <input type="radio" name={`join-${short}`} checked={how === "world"} disabled={stage > 0} onChange={() => setHow("world")} />
            <b>World ID · weight 3</b><small>A unique human, three times as likely to be picked. Intercepta checks the wallet&apos;s history too.</small>
          </label>
          <label className={how === "stake" ? "on" : ""}>
            <input type="radio" name={`join-${short}`} checked={how === "stake"} disabled={stage > 0} onChange={() => setHow("stake")} />
            <b>Stake 5 USDC · weight 1</b><small>No World ID. Intercepta checks your wallet. You lose the stake if your vote disagrees with the result.</small>
          </label>
        </div>
        {how === "world" ? (
          stage === 0 ? (
            <button type="button" className="btn btn-primary" disabled={!connected} onClick={() => setStage(1)}>{connected ? "Scan with World ID" : "Connect your wallet first"}</button>
          ) : stage === 1 ? (
            <div className="scan">
              <QRCodeSVG value={`https://world.org/verify?code=${code}`} size={148} />
              <div>
                <p><b>Scan with World App</b> <span className="tag-demo">Demo</span></p>
                <p className="muted">Or open World App and enter the code</p>
                <p className="scan-code">{code}</p>
                <p className="muted"><span className="spinner spinner-inline" /> Waiting for World App…</p>
                <button type="button" className="btn" onClick={() => void join()}>I approved in World App</button>
              </div>
            </div>
          ) : null
        ) : stage === 0 ? (
          <div className="propose-row">
            <button type="button" className="btn btn-primary" disabled={!connected} onClick={() => void stake()}>{connected ? `Stake ${price} USDC` : "Connect your wallet first"}</button>
            <span className="tag-demo">Demo</span>
          </div>
        ) : null}

        {rows.length > 0 && (
          <ol className="buy-flow" aria-live="polite">
            {rows.map((r, i) => (
              <li key={i} className={`buy-step ${r.state}`}>
                <span className="buy-mark" aria-hidden="true">{r.state === "done" ? "✓" : r.state === "fail" ? "✕" : r.state === "run" ? <span className="spinner" /> : i + 1}</span>
                <span>
                  <b>{r.what}</b><small> · {r.note}</small>
                  {r.tx && <small> · <a href={explorerTx(r.tx)} target="_blank" rel="noreferrer">tx {r.tx.slice(0, 8)}…</a></small>}
                </span>
              </li>
            ))}
          </ol>
        )}
        {error && <p className="err">{error}</p>}
        {files && Object.keys(files).length > 0 && (
          <details className="term-diff">
            <summary>Show the {Object.keys(files).length} files</summary>
            {Object.entries(files).map(([f, text]) => (
              <details key={f} className="vfile">
                <summary><code>{f}</code> <small>{text.split("\n").length} lines</small></summary>
                <pre>{text}</pre>
              </details>
            ))}
          </details>
        )}
      </section>

      <section className={`propose-step act-steps${stage >= 5 ? "" : " is-off"}`}>
        <h3><span className="propose-n">2</span>Give it to your AI</h3>
        <p className="muted">Paste this into your coding agent, such as Claude Code, in a clone of the repo.</p>
        {copyBox(prompt)}
      </section>

      <section className={`propose-step act-steps${stage >= 5 ? "" : " is-off"}`}>
        <h3><span className="propose-n">3</span>Or run it yourself</h3>
        <p className="muted">
          {scored
            ? "From the petri folder. It makes your verifier key in ~/my-verifier when you have none, then re-runs this version and its parent and signs the result. The author's own key is refused."
            : "A version with no score cannot be verified. Score it live first, then another key signs it."}
        </p>
        {copyBox(cmd)}
      </section>

      <section className={`propose-step act-steps${ran || round?.vote ? "" : " is-off"}`}>
        <h3><span className="propose-n">4</span>Vote on chain</h3>
        <p className="muted">Your verifier wallet writes petri.vote on your verifier name. Only it may. Then the platform closes the access.</p>
        {copyBox(voteCmd)}
        {round?.closed && <p className="propose-done">You voted {round.vote}. The access control is closed. <NameLink name={round.verifier} /> expires by itself.</p>}
      </section>
    </div>
  );
}

type Access = { holders: string[]; hasRole: boolean | null };
type VerifierRecords = Record<string, { value: string; tx: string; time: number } | null>;

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const txLink = (h?: string) => (h ? <a href={explorerTx(h)} target="_blank" rel="noreferrer">tx {h.slice(0, 10)}…</a> : null);
/** The win margin of the acceptance rule, in basis points. */
const WIN_BP = 1000;
const bp = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n)}bp`;

/**
 * The round is over. For a version of the log: its 2 verifiers, each with the
 * Sepolia tx that wrote it to the name. For the demo round: each step's tx.
 * Then one line from the chain: no wallet may write petri.vote now.
 */
function ClosedView({ short, name, status, round, verifications, reason }: {
  short: string; name: string; status: string; round: DemoRound | null; verifications: ExportVerification[]; reason: string;
}) {
  const [access, setAccess] = useState<Access | null>(null);
  const [records, setRecords] = useState<VerifierRecords | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/market/access${round ? `?wallet=${round.wallet}` : ""}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<Access & { ok: boolean }>)
      .then((d) => { if (live && d.ok) setAccess(d); })
      .catch(() => {});
    if (!round) {
      fetch(`/api/market/verifiers?name=${encodeURIComponent(name)}`, { cache: "no-store" })
        .then((r) => r.json() as Promise<{ ok: boolean; records: VerifierRecords }>)
        .then((d) => { if (live && d.ok) setRecords(d.records); })
        .catch(() => {});
    }
    return () => { live = false; };
  }, [round, name]);

  const row = (key: string, what: ReactNode, note: ReactNode, ok = true) => (
    <li key={key} className={`buy-step ${ok ? "done" : "run"}`}>
      <span className="buy-mark" aria-hidden="true">{ok ? "✓" : <span className="spinner" />}</span>
      <span><b>{what}</b><small> · {note}</small></span>
    </li>
  );
  const counted = verifications.filter((v) => v.counted).slice(0, 2);
  const expires = round ? new Date(round.expiry * 1000).toLocaleTimeString() : "";

  return (
    <div className="act-tab propose">
      <p className="eyebrow">Verify · {short}</p>
      <h2>{short} is {status}. Its round is closed.</h2>
      <ol className="buy-flow">
        {round ? (
          <>
            {row("mint", "Your verifier name was minted", <><NameLink name={round.verifier} /> · owned by {shortAddr(round.wallet)} · {txLink(round.txs.verifier)}</>)}
            {row("open", "Access opened", <>{shortAddr(round.wallet)} may write petri.vote · {txLink(round.txs.open)}</>)}
            {row("vote", <>Verifier 1 <span className={round.vote?.startsWith("yes") ? "said-yes" : "said-no"}>{round.vote?.startsWith("yes") ? "accepted" : "rejected"}</span> · <a className="vkey" href={explorerAddress(round.wallet as `0x${string}`)} target="_blank" rel="noreferrer">{round.wallet}</a></>,
              <>petri.vote = {round.vote} on <NameLink name={round.verifier} /> · {round.txs.vote ? txLink(round.txs.vote) : "the tx is in your terminal"}</>)}
            {row("close", "Access closed", <>the right is taken back · {txLink(round.txs.close)}</>)}
            {row("name", round.live ? "The verifier name is still live" : "The verifier name expired", round.live ? `until ${expires}` : `at ${expires}`)}
          </>
        ) : counted.length === 0 ? (
          row("none", "No verifier ran it", reason || "it stopped before any run")
        ) : (
          counted.map((v, i) => {
            const rec = records?.[`petri.verifier.${i + 1}`];
            // The rule: a win of at least WIN_BP over the parent accepts. Anything less rejects.
            const yes = v.deltaMedianBp >= WIN_BP;
            return row(`v${i}`,
              <>Verifier {i + 1} <span className={yes ? "said-yes" : "said-no"}>{yes ? "accepted" : "rejected"}</span> · {VERIFIER_WALLETS[v.runner]
                ? <a className="vkey" href={explorerAddress(VERIFIER_WALLETS[v.runner]!)} target="_blank" rel="noreferrer" title={`The wallet made for Petri key ${v.runner}`}>{VERIFIER_WALLETS[v.runner]}</a>
                : <code className="vkey" title="The verifier's Petri key (public)">{v.runner}</code>}</>,
              <>measured {bp(v.deltaMedianBp)} against the parent · on <NameLink name={name} /> as petri.verifier.{i + 1} · {rec ? txLink(rec.tx) : records ? "not on ENS yet" : "reading…"}</>, !!records);
          })
        )}
        {row("closed", "No wallet may write petri.vote now",
          access ? (round ? `checked on chain: hasRoles = ${String(access.hasRole)}` : access.holders.length === 0 ? "checked on chain: 0 wallets hold it" : `${access.holders.length} wallets still hold it`) : "reading the chain…",
          !!access)}
      </ol>
      {!round && <p className="muted">The result is on <NameLink name={name} />, petri.status = {status}.</p>}
    </div>
  );
}
