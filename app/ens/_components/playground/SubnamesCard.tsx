"use client";

import { useState } from "react";
import { isAddress, zeroAddress } from "viem";
import { useBytecode, useConnection, useReadContract, useWriteContract } from "wagmi";

import { TxButton, TxStatus } from "@/app/ens/_components/Tx";
import { AddressLink, Badge, Button, Card, Field, Input, Notice, Row } from "@/app/ens/_components/ui";
import { ETHRegistryAbi } from "@/app/ens/_lib/ens/abis/ETHRegistry";
import { UserRegistryImplAbi } from "@/app/ens/_lib/ens/abis/UserRegistryImpl";
import {
  USER_REGISTRY_IMPL,
  VERIFIABLE_FACTORY,
  allRolesTo,
  encodeRegistryInit,
  predictProxyAddress,
  registrySalt,
  verifiableFactoryAbi,
} from "@/app/ens/_lib/ens/factory";
import { labelId, namehash, tryNormalize } from "@/app/ens/_lib/ens/names";
import { REGISTRATION_ROLE_BITMAP, RegistryRoles } from "@/app/ens/_lib/ens/roles";
import { useMyResolver } from "@/app/ens/_lib/hooks/useMyResolver";
import { useNameInfo } from "@/app/ens/_lib/hooks/useNameInfo";
import { useTx } from "@/app/ens/_lib/hooks/useTx";
import { useWorkspace } from "@/app/ens/_lib/hooks/useWorkspace";
import { CHAIN_ID } from "@/app/ens/_lib/wagmi";

const YEAR = 365n * 24n * 60n * 60n;

