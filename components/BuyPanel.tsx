"use client";

import { useEffect, useState } from "react";
import { type Address, erc20Abi, parseAbi } from "viem";
import { useConnection, usePublicClient, useReadContract, useSignMessage, useWriteContract } from "wagmi";

import { addresses, explorerTx } from "@/app/ens/_lib/ens/contracts";
import { CHAIN_ID } from "@/app/ens/_lib/wagmi";
import { ensAppUrl } from "@/lib/ens/name";
import { accessPublicKey, decryptText, newAccessKeyPair, openFileKey } from "@/lib/market/crypto";
import { zipFiles } from "@/lib/zip";

/** The server wallet that owns petri.eth and takes payments. */
const PLATFORM = process.env.NEXT_PUBLIC_PETRI_ENS_ADDRESS as Address | undefined;
const USDC = addresses.MockUSDC;
const PRICE = 1_000_000n; // 1 USDC, 6 decimals
const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);

/** The message the wallet signs to prove the access key is its own. Same text as the server. */
const accessMessage = (accessKey: string) => `Petri access key ${accessKey.toLowerCase()}`;

/**
 * One access key per wallet, kept in this browser. The file key is sealed to
 * its public half, so only this browser can open what the wallet bought.
 */
function accessKeyFor(wallet: string): { secretKey: string; publicKey: string } {
  const k = `petri:access:${wallet.toLowerCase()}`;
  try {
    const saved = localStorage.getItem(k);
    if (saved) return { secretKey: saved, publicKey: accessPublicKey(saved) };
  } catch { /* storage blocked: a fresh key each time */ }
  const pair = newAccessKeyPair();
  try { localStorage.setItem(k, pair.secretKey); } catch { /* ignore */ }
  return pair;
}

type Bought = { version: string; buyer: { name: string; key: string } | null; files: string[]; docs: Record<string, string> };

/**
 * Saves the opened files as one zip: `harness.md` at the top, and every other
 * file under `harness/`, the same layout as petri/harness.
 */
