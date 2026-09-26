/**
 * The names and text records of the harness market, on top of the version
 * records in lib/ens/records.ts. Pure.
 *
 *   v3.<tree>.petri.eth              the version: encrypted docs, how it was submitted, access
 *   v3-1.v3.<tree>.petri.eth         its verify round (v3.1 in the UI)
 *   k2.v3-1.v3.<tree>.petri.eth      the second chosen verifier of that round
 *   buyer-1.v3.<tree>.petri.eth      the first buyer of the version
 */

import { versionName } from "../ens/name";

/** Records on the version name. */
export const VERSION_KEYS = {
  /** The encrypted document set, one record per file: `petri.doc.prompt.ts`. */
  docPrefix: "petri.doc.",
  /** The sha256 of the plain documents, so a reader can prove what they read. */
  docHash: "petri.doc.hash",
  /** The file names in the set, comma separated. */
  docList: "petri.doc.list",
  /** `free` for a World ID human, or `stake:USDC:<amount>`. */
  submit: "petri.submit",
  /** The nullifier of the human who submitted, or the wallet that staked. */
  submitter: "petri.submitter",
  /** `open` while a round runs, `closed` after. */
  access: "petri.access",
  /** The price in USDC to use the harness once. */
  price: "petri.price",
} as const;

/** Records on a round name. */
export const ROUND_KEYS = {
  /** `open`, `picked`, `accepted`, `rejected` or `expired`. */
  status: "petri.round.status",
  /** The unix time the round closes. */
  until: "petri.round.until",
  /** How many verifiers are picked. */
  size: "petri.round.size",
  /** The pool as JSON: RoundMember[]. */
  pool: "petri.round.pool",
  /** The random seed used to pick, so anyone can replay it. Empty until picked. */
  seed: "petri.round.seed",
  /** The picked verifier labels, comma separated: `k1,k2`. */
  picked: "petri.round.picked",
} as const;

/** Records on a verifier or buyer name. */
export const ACCESS_KEYS = {
  /** The wallet of the person. */
  wallet: "petri.wallet",
  /** The access public key the file key was sealed to. */
  accessKey: "petri.access-key",
  /** The file key, sealed to that access key. */
  key: "petri.key",
  /** `yes:+7000bp` or `no:-3000bp`. Only the verifier can write it. */
  vote: "petri.vote",
  /** Whether a fresh World ID approval backed the join: `world` or `none`. */
  human: "petri.human",
} as const;

export type RoundStatus = "open" | "picked" | "accepted" | "rejected" | "expired";

export interface RoundMember {
  wallet: string;
  accessKey: string;
  /** `world` when a fresh World ID for Agents approval backed the join. */
  human: "world" | "none";
  /** The pick weight: 3 with World ID, 1 without. */
  weight: number;
  joinedAt: number;
}

export const WEIGHT_WITH_WORLD_ID = 3;
export const WEIGHT_WITHOUT = 1;
export const ROUND_SECONDS = 5 * 60;
export const ROUND_SIZE = 5;
/** Free submissions per human per day. */
export const FREE_SUBMITS_PER_DAY = 3;
export const STAKE_USDC = 5;
export const PRICE_USDC = 1;

/** `v3` → `v3-1`: the first round of v3. */
export const roundLabel = (version: string, n: number): string => `${version}-${n}`;
export const roundName = (version: string, n: number): string => `${roundLabel(version, n)}.${versionName(version)}`;
export const verifierLabel = (i: number): string => `k${i}`;
export const verifierName = (version: string, round: number, i: number): string => `${verifierLabel(i)}.${roundName(version, round)}`;
export const buyerLabel = (i: number): string => `buyer-${i}`;
export const buyerName = (version: string, i: number): string => `${buyerLabel(i)}.${versionName(version)}`;

/** The doc record key for a file name: `prompt.ts` → `petri.doc.prompt.ts`. */
export const docKey = (file: string): string => `${VERSION_KEYS.docPrefix}${file}`;

/**
 * Picks `size` members from the pool, by weight, with a seed. Deterministic,
 * so anyone with the pool and the seed gets the same answer. A member with
 * weight 3 has three chances against one for weight 1. Nobody is picked twice.
 */
export function pickVerifiers(pool: RoundMember[], size: number, seed: string): RoundMember[] {
  const left = [...pool];
  const picked: RoundMember[] = [];
  let x = BigInt(seed);
  while (picked.length < size && left.length > 0) {
    // A simple linear congruential step on the seed. Replayable, not secret.
    x = (x * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
    const total = left.reduce((s, m) => s + m.weight, 0);
    let r = Number(x % BigInt(total));
    const i = left.findIndex((m) => (r -= m.weight) < 0);
    picked.push(left.splice(i, 1)[0]);
  }
  return picked;
}
