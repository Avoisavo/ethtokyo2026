/**
 * Intercepta on the platform's side: before a wallet may stake, submit for
 * free with World ID, or join a verify round, the platform asks Intercepta
 * Quick Scan about its history. World ID says the person is one unique human.
 * This says their wallet has no record of scams, sanctions or blacklists.
 *
 *   clear    the wallet may go on
 *   caution  it may go on, and the step says why (a trait, or a score ≥ 30)
 *   block    refused: a blocking trait, or a score ≥ 80
 *   no answer from Intercepta: refused, never let through by default
 */

import { quickScanAddress } from "@/lib/intercepta/client";
import { getInterceptaConfig } from "@/lib/intercepta/config";
import { addressVerdict, type Level } from "@/lib/intercepta/decision";
import { MarketError } from "./service";

export type Screen = { wallet: string; level: Level; score: number | null; detail: string; ms: number };

export async function screenWallet(wallet: string): Promise<Screen> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new MarketError("Connect a wallet first: Intercepta checks it before you go on.");
  const ic = getInterceptaConfig();
  if (!ic.ok) throw new MarketError("INTERCEPTA_API_KEY is not set, so the platform cannot check wallets.", 503);
  const call = await quickScanAddress(wallet, ic.config.client);
  const v = addressVerdict(call, ic.config.thresholds);
  const short = `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
  if (v.level === "unavailable") throw new MarketError(`Intercepta did not answer about ${short}, so the platform holds. Try again.`, 503);
  if (v.level === "block") throw new MarketError(`Intercepta flagged ${short}: ${v.reasons.join(" · ")}`, 403);
  const detail = v.level === "clear" ? `toxic score ${v.score}, no risk traits` : `caution: ${v.reasons.join(" · ")}`;
  return { wallet, level: v.level, score: v.score, detail, ms: call.latencyMs };
}
