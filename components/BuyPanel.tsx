"use client";

import { useEffect, useState } from "react";
import { type Address, erc20Abi, parseAbi } from "viem";
import { useConnection, usePublicClient, useReadContract, useSignMessage, useWriteContract } from "wagmi";

import { addresses, explorerTx } from "@/app/ens/_lib/ens/contracts";
import { CHAIN_ID } from "@/app/ens/_lib/wagmi";
import { ensAppUrl } from "@/lib/ens/name";
import { accessPublicKey, decryptText, newAccessKeyPair, openFileKey } from "@/lib/market/crypto";

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
 * Pay 1 USDC once, get your own ENS name with the harness key sealed to you,
 * and read the harness files. Accepted versions of the real tree only.
 */
export function BuyPanel({ id, name }: { id: string; name: string }) {
  const { address, isConnected, chainId } = useConnection();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { mutateAsync: write } = useWriteContract();
  const { mutateAsync: sign } = useSignMessage();
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payTx, setPayTx] = useState<string | null>(null);
  const [owned, setOwned] = useState<{ buyer: string; files: Record<string, string> } | null>(null);

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
    try {
      setStep("Sign the access key in MetaMask…");
      const key = accessKeyFor(address);
      const signature = await sign({ message: accessMessage(key.publicKey) });

      setStep("Pay 1 USDC in MetaMask…");
      const hash = await write({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [PLATFORM, PRICE], chainId: CHAIN_ID });
      setPayTx(hash);
      setStep("Waiting for the payment on Sepolia…");
      await client.waitForTransactionReceipt({ hash });

      setStep("The platform checks the payment, publishes the files and creates your name (about a minute)…");
      const res = await fetch("/api/market/buy", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, wallet: address, accessKey: key.publicKey, signature, txHash: hash }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? "The purchase failed.");

      setStep("Opening your key…");
      if (!(await open(address))) throw new Error("Your name was created, but the key did not open. Reload the page.");
      setStep(null);
      void balance.refetch();
    } catch (e) {
      setError((e as { shortMessage?: string }).shortMessage ?? (e as Error).message);
      setStep(null);
    }
  };

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

  if (owned) {
    return (
      <section className="buy">
        <h3>You own this harness</h3>
        <p>Your name: <a href={ensAppUrl(owned.buyer)} target="_blank" rel="noreferrer"><code>{owned.buyer}</code></a>. It holds the file key, sealed to this browser. It expires in 30 days.</p>
        <div className="buy-files">
          {Object.entries(owned.files).map(([f, text]) => (
            <details key={f}>
              <summary>{f}</summary>
              <pre>{text}</pre>
            </details>
          ))}
        </div>
      </section>
    );
  }

  const low = balance.data !== undefined && balance.data < PRICE;
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
      {step && <p>{step}</p>}
      {payTx && <p>Payment: <a href={explorerTx(payTx)} target="_blank" rel="noreferrer">{payTx.slice(0, 10)}…</a></p>}
      {error && <p className="err">{error}</p>}
    </section>
  );
}
