"use client";

import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";

import { CHAIN_ID } from "@/app/ens/_lib/wagmi";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The wallet in the top bar: connect with MetaMask, stay on Sepolia, disconnect. */
export function WalletButton() {
  const { address, isConnected, chainId } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  // Prefer MetaMask by its EIP-6963 id, so another extension on window.ethereum can't win.
  const connector = connectors.find((c) => c.id === "io.metamask") ?? connectors.find((c) => /metamask/i.test(c.name)) ?? connectors[0];

  if (!isConnected || !address) {
    return (
      <button type="button" className="wallet-btn" disabled={!connector || connect.isPending}
        onClick={() => connector && connect.mutate({ connector })} title={connect.error?.message}>
        {connect.isPending ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }
  if (chainId !== CHAIN_ID) {
    return <button type="button" className="wallet-btn warn" onClick={() => switchChain.mutate({ chainId: CHAIN_ID })}>Switch to Sepolia</button>;
  }
  return (
    <span className="wallet-on">
      <span className="wallet-dot" aria-hidden="true" />
      <code title={address}>{short(address)}</code>
      <button type="button" className="wallet-x" onClick={() => disconnect.mutate()} aria-label="Disconnect">×</button>
    </span>
  );
}
