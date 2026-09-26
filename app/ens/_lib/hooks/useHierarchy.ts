"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";

import { walkHierarchy } from "@/app/ens/_lib/ens/hierarchy";
import { CHAIN_ID } from "@/app/ens/_lib/wagmi";

/** Walks the registry tree for a normalized name. Disabled for empty names. */
export function useHierarchy(name: string | null | undefined) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  return useQuery({
    queryKey: ["ens-hierarchy", name],
    queryFn: () => walkHierarchy(client!, name!),
    enabled: !!client && !!name,
  });
}
