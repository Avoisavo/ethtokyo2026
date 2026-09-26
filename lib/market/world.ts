/**
 * The World ID check behind "submit for free". Server only.
 *
 * The trust moment: a version enters the verifier pool at the platform's
 * cost. One human may do that FREE_SUBMITS_PER_DAY times a day. The proof's
 * nullifier is the count key, and its signal is the version id, so a proof
 * for one version cannot submit another.
 *
 * The credential is Selfie Check on protocol 3.0, the one flow this app has
 * seen succeed on a real phone (see FEEDBACK.md). It is the same action for
 * every submit, so one human always gets the same nullifier here.
 */

import { hashSignal } from "@worldcoin/idkit/hashing";

import { MarketError, findVersion } from "./service";
import { requireConfig } from "@/lib/world/idkit/config";
import { type IDKitResultV3, type ResponseItemV3, isSelfieIdentifier } from "@/lib/world/idkit/types";
import { verifySelfieProof } from "@/lib/world/idkit/verify";

export const SUBMIT_ACTION = "petri-submit";

/** Verifies the proof with the Developer Portal. Returns the nullifier. */
export async function checkSubmitProof(id: string, result: IDKitResultV3): Promise<{ nullifier: string }> {
  const config = requireConfig();
  const v = await findVersion(id);
  if (result.protocol_version !== config.proofVersion) throw new MarketError(`World ID ${config.proofVersion} only, got ${String(result.protocol_version)}.`);
  const item = result.responses?.find((r: ResponseItemV3) => isSelfieIdentifier(r.identifier));
  if (!item) throw new MarketError("The result holds no Selfie Check credential.");
  if (!item.signal_hash || BigInt(item.signal_hash) !== BigInt(hashSignal(v.node.id))) {
    throw new MarketError("The proof is for another version: the signal does not match.");
  }
  const attempt = await verifySelfieProof({ config, item, action: SUBMIT_ACTION, nonce: result.nonce });
  if (!attempt.ok) throw new MarketError(`World ID refused the proof: ${attempt.code ?? "unknown"}. ${attempt.guidance ?? ""}`.trim(), 403);
  return { nullifier: item.nullifier };
}