export function SubnamesCard({ name, onSelect }: { name: string | null; onSelect: (name: string) => void }) {
  const { address } = useConnection();
  const { mutateAsync } = useWriteContract();
  const { add } = useWorkspace();
  const info = useNameInfo(name);
  const my = useMyResolver();
  const tx = useTx();

  const [subInput, setSubInput] = useState("");
  const [ownerInput, setOwnerInput] = useState("");
  const sub = tryNormalize(subInput);
  const subLabel = sub && !sub.includes(".") ? sub : null;
  const owner = ownerInput ? (isAddress(ownerInput) ? ownerInput : null) : address ?? null;

  // The subname registry for a name is deployed at a predictable address.
  const proxyLogic = useReadContract({
    address: VERIFIABLE_FACTORY,
    abi: verifiableFactoryAbi,
    functionName: "proxyLogic",
    chainId: CHAIN_ID,
  });
  const predicted =
    name && address && proxyLogic.data
      ? predictProxyAddress({ proxyLogic: proxyLogic.data, deployer: address, salt: registrySalt(namehash(name)) })
      : undefined;
  const code = useBytecode({ address: predicted, chainId: CHAIN_ID, query: { enabled: !!predicted } });
  const predictedDeployed = !!code.data && code.data !== "0x";

  const subregistry = info.subregistry;
  const canCreate = useReadContract({
    address: subregistry ?? undefined,
    abi: UserRegistryImplAbi,
    functionName: "hasRootRoles",
    args: address ? [RegistryRoles.ROLE_REGISTRAR, address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!subregistry && !!address },
  });
  const subState = useReadContract({
    address: subregistry ?? undefined,
    abi: UserRegistryImplAbi,
    functionName: "getState",
    args: [labelId(subLabel ?? "")],
    chainId: CHAIN_ID,
    query: { enabled: !!subregistry && !!subLabel },
  });

  if (!name) {
    return (
      <Card title="4. Subnames">
        <p className="text-sm text-zinc-500">Pick or register a name above.</p>
      </Card>
    );
  }

  const deployRegistry = async () => {
    if (!address) return;
    const r = await tx.run(() =>
      mutateAsync({
        address: VERIFIABLE_FACTORY,
        abi: verifiableFactoryAbi,
        functionName: "deployProxy",
        args: [USER_REGISTRY_IMPL, registrySalt(namehash(name)), encodeRegistryInit(allRolesTo(address))],
        chainId: CHAIN_ID,
      }),
    );
    if (r) code.refetch();
  };

  const connectRegistry = async () => {
    if (!predicted) return;
    const r = await tx.run(() =>
      mutateAsync({
        address: info.registry!,
        abi: ETHRegistryAbi,
        functionName: "setSubregistry",
        args: [labelId(info.label), predicted],
        chainId: CHAIN_ID,
      }),
    );
    if (r) {
      add("registries", predicted, `${name} subnames`);
      info.refetch();
    }
  };

  const createSubname = async () => {
    if (!subregistry || !subLabel || !owner) return;
    const expiry = BigInt(Math.floor(Date.now() / 1000)) + YEAR;
    const r = await tx.run(() =>
      mutateAsync({
        address: subregistry,
        abi: UserRegistryImplAbi,
        functionName: "register",
        args: [subLabel, owner, zeroAddress, my.deployed && my.resolver ? my.resolver : zeroAddress, REGISTRATION_ROLE_BITMAP, expiry],
        chainId: CHAIN_ID,
      }),
    );
    if (r) {
      add("names", `${subLabel}.${name}`);
      subState.refetch();
    }
  };

  const subTaken = subState.data && subState.data.status !== 0;

  return (
    <Card
      title="4. Subnames"
      description={`Give ${name} its own subname registry, then create names like alice.${name}. Each subname is an NFT in your registry.`}
    >
      {!info.active ? (
        <Notice tone="warning">This name isn&apos;t registered.</Notice>
      ) : !subregistry ? (
        info.isOwner ? (
          <ol className="flex flex-col gap-2 text-sm">
            <li className="flex flex-wrap items-center gap-3">
              <span className="w-5 text-center">{predictedDeployed ? "✓" : "1"}</span>
              <span className="min-w-48">Deploy a subname registry</span>
              {!predictedDeployed && (
                <TxButton tx={tx} onClick={deployRegistry}>
                  Deploy
                </TxButton>
              )}
              {predicted && <AddressLink address={predicted} short />}
            </li>
            <li className={`flex flex-wrap items-center gap-3 ${predictedDeployed ? "" : "opacity-50"}`}>
              <span className="w-5 text-center">2</span>
              <span className="min-w-48">Connect it to {name}</span>
              {predictedDeployed && (
                <TxButton tx={tx} onClick={connectRegistry}>
                  Connect
                </TxButton>
              )}
            </li>
          </ol>
        ) : (
          <Notice>{name} has no subname registry, and only its owner can add one.</Notice>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            Subname registry: <AddressLink address={subregistry} />
            {canCreate.data !== undefined && (
              <Badge tone={canCreate.data ? "success" : "neutral"}>{canCreate.data ? "you can create subnames" : "view only"}</Badge>
            )}
          </div>
          <Row>
            <Field label="Subname">
              <div className="flex items-center gap-1">
                <Input value={subInput} onChange={(e) => setSubInput(e.target.value)} placeholder="alice" className="w-40" />
                <span className="font-mono text-sm">.{name}</span>
              </div>
            </Field>
            <Field label="Owner" hint="Defaults to you">
              <Input value={ownerInput} onChange={(e) => setOwnerInput(e.target.value)} placeholder={address ?? "0x…"} className="w-96" />
            </Field>
            {subLabel && subState.data && (
              <Badge tone={subTaken ? "danger" : "success"}>{subTaken ? "taken" : "available"}</Badge>
            )}
          </Row>
          <Row>
            <TxButton tx={tx} onClick={createSubname} disabled={!subLabel || !owner || subTaken || canCreate.data === false}>
              Create {subLabel ? `${subLabel}.${name}` : "subname"} (1 year)
            </TxButton>
            {subTaken && subLabel && (
              <Button variant="secondary" onClick={() => onSelect(`${subLabel}.${name}`)}>
                Open {subLabel}.{name}
              </Button>
            )}
          </Row>
          {!my.deployed && <p className="text-xs text-zinc-500">Tip: deploy your resolver (step 1) so new subnames can hold records.</p>}
        </>
      )}
      <TxStatus tx={tx} />
    </Card>
  );
}
