"use client";

import { useState } from "react";
import { isAddressEqual, parseAbi } from "viem";
import { useConnection, useEnsAddress, useEnsName, useReadContract, useWriteContract } from "wagmi";

import { TxButton, TxStatus } from "@/app/ens/_components/Tx";
import { Card, Field, Input, Notice, Row } from "@/app/ens/_components/ui";
import { ReverseRegistrarAdapterAbi } from "@/app/ens/_lib/ens/abis/ReverseRegistrarAdapter";
import { addresses } from "@/app/ens/_lib/ens/contracts";
import { tryNormalize } from "@/app/ens/_lib/ens/names";
import { useTx } from "@/app/ens/_lib/hooks/useTx";
import { CHAIN_ID } from "@/app/ens/_lib/wagmi";

// At launch the reverse namespace stays on ENSv1: EOAs set their primary name
// on the v1 ReverseRegistrar (the one the v2 ReverseRegistrarAdapter forwards to).
const reverseRegistrarAbi = parseAbi(["function setName(string name) returns (bytes32)"]);

export function PrimaryNameCard({ name }: { name: string | null }) {
  const { address } = useConnection();
  const { mutateAsync } = useWriteContract();
  const tx = useTx();
  const [input, setInput] = useState("");
  const target = tryNormalize(input || name || "");

  const current = useEnsName({ address, chainId: CHAIN_ID, query: { enabled: !!address } });
  const forward = useEnsAddress({ name: target ?? undefined, chainId: CHAIN_ID, query: { enabled: !!target } });
  const reverseRegistrar = useReadContract({
    address: addresses.ReverseRegistrarAdapter,
    abi: ReverseRegistrarAdapterAbi,
    functionName: "REVERSE_REGISTRAR",
    chainId: CHAIN_ID,
  });

  const pointsToMe = !!forward.data && !!address && isAddressEqual(forward.data, address);

  const setPrimary = async () => {
    if (!target || !reverseRegistrar.data) return;
    const r = await tx.run(() =>
      mutateAsync({
        address: reverseRegistrar.data,
        abi: reverseRegistrarAbi,
        functionName: "setName",
        args: [target],
        chainId: CHAIN_ID,
      }),
    );
    if (r) current.refetch();
  };

  return (
    <Card title="6. Primary name" description="The name apps show for your address. It must resolve back to your address to count.">
      <p className="text-sm">
        Your primary name: <span className="font-mono">{address ? (current.isLoading ? "…" : current.data ?? "none") : "connect a wallet"}</span>
      </p>
      <Row>
        <Field label="Name">
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder={name ?? "myname.eth"} className="w-72" />
        </Field>
        <TxButton tx={tx} onClick={setPrimary} disabled={!target || !reverseRegistrar.data}>
          Set as primary name
        </TxButton>
      </Row>
      {target && forward.data !== undefined && !pointsToMe && (
        <Notice tone="warning">
          {target} doesn&apos;t resolve to your address yet, so it won&apos;t show as your primary name. Set its ETH address record to your
          address first (section 3).
        </Notice>
      )}
      <TxStatus tx={tx} showEvents={false} />
    </Card>
  );
}
