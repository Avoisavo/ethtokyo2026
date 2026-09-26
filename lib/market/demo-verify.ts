/**
 * The verify round of the stage demo, for one version. Server only.
 *
 * Demo: the World ID scan and the stake on the Verify tab, and the pick, which
 * picks you at once. Real, on Sepolia: the verifier name `verifier1.<version>`
 * (it expires after 10 minutes), the access control that lets only the
 * verifier wallet write `petri.vote`, the vote that wallet sends, and the
 * close that takes the right back.
 *
 * The verifier wallet is made here and saved in petri/.petri/scratch, so
 * `pnpm demo:vote` on the same machine can sign with it. Git ignores that folder.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type Address, type Hex, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { moveName } from "@/lib/ens/name";
import { fullDescription } from "@/lib/ens/records";
import { PETRI_ROOT } from "@/lib/tree";
import { grantTextKey, readTexts, registerSubname, revokeTextKey, sendEth, stateOf, writeTexts } from "./chain";
import { ACCESS_KEYS, VOTE_SECONDS, WEIGHT_WITHOUT, WEIGHT_WITH_WORLD_ID } from "./records";
import { MarketError, findVersion } from "./service";

const DIR = path.join(PETRI_ROOT, ".petri", "scratch");
const STATE = path.join(DIR, "demo-verify.json");
/** The verifier wallet `pnpm demo:vote` signs with. */
export const WALLET_FILE = path.join(DIR, "verifier-wallet.json");
const DEMO_NOTE = "Stage demo of a verify round: the join was a demo, the names, access control and vote are real.";

export type DemoRound = {
  id: string;
  version: string;
  verifier: string;
  wallet: Address;
  human: "world" | "stake";
  price: number;
  until: number;
  txs: Record<string, Hex | undefined>;
  vote?: string;
  closed?: boolean;
};

const read = (): DemoRound | null => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as DemoRound) : null);
const save = (r: DemoRound | null) => { mkdirSync(DIR, { recursive: true }); writeFileSync(STATE, r ? `${JSON.stringify(r, null, 2)}\n` : "null\n"); };
const now = () => Math.floor(Date.now() / 1000);

export type DemoStep = { step: string; state: "run" | "done"; detail?: string; tx?: string } | { step: "done" };

/** The demo round now, or null, with the verifier name's expiry as the registry holds it. */
export async function demoRound(): Promise<(DemoRound & { expiry: number; live: boolean }) | null> {
  const r = read();
  if (!r) return null;
  const s = await stateOf(r.verifier).catch(() => null);
  const expiry = s ? Number(s.state.expiry) : r.until;
  return { ...r, expiry, live: !!s?.exists && expiry > now() };
}

/** Forgets the round, so the demo can run again. The names expire by themselves. */
export function demoReset() {
  save(null);
  return { reset: true };
}

/**
 * You join and are picked at once. The platform registers the round and your
 * verifier name for 10 minutes, makes your verifier wallet, sends it gas, and
 * opens the access control: only that wallet may write petri.vote.
 */
export async function demoJoin(id: string, input: { human: "world" | "stake"; price?: number; person?: string }, onStep: (s: DemoStep) => void) {
  const { node, name } = await findVersion(id);
  const have = read();
  if (have && have.id === node.id && !have.closed && have.until > now()) throw new MarketError("You are already picked. Run the verify, then the vote.", 409);
  const version = moveName(name, "pending");
  const verifier = `verifier1.${version}`;
  const until = now() + VOTE_SECONDS;
  const txs: DemoRound["txs"] = {};

  // Intercepta checks the person's own wallet first. A flagged wallet gets no name and no access.
  const person = input.person ?? "";
  onStep({ step: "screen", state: "run", detail: `Intercepta Quick Scan on ${person.slice(0, 6)}…${person.slice(-4)}` });
  const { screenWallet } = await import("./screen");
  const screen = await screenWallet(person);
  onStep({ step: "screen", state: "done", detail: `${person.slice(0, 6)}…${person.slice(-4)} · ${screen.detail} · ${screen.ms} ms` });

  const key = generatePrivateKey();
  const wallet = privateKeyToAccount(key).address;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(WALLET_FILE, `${JSON.stringify({ address: wallet, privateKey: key, verifier }, null, 2)}\n`, { mode: 0o600 });

  const weight = input.human === "world" ? WEIGHT_WITH_WORLD_ID : WEIGHT_WITHOUT;
  onStep({ step: "verifier", state: "run", detail: verifier });
  txs.verifier = (await registerSubname(verifier, BigInt(until), wallet)) ?? undefined;
  const vRecords: Record<string, string> = {
    [ACCESS_KEYS.wallet]: wallet,
    [ACCESS_KEYS.human]: input.human === "world" ? "world" : "none",
    [ACCESS_KEYS.vote]: "",
    "petri.weight": String(weight),
    "petri.person": person,
    "petri.intercepta": `${screen.level} · score ${screen.score}`,
    "petri.expires": new Date(until * 1000).toISOString(),
    "petri.demo": DEMO_NOTE,
  };
  await writeTexts(verifier, { ...vRecords, description: fullDescription(`Verifier 1 of ${version}. It may write petri.vote until the close.`, vRecords) });
  onStep({ step: "verifier", state: "done", detail: verifier, tx: txs.verifier });

  onStep({ step: "open", state: "run", detail: `${wallet.slice(0, 6)}…${wallet.slice(-4)} may write petri.vote` });
  txs.gas = await sendEth(wallet, parseEther("0.003"));
  txs.open = await grantTextKey(wallet, ACCESS_KEYS.vote);
  onStep({ step: "open", state: "done", detail: `${wallet.slice(0, 6)}…${wallet.slice(-4)} may write petri.vote`, tx: txs.open });

  save({ id: node.id, version, verifier, wallet, human: input.human, price: input.price ?? 0, until, txs });
  onStep({ step: "done" });
}

/**
 * After the vote: reads it from the verifier name, and closes the access
 * control, so the wallet can write petri.vote no more.
 */
export async function demoClose(voteTx?: string) {
  const r = read();
  if (!r) throw new MarketError("No demo round. Join on the Verify tab first.", 409);
  if (r.closed) return r;
  const t = await readTexts(r.verifier, [ACCESS_KEYS.vote]);
  const vote = t[ACCESS_KEYS.vote];
  if (!vote) throw new MarketError(`No vote on ${r.verifier} yet.`, 409);
  const closeTx = await revokeTextKey(r.wallet, ACCESS_KEYS.vote);
  const after = await readTexts(r.verifier, [ACCESS_KEYS.wallet, ACCESS_KEYS.human, ACCESS_KEYS.vote, "petri.weight", "petri.expires", "petri.demo"]);
  await writeTexts(r.verifier, { description: fullDescription(`Verifier 1 of ${r.version}. It voted ${vote}. The access control is closed.`, { ...after, "petri.access": "closed" }) });
  const next: DemoRound = { ...r, vote, closed: true, txs: { ...r.txs, close: closeTx, ...(voteTx && /^0x[0-9a-fA-F]{64}$/.test(voteTx) ? { vote: voteTx as Hex } : {}) } };
  save(next);
  return next;
}
