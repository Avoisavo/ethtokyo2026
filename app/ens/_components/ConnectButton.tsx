"use client";

import { useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, useEnsName, useSwitchChain } from "wagmi";

import { CHAIN_ID } from "@/app/ens/_lib/wagmi";

import { Badge, Button } from "./ui";

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

export function ConnectButton() {
  const { address, isConnected, chainId, connector: active } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const { data: ensName } = useEnsName({ address, chainId: CHAIN_ID });
  const [pickError, setPickError] = useState<string | null>(null);

  // Prefer MetaMask by its EIP-6963 id, so another extension that grabbed
  // window.ethereum (Backpack, Phantom, …) can't win. Fall back to the generic
  // injected connector when MetaMask isn't installed.
  const metaMask = connectors.find((c) => c.id === "io.metamask") ?? connectors.find((c) => /metamask/i.test(c.name));
  const connector = metaMask ?? connectors[0];

  /**
   * Open MetaMask's account picker before connecting. Without this, MetaMask
   * silently reuses whichever account was connected to this site before.
   */
  async function connectWithPicker() {
    if (!connector) return;
    setPickError(null);
    try {
      const provider = (await connector.getProvider()) as Eip1193 | undefined;
      await provider?.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
    } catch (err) {
      // 4001 = the user closed the picker. Anything else: fall through and let
      // connect() report it.
      if ((err as { code?: number }).code === 4001) {
        setPickError("Connection cancelled in MetaMask.");
        return;
      }
    }
    connect.mutate({ connector });
  }

  /** Disconnect and revoke this site's access, so the next connect asks again. */
  async function disconnectAndRevoke() {
    try {
      const provider = (await active?.getProvider()) as Eip1193 | undefined;
      await provider?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch {
      // Older wallets don't support revoking; disconnecting locally still works.
    }
    disconnect.mutate();
  }

  // With `ssr: true` wagmi renders disconnected on the server and first client
  // pass, then reconnects after hydration, so no mounted guard is needed.
  if (!isConnected) {
    const error = pickError ?? connect.error?.message;
    return (
      <div className="flex items-center gap-2">
        {error && <span className="max-w-64 truncate text-xs text-red-600">{error}</span>}
        <Button disabled={!connector || connect.isPending} onClick={() => void connectWithPicker()}>
          {connect.isPending ? "Connecting…" : metaMask ? "Connect MetaMask" : "Connect wallet"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {chainId !== CHAIN_ID ? (
        <Button variant="danger" onClick={() => switchChain.mutate({ chainId: CHAIN_ID })}>
          Switch to Sepolia
        </Button>
      ) : (
        <Badge tone="success">Sepolia</Badge>
      )}
      <span className="font-mono text-sm" title={address}>
        {ensName ?? `${address?.slice(0, 6)}…${address?.slice(-4)}`}
      </span>
      <Button variant="secondary" onClick={() => void disconnectAndRevoke()}>
        Disconnect
      </Button>
    </div>
  );
}
