"use client";

import { useConnection } from "wagmi";

import { Faucet } from "@/app/ens/_components/Faucet";
import { TxButton, TxStatus } from "@/app/ens/_components/Tx";
import { AddressLink, Badge, Card, Notice } from "@/app/ens/_components/ui";
import { useMyResolver } from "@/app/ens/_lib/hooks/useMyResolver";

export function SetupCard() {
  const { isConnected } = useConnection();
  const my = useMyResolver();

  return (
    <Card
      title="1. Get ready"
      description="You need Sepolia ETH for gas (any public faucet), test USDC for registration fees, and your own resolver to hold your records."
    >
      {!isConnected ? (
        <Notice tone="warning">Connect a wallet (top right) on Sepolia to start.</Notice>
      ) : (
        <>
          <Faucet />
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>Your resolver:</span>
            <AddressLink address={my.resolver} />
            {my.resolver && !my.loading && (
              <Badge tone={my.deployed ? "success" : "warning"}>{my.deployed ? "deployed" : "not deployed"}</Badge>
            )}
            {!my.deployed && !my.loading && (
              <TxButton tx={my.tx} onClick={my.deploy}>
                Deploy my resolver
              </TxButton>
            )}
          </div>
          <TxStatus tx={my.tx} showEvents={false} />
        </>
      )}
    </Card>
  );
}
