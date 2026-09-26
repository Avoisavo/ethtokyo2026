import { NextResponse } from "next/server";

import { setOwner } from "@/lib/world/agent/store";

/** Forget the agent's bound owner, so the next approval binds a new one. */
export async function POST() {
  setOwner(null);
  return NextResponse.json({ ok: true });
}
