import { NextResponse } from "next/server";

import { MarketError } from "@/lib/market/service";

/** Runs a market action and maps its errors to JSON. */
export async function handle<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    return NextResponse.json({ ok: true, ...(await fn()) });
  } catch (e) {
    if (e instanceof MarketError) return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export const body = async <T>(request: Request): Promise<T> => (await request.json().catch(() => ({}))) as T;
