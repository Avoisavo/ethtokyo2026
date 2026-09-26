"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type Hex, encodeFunctionData, erc20Abi, formatUnits, isAddress, isAddressEqual, zeroHash } from "viem";
import { useConnection, usePublicClient, useReadContract, useWriteContract } from "wagmi";

import { TxButton, TxStatus } from "@/app/ens/_components/Tx";
import { AddressLink, Badge, Button, Card, Field, Grid, Input, KV, Notice, Row } from "@/app/ens/_components/ui";
import { ETHRegistrarAbi } from "@/app/ens/_lib/ens/abis/ETHRegistrar";
import { ETHRegistryAbi } from "@/app/ens/_lib/ens/abis/ETHRegistry";
import { PermissionedResolverImplAbi } from "@/app/ens/_lib/ens/abis/PermissionedResolverImpl";
import { PAYMENT_TOKENS, addresses } from "@/app/ens/_lib/ens/contracts";
import { dnsEncode, labelId } from "@/app/ens/_lib/ens/names";
import { useMyResolver } from "@/app/ens/_lib/hooks/useMyResolver";
import { useNameInfo } from "@/app/ens/_lib/hooks/useNameInfo";
import { useTx } from "@/app/ens/_lib/hooks/useTx";
import { CHAIN_ID } from "@/app/ens/_lib/wagmi";

const YEAR = 365n * 24n * 60n * 60n;
const USDC = PAYMENT_TOKENS.MockUSDC;
const TEXT_KEYS = ["description", "url", "avatar", "com.twitter"];

