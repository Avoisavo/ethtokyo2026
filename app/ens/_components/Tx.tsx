"use client";

import { useConnection } from "wagmi";

import { explorerTx } from "@/app/ens/_lib/ens/contracts";
import { stringify } from "@/app/ens/_lib/ens/errors";
import type { Tx } from "@/app/ens/_lib/hooks/useTx";
import { CHAIN_ID } from "@/app/ens/_lib/wagmi";

import { Badge, Button } from "./ui";

/**
 * A button that runs a transaction via `tx.run`. Disabled while busy, when no
 * wallet is connected, or when the wallet is on the wrong chain.
 */
export function TxButton({
  tx,
  onClick,
  disabled,
  children,
  variant,
}: {
  tx: Tx;
  onClick: () => unknown;
  disabled?: boolean;
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
}) {
  const { isConnected, chainId } = useConnection();
  const wrongChain = isConnected && chainId !== CHAIN_ID;
  return (
    <Button
      variant={variant}
      disabled={disabled || tx.busy || !isConnected || wrongChain}
      onClick={() => void onClick()}
      title={!isConnected ? "Connect a wallet first" : wrongChain ? "Switch to Sepolia" : undefined}
    >
      {tx.state.status === "signing" ? "Confirm in wallet…" : tx.state.status === "pending" ? "Waiting…" : children}
    </Button>
  );
}

/** Shows the lifecycle of a `useTx` transaction, including decoded ENSv2 events. */
export function TxStatus({ tx, showEvents = true }: { tx: Tx; showEvents?: boolean }) {
  const s = tx.state;
  if (s.status === "idle") return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        {s.status === "signing" && <Badge tone="info">Awaiting signature</Badge>}
        {s.status === "pending" && <Badge tone="info">Pending</Badge>}
        {s.status === "success" && <Badge tone="success">Confirmed</Badge>}
        {s.status === "reverted" && <Badge tone="danger">Reverted</Badge>}
        {s.status === "error" && <Badge tone="danger">Failed</Badge>}
        {"hash" in s && s.hash && (
          <a href={explorerTx(s.hash)} target="_blank" rel="noreferrer" className="font-mono text-xs text-sky-600 hover:underline dark:text-sky-400">
            {s.hash.slice(0, 10)}…{s.hash.slice(-8)}
          </a>
        )}
        {(s.status === "success" || s.status === "reverted") && (
          <span className="text-xs text-zinc-500">
            block {s.receipt.blockNumber.toString()} · gas {s.receipt.gasUsed.toString()}
          </span>
        )}
        {!tx.busy && (
          <button type="button" onClick={tx.reset} className="ml-auto text-xs text-zinc-500 hover:underline">
            clear
          </button>
        )}
      </div>
      {s.status === "error" && <p className="break-words text-red-600 dark:text-red-400">{s.error}</p>}
      {showEvents && (s.status === "success" || s.status === "reverted") && s.events.length > 0 && (
        <ul className="flex flex-col gap-1 font-mono text-xs">
          {s.events.map((e, i) => (
            <li key={i} className="break-all">
              <span className="font-semibold text-emerald-700 dark:text-emerald-400">{e.eventName}</span>{" "}
              <span className="text-zinc-500">{stringify(e.args)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
