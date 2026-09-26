"use client";

import { useEffect, useState } from "react";
import type { EnsLookup, EnsRecordsResponse } from "@/lib/ens-records";

/**
 * - `off`: not looked up (a showcase tree has nothing on ENS).
 * - `loading`: the first answer for these names has not arrived.
 * - `ready`: every name was looked up. A name may still hold no record.
 * - `error`: the route or the RPC did not answer.
 */
export type EnsState = "off" | "loading" | "ready" | "error";

/** The route refuses more names than this in one request. */
const CHUNK = 64;
/** Coming back to the tab refetches, at most this often. */
const FOCUS_MS = 15_000;

const EMPTY = new Map<string, EnsLookup>();

interface Loaded { key: string; state: "ready" | "error"; byName: Map<string, EnsLookup> }

async function fetchChunk(names: string[], signal: AbortSignal): Promise<EnsLookup[]> {
  const res = await fetch(`/api/ens-records?${new URLSearchParams({ names: names.join(",") })}`, { cache: "no-store", signal });
  if (!res.ok) throw new Error(`ens-records answered ${res.status}`);
  const data = (await res.json()) as EnsRecordsResponse;
  if (!Array.isArray(data.results)) throw new Error("ens-records answered without results");
  return data.results;
}

/**
 * Reads the ENS text records of every name, through /api/ens-records.
 *
 * The tree page has no react-query, so this is a plain effect. It reads once,
 * again when the tab regains focus, and again when LiveRefresh announces a new
 * record. While a new name list loads, the last answer stays on screen.
 */
export function useEnsRecords(names: string[], enabled: boolean): { state: EnsState; byName: Map<string, EnsLookup> } {
  // A joined string, so a new array with the same names does not refetch.
  const key = names.join(",");
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!enabled || key === "") return;
    const list = key.split(",");
    let current: AbortController | null = null;
    let lastAt = 0;

    const load = async () => {
      current?.abort();
      const ctrl = new AbortController();
      current = ctrl;
      lastAt = Date.now();
      try {
        const chunks: string[][] = [];
        for (let i = 0; i < list.length; i += CHUNK) chunks.push(list.slice(i, i + CHUNK));
        const results = (await Promise.all(chunks.map((c) => fetchChunk(c, ctrl.signal)))).flat();
        if (!ctrl.signal.aborted) setLoaded({ key, state: "ready", byName: new Map(results.map((r) => [r.name, r])) });
      } catch {
        if (!ctrl.signal.aborted) setLoaded({ key, state: "error", byName: EMPTY });
      }
    };

    const onFocus = () => { if (Date.now() - lastAt >= FOCUS_MS) void load(); };
    const onDetected = () => void load();
    window.addEventListener("focus", onFocus);
    window.addEventListener("petri:detected", onDetected);
    void load();
    return () => {
      current?.abort();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("petri:detected", onDetected);
    };
  }, [key, enabled]);

  if (!enabled) return { state: "off", byName: EMPTY };
  if (loaded === null) return { state: "loading", byName: EMPTY };
  return { state: loaded.key === key ? loaded.state : "loading", byName: loaded.byName };
}
