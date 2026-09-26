import { NextResponse } from "next/server";

import { getAttempt, publicAttempt, saveAttempt } from "@/lib/world-agent/store";

/** Abandon an attempt. A later approval for it is ignored by the poll route. */
export async function POST(request: Request) {
  const { id } = (await request.json().catch(() => ({}))) as { id?: string };
  const a = id ? getAttempt(id) : undefined;
  if (!a) return NextResponse.json({ ok: false, code: "unknown_attempt" }, { status: 404 });
  if (a.status === "pending") {
    a.status = "cancelled";
    a.code = "cancelled";
    a.detail = "Cancelled before approval. The device code is dropped and a late approval will not run the action.";
    saveAttempt(a);
  }
  return NextResponse.json({ ok: true, attempt: publicAttempt(a) });
}