function downloadZip(folder: string, files: Record<string, string>): void {
  const entries = Object.fromEntries(Object.entries(files).map(([f, text]) =>
    [f === "harness.md" ? `${folder}/${f}` : `${folder}/harness/${f}`, text]));
  const url = URL.createObjectURL(new Blob([zipFiles(entries)], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${folder}.zip`;
  a.click();
  // Some browsers start the download after the click returns, so keep the URL a moment.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Pay 1 USDC once, get your own ENS name with the harness key sealed to you,
 * and read the harness files. Accepted versions of the real tree only.
 */
export function BuyPanel({ id, name, onOwned }: { id: string; name: string; onOwned?: () => void }) {
  const { address, isConnected, chainId } = useConnection();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { mutateAsync: write } = useWriteContract();
  const { mutateAsync: sign } = useSignMessage();
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payTx, setPayTx] = useState<string | null>(null);
  const [owned, setOwned] = useState<{ buyer: string; files: Record<string, string> } | null>(null);
  // The buy flow on screen: which step runs now, and whether one failed.
  const [stage, setStage] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [boughtName, setBoughtName] = useState<string | null>(null);

  const balance = useReadContract({
    address: USDC, abi: erc20Abi, functionName: "balanceOf", args: address ? [address] : undefined,
    chainId: CHAIN_ID, query: { enabled: !!address },
  });

  /** Opens what this wallet already bought, if anything. */
  const open = async (wallet: string): Promise<boolean> => {
    const res = await fetch(`/api/market/bought?id=${id}&wallet=${wallet}`, { cache: "no-store" });
    const data = (await res.json()) as Bought & { ok: boolean; error?: string };
    if (!data.ok || !data.buyer) return false;
    const { secretKey } = accessKeyFor(wallet);
    const fileKey = openFileKey(data.buyer.key, secretKey);
    const files: Record<string, string> = {};
    for (const f of data.files) files[f] = data.docs[f] ? decryptText(fileKey, data.docs[f]) : "";
    setOwned({ buyer: data.buyer.name, files });
    onOwned?.();
    return true;
  };

  // A wallet that bought before sees its files again.
  useEffect(() => {
    setOwned(null);
    if (address) void open(address).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, id]);

  const buy = async () => {
    if (!address || !client || !PLATFORM) return;
    setError(null);
    setFailed(false);
    setPayTx(null);
    setBoughtName(null);
    try {
      setStage(0);
      setStep("buying");
      const key = accessKeyFor(address);
      const signature = await sign({ message: accessMessage(key.publicKey) });

      setStage(1);
      const hash = await write({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [PLATFORM, PRICE], chainId: CHAIN_ID });
      setPayTx(hash);
      setStage(2);
      await client.waitForTransactionReceipt({ hash });

      setStage(3);
      const res = await fetch("/api/market/buy", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, wallet: address, accessKey: key.publicKey, signature, txHash: hash }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; name?: string };
      if (!data.ok) throw new Error(data.error ?? "The purchase failed.");
      setBoughtName(data.name ?? null);

      setStage(4);
      if (!(await open(address))) throw new Error("Your name was created, but the key did not open. Reload the page.");
      setStage(5);
      setStep(null);
      void balance.refetch();
    } catch (e) {
      setError((e as { shortMessage?: string }).shortMessage ?? (e as Error).message);
      setFailed(true);
      setStep(null);
    }
  };

  /** The buy flow as a checklist: done, running (with a spinner), waiting, or failed. */
  const flow = stage === null ? null : (
    <ol className="buy-flow" aria-live="polite">
      {[
        { what: "Sign the access key in MetaMask", note: "proves this browser's key belongs to your wallet" },
        { what: "Pay 1 USDC in MetaMask", note: "a transfer to the platform wallet" },
        { what: "Payment confirmed on Sepolia", note: payTx ? <a href={explorerTx(payTx)} target="_blank" rel="noreferrer">{payTx.slice(0, 10)}…</a> : null },
        { what: "The platform checks the payment, publishes the files and creates your name", note: boughtName ? <code>{boughtName}</code> : "about a minute" },
        { what: "Open your key and decrypt the files", note: "in this browser only" },
      ].map((st, i) => {
        const state = i < stage ? "done" : i === stage ? (failed ? "fail" : "run") : "wait";
        return (
          <li key={i} className={`buy-step ${state}`}>
            <span className="buy-mark" aria-hidden="true">{state === "done" ? "✓" : state === "fail" ? "✕" : state === "run" ? <span className="spinner" /> : i + 1}</span>
            <span><b>{st.what}</b>{st.note && <small> · {st.note}</small>}</span>
          </li>
        );
      })}
    </ol>
  );

  const mint = async () => {
    if (!address) return;
    setError(null);
    try {
      setStep("Minting test USDC…");
      const hash = await write({ address: USDC, abi: mintAbi, functionName: "mint", args: [address, 10_000_000n], chainId: CHAIN_ID });
      await client?.waitForTransactionReceipt({ hash });
      await balance.refetch();
      setStep(null);
    } catch (e) {
      setError((e as { shortMessage?: string }).shortMessage ?? (e as Error).message);
      setStep(null);
    }
  };

  const low = balance.data !== undefined && balance.data < PRICE;
  if (owned) {
    return (
      <section className="buy">
        <h3>You own this harness</h3>
        <p>Your name: <a href={ensAppUrl(owned.buyer)} target="_blank" rel="noreferrer"><code>{owned.buyer}</code></a>. It holds the file key, sealed to this browser. It expires in 30 days.</p>
        <button type="button" onClick={() => downloadZip(`petri-${name.split(".")[0]}-${id.slice(0, 8)}`, owned.files)}>
          Download all {Object.keys(owned.files).length} files (.zip)
        </button>
        <p>The zip holds <code>harness.md</code> and a <code>harness/</code> folder with the same layout as <code>petri/harness</code>.</p>
        <p>Buy again to get a new name, the next <code>buyer</code> number, with a fresh 30 days. Your test USDC: {balance.data === undefined ? "…" : (Number(balance.data) / 1e6).toFixed(2)}</p>
        {low && <button type="button" className="ghost" disabled={!!step} onClick={() => void mint()}>Get 10 test USDC</button>}
        <button type="button" className="ghost" disabled={!!step || low || !isConnected || chainId !== CHAIN_ID} onClick={() => void buy()}>Buy again · 1 USDC</button>
        {flow}
        {error && <p className="err">{error}</p>}
        {/* The files stay folded under one line, and out of the way while a buy runs. */}
        {stage === null || stage >= 5 ? (
          <details className="buy-files">
            <summary>Show the {Object.keys(owned.files).length} files</summary>
            {Object.entries(owned.files).map(([f, text]) => (
              <details key={f}>
                <summary>{f}</summary>
                <pre>{text}</pre>
              </details>
            ))}
          </details>
        ) : null}
      </section>
    );
  }

  return (
    <section className="buy">
      <h3>Use this harness · 1 USDC</h3>
      <p>Pay once. You get your own ENS name under <code>{name}</code>, with the harness key sealed to you, and the files open here.</p>
      {!isConnected ? (
        <p>Connect your wallet at the top right first.</p>
      ) : chainId !== CHAIN_ID ? (
        <p>Switch MetaMask to Sepolia at the top right.</p>
      ) : !PLATFORM ? (
        <p className="err">NEXT_PUBLIC_PETRI_ENS_ADDRESS is not set, so there is no address to pay.</p>
      ) : (
        <>
          <p>Your test USDC: {balance.data === undefined ? "…" : (Number(balance.data) / 1e6).toFixed(2)}</p>
          {low && <button type="button" className="ghost" disabled={!!step} onClick={() => void mint()}>Get 10 test USDC</button>}
          <button type="button" disabled={!!step || low} onClick={() => void buy()}>Buy for 1 USDC</button>
        </>
      )}
      {step && stage === null && <p>{step}</p>}
      {flow}
      {error && <p className="err">{error}</p>}
    </section>
  );
}