export function ManageNameCard({ name }: { name: string | null }) {
  const { address } = useConnection();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { mutateAsync } = useWriteContract();
  const info = useNameInfo(name);
  const my = useMyResolver();
  const tx = useTx();

  const isMine = !!info.resolver && !!my.resolver && isAddressEqual(info.resolver, my.resolver);
  const isV1Mirror = !!info.resolver && isAddressEqual(info.resolver, addresses.ENSV1Resolver);

  const records = useQuery({
    queryKey: ["records", name, info.resolver],
    enabled: !!client && !!name && !!info.resolver,
    queryFn: async () => {
      const [eth, ...texts] = await Promise.all([
        client!.getEnsAddress({ name: name! }).catch(() => null),
        ...TEXT_KEYS.map((key) => client!.getEnsText({ name: name!, key }).catch(() => null)),
      ]);
      return { eth, texts: Object.fromEntries(TEXT_KEYS.map((k, i) => [k, texts[i]])) as Record<string, string | null> };
    },
  });

  const [ethInput, setEthInput] = useState("");
  const [textInputs, setTextInputs] = useState<Record<string, string>>({});
  const [customKey, setCustomKey] = useState("");
  const [customValue, setCustomValue] = useState("");

  const renewPrice = useReadContract({
    address: addresses.ETHRegistrar,
    abi: ETHRegistrarAbi,
    functionName: "getRenewPrice",
    args: [info.label, YEAR, USDC.address],
    chainId: CHAIN_ID,
    query: { enabled: info.isEth2ld && info.active },
  });
  const allowance = useReadContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, addresses.ETHRegistrar] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!address && info.isEth2ld },
  });

  if (!name) {
    return (
      <Card title="3. Your name">
        <p className="text-sm text-zinc-500">Pick or register a name above.</p>
      </Card>
    );
  }

  const pointToMyResolver = () =>
    tx.run(() =>
      mutateAsync({
        address: info.registry!,
        abi: ETHRegistryAbi,
        functionName: "setResolver",
        args: [labelId(info.label), my.resolver!],
        chainId: CHAIN_ID,
      }),
    ).then((r) => r && info.refetch());

  const renew = async () => {
    const price = renewPrice.data;
    if (price === undefined) return;
    if ((allowance.data ?? 0n) < price) {
      const ok = await tx.run(() =>
        mutateAsync({
          address: USDC.address,
          abi: erc20Abi,
          functionName: "approve",
          args: [addresses.ETHRegistrar, (price * 101n) / 100n],
          chainId: CHAIN_ID,
        }),
      );
      if (!ok) return;
      await allowance.refetch();
    }
    const r = await tx.run(() =>
      mutateAsync({
        address: addresses.ETHRegistrar,
        abi: ETHRegistrarAbi,
        functionName: "renew",
        args: [{ label: info.label, duration: YEAR, referrer: zeroHash }, USDC.address],
        chainId: CHAIN_ID,
      }),
    );
    if (r) info.refetch();
  };

  const calls: Hex[] = [];
  const dnsName = dnsEncode(name);
  if (isAddress(ethInput)) {
    calls.push(
      encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "setAddress", args: [dnsName, 60n, ethInput] }),
    );
  }
  const texts = { ...textInputs, ...(customKey ? { [customKey]: customValue } : {}) };
  for (const [key, value] of Object.entries(texts)) {
    if (value === "" && !(key in textInputs)) continue;
    calls.push(encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "setText", args: [dnsName, key, value] }));
  }

  const saveRecords = async () => {
    const r = await tx.run(() =>
      mutateAsync({
        address: info.resolver!,
        abi: PermissionedResolverImplAbi,
        functionName: "multicall",
        args: [calls],
        chainId: CHAIN_ID,
      }),
    );
    if (r) {
      setEthInput("");
      setTextInputs({});
      setCustomKey("");
      setCustomValue("");
      records.refetch();
    }
  };

  const s = info.state;

  return (
    <Card title={`3. Your name: ${name}`} description="Status, renewal and records. Records live on the name's resolver.">
      {info.loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : !info.registry ? (
        <Notice tone="warning">No registry found for this name (its parent has no subname registry).</Notice>
      ) : (
        <KV
          rows={[
            ["Status", <Badge key="s" tone={info.active ? "success" : "neutral"}>{info.status ?? "—"}</Badge>],
            ["Owner", <span key="o" className="inline-flex gap-2"><AddressLink address={info.active ? s?.latestOwner : null} />{info.isOwner && <Badge tone="info">you</Badge>}</span>],
            ["Expires", s && info.active ? new Date(Number(s.expiry) * 1000).toLocaleString() : "—"],
            ["Registry", <AddressLink key="r" address={info.registry} />],
            [
              "Resolver",
              <span key="res" className="inline-flex flex-wrap gap-2">
                <AddressLink address={info.resolver} />
                {isMine && <Badge tone="info">yours</Badge>}
                {isV1Mirror && <Badge>ENSv1 mirror</Badge>}
              </span>,
            ],
            ["Token ID", s && info.active ? s.tokenId.toString() : "—"],
          ]}
        />
      )}

      <Row>
        {info.isOwner && !isMine && my.deployed && (
          <TxButton tx={tx} onClick={pointToMyResolver}>
            Use my resolver for this name
          </TxButton>
        )}
        {info.isEth2ld && info.active && (
          <TxButton tx={tx} variant="secondary" onClick={renew} disabled={renewPrice.data === undefined}>
            Renew 1 year{renewPrice.data !== undefined ? ` (${formatUnits(renewPrice.data, USDC.decimals)} USDC)` : ""}
          </TxButton>
        )}
      </Row>

      {info.active && info.resolver && !isV1Mirror && (
        <div className="flex flex-col gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <div className="text-sm font-medium">Records</div>
          {!isMine && (
            <Notice tone="info">
              This name uses someone else&apos;s resolver. Saving only works if its owner granted you record roles (section 5).
            </Notice>
          )}
          <Grid>
            <Field label="ETH address" hint={`Current: ${records.data?.eth ?? "not set"}`}>
              <Row>
                <Input value={ethInput} onChange={(e) => setEthInput(e.target.value)} placeholder="0x…" className="flex-1" />
                {address && (
                  <Button variant="secondary" onClick={() => setEthInput(address)}>
                    Me
                  </Button>
                )}
              </Row>
            </Field>
            {TEXT_KEYS.map((key) => (
              <Field key={key} label={key} hint={`Current: ${records.data?.texts[key] || "not set"}`}>
                <Input
                  value={textInputs[key] ?? ""}
                  onChange={(e) => setTextInputs({ ...textInputs, [key]: e.target.value })}
                />
              </Field>
            ))}
            <Field label="Custom text record">
              <Row>
                <Input value={customKey} onChange={(e) => setCustomKey(e.target.value)} placeholder="key" className="w-32" />
                <Input value={customValue} onChange={(e) => setCustomValue(e.target.value)} placeholder="value" className="flex-1" />
              </Row>
            </Field>
          </Grid>
          <Row>
            <TxButton tx={tx} onClick={saveRecords} disabled={calls.length === 0}>
              Save {calls.length || ""} record{calls.length === 1 ? "" : "s"}
            </TxButton>
            {ethInput && !isAddress(ethInput) && <span className="text-sm text-red-600">Invalid address</span>}
          </Row>
        </div>
      )}
      {isV1Mirror && <Notice>This is an unmigrated ENSv1 name; its records are managed on ENSv1.</Notice>}
      <TxStatus tx={tx} />
    </Card>
  );
}
