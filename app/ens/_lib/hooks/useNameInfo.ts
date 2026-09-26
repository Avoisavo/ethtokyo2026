"use client";

import { isAddressEqual } from "viem";
import { useConnection, useReadContract } from "wagmi";

import { ETHRegistryAbi } from "@/app/ens/_lib/ens/abis/ETHRegistry";
import { addresses } from "@/app/ens/_lib/ens/contracts";
import { labelId, splitFirst } from "@/app/ens/_lib/ens/names";
import { CHAIN_ID } from "@/app/ens/_lib/wagmi";

import { useHierarchy } from "./useHierarchy";

export const STATUS = ["available", "reserved", "registered"] as const;

/**
 * Where a name lives and who controls it. `registry` is the PermissionedRegistry
 * (ETHRegistry for .eth names, a UserRegistry for subnames) holding its label.
 */
export function useNameInfo(name: string | null) {
  const { address } = useConnection();
  const walk = useHierarchy(name);
  const [label, parent] = name ? splitFirst(name) : ["", ""];
  const registry = walk.data?.registry ?? undefined;
  const hop = walk.data?.complete ? walk.data.hops[walk.data.hops.length - 1] : undefined;

  const state = useReadContract({
    address: registry,
    abi: ETHRegistryAbi,
    functionName: "getState",
    args: [labelId(label)],
    chainId: CHAIN_ID,
    query: { enabled: !!registry && !!label },
  });

  const s = state.data;
  // The registry already reports expired names as AVAILABLE.
  const active = !!s && s.status === 2;
  const isOwner = active && !!address && isAddressEqual(s.latestOwner, address);

  return {
    label,
    parent,
    registry,
    isEth2ld: !!registry && isAddressEqual(registry, addresses.ETHRegistry) && parent === "eth",
    state: s,
    status: s ? STATUS[s.status] : undefined,
    active,
    isOwner,
    resolver: hop?.resolver ?? null,
    subregistry: hop?.subregistry ?? null,
    loading: walk.isLoading || state.isLoading,
    refetch: async () => {
      await walk.refetch();
      await state.refetch();
    },
  };
}
