import "server-only";

import type { ClientOptions } from "./client";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./decision";

/**
 * Settings for Intercepta payment screening. The key stays on the server. The
 * page receives only whether it is set.
 */

export type InterceptaConfig = {
  client: ClientOptions;
  thresholds: Thresholds;
  /** INTERCEPTA_SCAN_MESSAGE=off skips Scan Message. Quick Scan always runs. */
  scanMessage: boolean;
};

export type InterceptaConfigResult =
  | { ok: true; config: InterceptaConfig }
  | { ok: false; problems: { name: string; issue: string; fix: string }[] };

const int = (raw: string | undefined, fallback: number) => {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function getInterceptaConfig(): InterceptaConfigResult {
  const apiKey = process.env.INTERCEPTA_API_KEY?.trim();
  const scan = process.env.INTERCEPTA_SCAN_MESSAGE?.trim() || "on";
  const problems: { name: string; issue: string; fix: string }[] = [];

  if (!apiKey) {
    problems.push({
      name: "INTERCEPTA_API_KEY",
      issue: "Not set. Every payment will be held, because Petri never pays an unscreened wallet.",
      fix: "Get a free sandbox key at https://intercepta.io/ethglobal. Server-side only; never prefix with NEXT_PUBLIC_.",
    });
  }
  if (scan !== "on" && scan !== "off") {
    problems.push({ name: "INTERCEPTA_SCAN_MESSAGE", issue: `"${scan}" is not on or off.`, fix: "Use on (default) or off." });
  }
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    config: {
      client: {
        apiKey: apiKey!,
        baseUrl: process.env.INTERCEPTA_API_URL?.trim() || undefined,
        timeoutMs: int(process.env.INTERCEPTA_TIMEOUT_MS, 6000),
        cacheTtlMs: int(process.env.INTERCEPTA_CACHE_TTL_S, 300) * 1000,
      },
      thresholds: {
        blockScore: int(process.env.INTERCEPTA_BLOCK_SCORE, DEFAULT_THRESHOLDS.blockScore),
        holdScore: int(process.env.INTERCEPTA_HOLD_SCORE, DEFAULT_THRESHOLDS.holdScore),
      },
      scanMessage: scan === "on",
    },
  };
}
