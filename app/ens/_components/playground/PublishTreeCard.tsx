"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type Hex, encodeFunctionData, isAddressEqual } from "viem";
import { useConnection, useReadContract, useWriteContract } from "wagmi";

import { TxButton, TxStatus } from "@/app/ens/_components/Tx";
import { AddressLink, Badge, Button, Card, ErrorText, KV, Mono, Notice, Row } from "@/app/ens/_components/ui";
import { PermissionedResolverImplAbi } from "@/app/ens/_lib/ens/abis/PermissionedResolverImpl";
import { dnsEncode } from "@/app/ens/_lib/ens/names";
import { ResolverRoles } from "@/app/ens/_lib/ens/roles";
import { shortError } from "@/app/ens/_lib/ens/universal-resolver-v2";
import { useMyResolver } from "@/app/ens/_lib/hooks/useMyResolver";
import { useNameInfo } from "@/app/ens/_lib/hooks/useNameInfo";
import { useTx } from "@/app/ens/_lib/hooks/useTx";
import { CHAIN_ID } from "@/app/ens/_lib/wagmi";
import { ENS_SUFFIX } from "@/lib/ens-name";
import { ALL_RECORD_KEYS, type RecordKey, type TreePlan, changedKeys } from "@/lib/ens-records";
import { resolveRecords } from "@/lib/ens-resolve";

/** setText calls per transaction, as in `npm run ens:publish`. */
const CHUNK = 60;

/**
 * Writes the Petri tree to ENS: each version's record as text records on its
 * name. Every name is below petri.eth, so the one resolver on petri.eth
 * serves them all, and only records that differ from ENS are sent.
 */
