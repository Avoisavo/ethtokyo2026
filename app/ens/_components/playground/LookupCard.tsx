"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { isAddress } from "viem";
import { usePublicClient } from "wagmi";

import { AddressLink, Card, Field, Input, KV } from "@/app/ens/_components/ui";
import { ENSV2_SEPOLIA } from "@/app/ens/_lib/ens/deployments";
import { walkHierarchy } from "@/app/ens/_lib/ens/hierarchy";
import { tryNormalize } from "@/app/ens/_lib/ens/names";
import { CHAIN_ID } from "@/app/ens/_lib/wagmi";

const TEXT_KEYS = ["description", "url", "avatar", "com.twitter"];
const KNOWN = Object.fromEntries(Object.entries(ENSV2_SEPOLIA).map(([n, d]) => [d.address.toLowerCase(), n]));

export function LookupCard() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const [input, setInput] = useState("nick.eth");
  const query = input.trim();
  const asAddress = isAddress(query) ? query : null;
  const asName = asAddress ? null : tryNormalize(query);

  const nameResult = useQuery({
    queryKey: ["lookup-name", asName],
    enabled: !!client && !!asName,
    queryFn: async () => {
      const [address, resolver, walk, ...texts] = await Promise.all([
        client!.getEnsAddress({ name: asName! }).catch(() => null),
        client!.getEnsResolver({ name: asName! }).catch(() => null),
        walkHierarchy(client!, asName!),
        ...TEXT_KEYS.map((key) => client!.getEnsText({ name: asName!, key }).catch(() => null)),
      ]);
      return { address, resolver, walk, texts };
    },
  });
  const addressResult = useQuery({
    queryKey: ["lookup-address", asAddress],
    enabled: !!client && !!asAddress,
    queryFn: () => client!.getEnsName({ address: asAddress! }).catch(() => null),
  });

  const r = nameResult.data;

  return (
    <Card title="7. Look up any name or address" description="Resolution through the ENSv2 Universal Resolver, plus the registry path it walks.">
      <Field label="Name or address">
        <Input value={input} onChange={(e) => setInput(e.target.value)} className="max-w-md" />
      </Field>
      {asAddress && (
        <KV rows={[["Primary name", addressResult.isLoading ? "…" : addressResult.data ?? "none"]]} />
      )}
      {asName && (nameResult.isLoading ? (
        <p className="text-sm text-zinc-500">Resolving…</p>
      ) : r ? (
        <KV
          rows={[
            ["ETH address", <AddressLink key="a" address={r.address} />],
            [
              "Resolver",
              <span key="r">
                <AddressLink address={r.resolver} />
                {r.resolver && KNOWN[r.resolver.toLowerCase()] && <span className="ml-2 text-xs text-zinc-500">{KNOWN[r.resolver.toLowerCase()]}</span>}
              </span>,
            ],
            [
              "Registry path",
              <span key="p" className="text-xs">
                {r.walk.hops.map((h) => `${h.name} → ${KNOWN[h.registry.toLowerCase()] ?? h.registry.slice(0, 10) + "…"}`).join("  ·  ") || "—"}
              </span>,
            ],
            ...TEXT_KEYS.map((k, i): [string, React.ReactNode] => [k, r.texts[i] || "—"]),
          ]}
        />
      ) : null)}
      {query && !asAddress && !asName && <p className="text-sm text-red-600">Not a valid name or address.</p>}
    </Card>
  );
}
