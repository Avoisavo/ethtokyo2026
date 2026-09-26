"use client";

import { useConnect, useConnection, useConnectors, useDisconnect, useEnsName, useSwitchChain } from "wagmi";

import { CHAIN_ID } from "@/app/ens/_lib/wagmi";

import { Badge, Button } from "./ui";

export function ConnectButton() {
  const { address, isConnected, chainId } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const { data: ensName } = useEnsName({ address, chainId: CHAIN_ID });

  // With `ssr: true` wagmi renders disconnected on the server and first client
  // pass, then reconnects after hydration, so no mounted guard is needed.
  if (!isConnected) {
    const connector = connectors[0];
    return (
      <div className="flex items-center gap-2">
        {connect.error && <span className="max-w-64 truncate text-xs text-red-600">{connect.error.message}</span>}
        <Button disabled={!connector || connect.isPending} onClick={() => connector && connect.mutate({ connector })}>
          {connect.isPending ? "Connecting…" : "Connect wallet"}
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
      <Button variant="secondary" onClick={() => disconnect.mutate()}>
        Disconnect
      </Button>
    </div>
  );
}
