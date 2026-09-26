import type { NextRequest } from "next/server";
import { ENS_CHAIN_ID, type EnsLookup, type EnsRecordsResponse } from "@/lib/ens/records";
import { parseNamesParam, resolveRecords } from "@/lib/ens/resolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Long enough that a page of panels shares one lookup, short enough that a publish shows up quickly. */
const TTL_MS = 15_000;

/** Lookups by name. The promise is stored, so two panels asking at once share one eth_call. */
const cache = new Map<string, { at: number; lookup: Promise<EnsLookup> }>();

/**
 * GET /api/ens/records?names=a.petri.eth,b.petri.eth
 *
 * The text records each version name holds on Sepolia ENSv2, read through the
 * Universal Resolver. Only names under petri.eth are looked up. A failed
 * lookup is not cached, so the next request tries again.
 */
export async function GET(request: NextRequest) {
  const parsed = parseNamesParam(request.nextUrl.searchParams.get("names"));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: { "cache-control": "no-store" } });

  const now = Date.now();
  for (const [name, hit] of cache) if (now - hit.at > TTL_MS) cache.delete(name);

  const missing = parsed.names.filter((name) => !cache.has(name));
  if (missing.length > 0) {
    const batch = resolveRecords(missing);
    missing.forEach((name, i) => {
      const lookup = batch.then(
        (results) => results[i],
        (e: unknown): EnsLookup => ({ name, resolver: null, texts: {}, error: e instanceof Error ? e.message : String(e) }),
      );
      cache.set(name, { at: now, lookup });
      void lookup.then((r) => {
        if (r.error && cache.get(name)?.lookup === lookup) cache.delete(name);
      });
    });
  }

  const results = await Promise.all(parsed.names.map((name) => cache.get(name)!.lookup));
  const body: EnsRecordsResponse = { chainId: ENS_CHAIN_ID, results };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