export function PublishTreeCard({ onSelect }: { onSelect?: (name: string) => void }) {
  const { address } = useConnection();
  const { mutateAsync } = useWriteContract();
  const info = useNameInfo(ENS_SUFFIX);
  const my = useMyResolver();
  const tx = useTx();
  const [step, setStep] = useState<string | null>(null);

  const plan = useQuery({
    queryKey: ["ens-plan"],
    queryFn: async (): Promise<TreePlan> => {
      const res = await fetch("/api/ens-plan");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body as TreePlan;
    },
  });

  // Read here rather than through /api/ens-records: that route caches each name
  // for 15 s, and the counts should change as soon as a publish lands.
  const names = plan.data?.names.map((n) => n.name) ?? [];
  const onChain = useQuery({
    queryKey: ["ens-plan-records", names],
    enabled: names.length > 0,
    queryFn: () => resolveRecords(names),
  });

  const resolver = info.resolver;
  const canWrite = useReadContract({
    address: resolver ?? undefined,
    abi: PermissionedResolverImplAbi,
    functionName: "hasRootRoles",
    args: address ? [ResolverRoles.ROLE_SET_TEXT, address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!resolver && !!address },
  });
  const isMine = !!resolver && !!my.resolver && isAddressEqual(resolver, my.resolver);

  const have = onChain.data;
  const failed = have?.find((l) => l.error);
  const rows =
    plan.data && have && !failed
      ? plan.data.names.map((n, i) => ({ ...n, keys: changedKeys(n.records, have[i].texts, ALL_RECORD_KEYS) as RecordKey[] }))
      : null;
  const toWrite = rows?.reduce((sum, r) => sum + r.keys.length, 0) ?? 0;
  const upToDate =
    rows?.reduce((sum, r) => sum + ALL_RECORD_KEYS.filter((k) => r.records[k] !== "" && !r.keys.includes(k)).length, 0) ?? 0;
  const txCount = Math.ceil(toWrite / CHUNK);

  const publish = async () => {
    if (!rows || !resolver) return;
    const calls: Hex[] = rows.flatMap((r) =>
      r.keys.map((k) =>
        encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "setText", args: [dnsEncode(r.name), k, r.records[k]] }),
      ),
    );
    for (let i = 0; i < txCount; i++) {
      setStep(`Transaction ${i + 1} of ${txCount}`);
      const r = await tx.run(() =>
        mutateAsync({
          address: resolver,
          abi: PermissionedResolverImplAbi,
          functionName: "multicall",
          args: [calls.slice(i * CHUNK, (i + 1) * CHUNK)],
          chainId: CHAIN_ID,
        }),
      );
      if (!r) break;
    }
    setStep(null);
    await onChain.refetch();
  };

  const blocker = !address ? (
    <Notice>Connect a wallet to publish.</Notice>
  ) : info.loading ? null : !info.active ? (
    <Notice tone="warning" title={`${ENS_SUFFIX} is not registered`}>
      {my.deployed ? "" : "Mint test USDC and deploy your resolver in section 1. "}Register {ENS_SUFFIX} in section 2, then
      point it at your resolver in section 3.
    </Notice>
  ) : !resolver ? (
    <Notice tone="warning" title={`${ENS_SUFFIX} has no resolver`}>
      {!info.isOwner
        ? `${ENS_SUFFIX} belongs to another account, and only its owner can set a resolver.`
        : my.deployed
          ? `Point ${ENS_SUFFIX} at your resolver in section 3.`
          : `Deploy your resolver in section 1, then point ${ENS_SUFFIX} at it in section 3.`}
    </Notice>
  ) : canWrite.data === false ? (
    <Notice tone="warning" title="Not your resolver">
      This account cannot set text records on {ENS_SUFFIX}&apos;s resolver. Connect the account that deployed it, or ask its
      owner for the text role (section 5).
    </Notice>
  ) : null;

  return (
    <Card
      title="8. Publish the Petri tree"
      description={`Write each version's record as text records on its name. One resolver on ${ENS_SUFFIX} serves every version.`}
      actions={
        <Button variant="secondary" onClick={() => void onChain.refetch()} disabled={names.length === 0 || onChain.isFetching}>
          Refresh
        </Button>
      }
    >
      {info.loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <KV
          rows={[
            [
              ENS_SUFFIX,
              <span key="s" className="inline-flex gap-2">
                <Badge tone={info.active ? "success" : "neutral"}>{info.status ?? "—"}</Badge>
                {info.isOwner && <Badge tone="info">you</Badge>}
              </span>,
            ],
            [
              "Resolver",
              <span key="r" className="inline-flex flex-wrap gap-2">
                <AddressLink address={resolver} />
                {isMine && <Badge tone="info">yours</Badge>}
              </span>,
            ],
            ["Names", plan.data ? plan.data.names.length : "—"],
            ["Records to write", rows ? toWrite : "—"],
            ["Up to date", rows ? upToDate : "—"],
          ]}
        />
      )}

      {plan.error && <ErrorText>Could not load the tree: {plan.error.message}</ErrorText>}
      {onChain.isLoading && <p className="text-sm text-zinc-500">Reading the records on ENS…</p>}
      {(failed || onChain.error) && (
        <ErrorText>Could not read ENS: {failed?.error ?? shortError(onChain.error)}</ErrorText>
      )}

      {rows && (
        <ul className="flex max-h-72 flex-col gap-1 overflow-auto text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3">
              <span className="min-w-0 break-all font-mono text-xs">{r.name}</span>
              {r.keys.length === 0 ? <Badge tone="success">up to date</Badge> : <Badge tone="warning">{r.keys.length} to write</Badge>}
            </li>
          ))}
        </ul>
      )}

      {blocker ?? (
        rows && (
          <Row>
            {toWrite === 0 ? (
              <Notice tone="success">Every record is up to date.</Notice>
            ) : (
              <>
                <TxButton tx={tx} onClick={publish}>
                  Publish {toWrite} record{toWrite === 1 ? "" : "s"}
                </TxButton>
                <span className="text-sm text-zinc-500">
                  {step ?? `${txCount} transaction${txCount === 1 ? "" : "s"} of up to ${CHUNK} records`}
                </span>
              </>
            )}
          </Row>
        )
      )}
      {info.isOwner && !resolver && my.deployed && onSelect && (
        <Row>
          <Button variant="secondary" onClick={() => onSelect(ENS_SUFFIX)}>
            Work on {ENS_SUFFIX} in section 3
          </Button>
        </Row>
      )}
      <p className="text-xs text-zinc-500">
        From a terminal: <Mono>npm run ens:publish -- --dry-run</Mono>, then <Mono>npm run ens:publish</Mono> with{" "}
        <Mono>PETRI_ENS_PRIVATE_KEY</Mono> in .env.local.
      </p>
      <TxStatus tx={tx} />
    </Card>
  );
}
