/**
 * The harness market: submit, round, join, pick, vote, close and buy.
 * Server only. Every public fact goes to ENS. Every secret stays in the store.
 *
 * Submit     the docs are encrypted and written to the version name. Free for
 *            a World ID human under a rate limit, or for a USDC stake.
 * Round      a subname of the version. Open for ROUND_SECONDS. Anyone with a
 *            wallet joins the pool. A fresh World ID for Agents approval gives
 *            weight 3, else 1.
 * Pick       when the round closes, up to ROUND_SIZE members are picked at
 *            random by weight. Each gets a verifier subname that expires, the
 *            file key sealed to their access key, and the right to write one
 *            text key: petri.vote.
 * Close      the votes are counted, every verifier subname is revoked, and
 *            access on the version is closed.
 * Buy        a USDC payment gives a buyer subname with the sealed key.
 */

import { type Address, type Hex, createPublicClient, decodeEventLog, erc20Abi, http, keccak256, stringToHex, verifyMessage } from "viem";
import { sepolia } from "viem/chains";

import { addresses } from "@/app/ens/_lib/ens/contracts";
import { SEPOLIA_RPC_URL } from "@/lib/ens/resolve";
import { ensNames, versionName } from "@/lib/ens/name";
import { loadTree } from "@/lib/tree";
import { getAttempt } from "@/lib/world/agent/store";

import { grantTextKey, loadDeployment, readTexts, registerSubname, revokeSubname, revokeTextKey, writeTexts } from "./chain";
import { docsHash, encryptText, newFileKey, sealFileKey } from "./crypto";
import { versionDocs } from "./docs";
import {
  ACCESS_KEYS, FREE_SUBMITS_PER_DAY, PRICE_USDC, ROUND_KEYS, ROUND_SECONDS, ROUND_SIZE, STAKE_USDC,
  VERSION_KEYS, WEIGHT_WITHOUT, WEIGHT_WITH_WORLD_ID, type RoundMember, type RoundStatus, buyerName, docKey,
  pickVerifiers, roundName, verifierLabel, verifierName,
} from "./records";
import { readState, updateState } from "./store";

export class MarketError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** How long a picked verifier keeps access, from the pick. */
export const VOTE_SECONDS = 10 * 60;
/** A World ID approval older than this does not count as fresh. */
const FRESH_SECONDS = 15 * 60;
const now = () => Math.floor(Date.now() / 1000);

/** The message a wallet signs to prove an access key is theirs. */
export const accessMessage = (accessKey: string): string => `Petri access key ${accessKey.toLowerCase()}`;

/** A version by id or 8-hex short id, with its label (`v3`). */
export async function findVersion(id: string) {
  const tree = await loadTree();
  if (!tree.ok) throw new MarketError(`The tree did not load: ${tree.error}`, 500);
  const node = tree.data.nodes.find((n) => n.id === id || n.id.startsWith(id));
  if (!node) throw new MarketError(`No version ${id}.`, 404);
  const name = ensNames(tree.data.nodes).get(node.id)!;
  return { node, name, label: name.split(".")[0] };
}

async function checkAccessKey(wallet: string, accessKey: string, signature: string): Promise<Address> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new MarketError("The wallet is not an address.");
  if (!/^0x0[23][0-9a-fA-F]{64}$/.test(accessKey)) throw new MarketError("The access key must be a compressed public key: 0x02 or 0x03 and 64 hex.");
  const ok = await verifyMessage({ address: wallet as Address, message: accessMessage(accessKey), signature: signature as Hex }).catch(() => false);
  if (!ok) throw new MarketError("The signature does not match the wallet and the access key.");
  return wallet as Address;
}

/** Checks a USDC transfer to the platform wallet of at least `usdc`. Returns the sender. */
async function checkPayment(txHash: string, usdc: number): Promise<Address> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new MarketError("The payment tx hash is not valid.");
  const dep = loadDeployment();
  const client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) });
  const receipt = await client.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null);
  if (!receipt || receipt.status !== "success") throw new MarketError("The payment transaction was not found, or it failed.");
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== addresses.MockUSDC.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (ev.eventName === "Transfer" && ev.args.to.toLowerCase() === dep.owner.toLowerCase() && ev.args.value >= BigInt(usdc) * 1_000_000n) {
        return ev.args.from;
      }
    } catch { /* not a Transfer */ }
  }
  throw new MarketError(`The transaction does not pay ${usdc} USDC to ${dep.owner}.`);
}

export type SubmitMode = { kind: "free"; nullifier: string } | { kind: "stake"; txHash: string };

/** Encrypts the version's docs, writes them to its name, and opens round 1. */
export async function submitVersion(id: string, mode: SubmitMode) {
  const { node, name, label } = await findVersion(id);
  let submit: string;
  let submitter: string;
  if (mode.kind === "free") {
    const day = now() - 24 * 3600;
    const used = updateState((s) => {
      const times = (s.freeSubmits[mode.nullifier] ?? []).filter((t) => t > day);
      if (times.length >= FREE_SUBMITS_PER_DAY) return times.length;
      times.push(now());
      s.freeSubmits[mode.nullifier] = times;
      return -1;
    });
    if (used >= 0) throw new MarketError(`This human already used ${used} free submits today. Stake ${STAKE_USDC} USDC, or wait.`, 429);
    submit = "free";
    submitter = mode.nullifier;
  } else {
    const from = await checkPayment(mode.txHash, STAKE_USDC);
    submit = `stake:USDC:${STAKE_USDC}`;
    submitter = from;
  }

  const fileKey = readState().fileKeys[node.id] ?? newFileKey();
  updateState((s) => (s.fileKeys[node.id] = fileKey));
  const docs = versionDocs(node.id, node.hypothesis);
  const records: Record<string, string> = {
    [VERSION_KEYS.docList]: Object.keys(docs).join(","),
    [VERSION_KEYS.docHash]: docsHash(docs),
    [VERSION_KEYS.submit]: submit,
    [VERSION_KEYS.submitter]: submitter,
    [VERSION_KEYS.access]: "open",
    [VERSION_KEYS.price]: String(PRICE_USDC),
  };
  for (const [file, text] of Object.entries(docs)) records[docKey(file)] = encryptText(fileKey, text);
  const tx = await writeTexts(name, records);
  const round = await openRound(label);
  return { id: node.id, name, label, submit, tx, round };
}

/** Opens the next round of a version. */
export async function openRound(label: string) {
  const n = updateState((s) => (s.rounds[label] = (s.rounds[label] ?? 0) + 1));
  const name = roundName(label, n);
  const until = now() + ROUND_SECONDS;
  await registerSubname(name);
  await writeTexts(name, {
    [ROUND_KEYS.status]: "open",
    [ROUND_KEYS.until]: String(until),
    [ROUND_KEYS.size]: String(ROUND_SIZE),
    [ROUND_KEYS.pool]: "[]",
    [ROUND_KEYS.seed]: "",
    [ROUND_KEYS.picked]: "",
  });
  return { n, name, until };
}

export async function readRound(label: string, n: number) {
  const name = roundName(label, n);
  const t = await readTexts(name, Object.values(ROUND_KEYS));
  if (t[ROUND_KEYS.status] === "") throw new MarketError(`No round ${n} of ${label}.`, 404);
  return {
    name,
    status: t[ROUND_KEYS.status] as RoundStatus,
    until: Number(t[ROUND_KEYS.until]),
    size: Number(t[ROUND_KEYS.size]),
    pool: JSON.parse(t[ROUND_KEYS.pool] || "[]") as RoundMember[],
    seed: t[ROUND_KEYS.seed],
    picked: t[ROUND_KEYS.picked] ? t[ROUND_KEYS.picked].split(",") : [],
  };
}

/** The current round number of a version, or 0. */
export const currentRound = (label: string): number => readState().rounds[label] ?? 0;

/**
 * Adds a wallet to the pool. `attemptId` is a World ID for Agents attempt that
 * a human approved in the last FRESH_SECONDS. It raises the weight.
 */
export async function joinRound(label: string, n: number, input: { wallet: string; accessKey: string; signature: string; attemptId?: string }) {
  const round = await readRound(label, n);
  if (round.status !== "open") throw new MarketError(`Round ${n} is ${round.status}, not open.`);
  if (now() >= round.until) throw new MarketError("The round has closed. It waits for the pick.");
  const wallet = await checkAccessKey(input.wallet, input.accessKey, input.signature);
  if (round.pool.some((m) => m.wallet.toLowerCase() === wallet.toLowerCase())) throw new MarketError("This wallet is already in the pool.");

  let human: RoundMember["human"] = "none";
  if (input.attemptId) {
    const a = getAttempt(input.attemptId);
    if (!a || a.status !== "approved") throw new MarketError("The World ID approval is missing, or it did not succeed. Join without it, with weight 1.");
    if ((a.authTime ?? 0) < now() - FRESH_SECONDS) throw new MarketError("The World ID approval is not fresh. Ask again.");
    human = "world";
  }
  const member: RoundMember = { wallet, accessKey: input.accessKey, human, weight: human === "world" ? WEIGHT_WITH_WORLD_ID : WEIGHT_WITHOUT, joinedAt: now() };
  const pool = [...round.pool, member];
  const tx = await writeTexts(round.name, { [ROUND_KEYS.pool]: JSON.stringify(pool) });
  return { member, pool, tx };
}

/** Picks the verifiers once the join window is over. */
export async function pickRound(label: string, n: number, force = false) {
  const round = await readRound(label, n);
  if (round.status !== "open") throw new MarketError(`Round ${n} is ${round.status}.`);
  if (!force && now() < round.until) throw new MarketError(`The round is open for ${round.until - now()} more seconds.`);
  const { node, name: versionN } = await findVersion(await versionIdOf(label));
  const fileKey = readState().fileKeys[node.id];
  if (!fileKey) throw new MarketError("This version was never submitted here, so there is no file key.", 409);

  // The seed is public and replayable: the round name, its close time and the pool.
  const seed = keccak256(stringToHex(`${round.name}|${round.until}|${JSON.stringify(round.pool)}`));
  const picked = pickVerifiers(round.pool, round.size, seed);
  const until = now() + VOTE_SECONDS;
  const verifiers: { label: string; name: string; wallet: string }[] = [];
  for (const [i, m] of picked.entries()) {
    const vName = verifierName(label, n, i + 1);
    await registerSubname(vName, BigInt(until));
    await writeTexts(vName, {
      [ACCESS_KEYS.wallet]: m.wallet,
      [ACCESS_KEYS.accessKey]: m.accessKey,
      [ACCESS_KEYS.key]: sealFileKey(fileKey, m.accessKey),
      [ACCESS_KEYS.human]: m.human,
      [ACCESS_KEYS.vote]: "",
    });
    await grantTextKey(m.wallet as Address, ACCESS_KEYS.vote);
    updateState((s) => (s.voteRoles[m.wallet] = [...(s.voteRoles[m.wallet] ?? []), vName]));
    verifiers.push({ label: verifierLabel(i + 1), name: vName, wallet: m.wallet });
  }
  await writeTexts(round.name, {
    [ROUND_KEYS.status]: picked.length === 0 ? "expired" : "picked",
    [ROUND_KEYS.seed]: seed,
    [ROUND_KEYS.picked]: verifiers.map((v) => v.label).join(","),
    [ROUND_KEYS.until]: String(until),
  });
  if (picked.length === 0) await writeTexts(versionN, { [VERSION_KEYS.access]: "closed" });
  return { seed, verifiers, until };
}

/** Counts the votes, revokes every verifier, and closes access. */
export async function closeRound(label: string, n: number, force = false) {
  const round = await readRound(label, n);
  if (round.status !== "picked") throw new MarketError(`Round ${n} is ${round.status}, not picked.`);
  const votes: { label: string; wallet: string; vote: string }[] = [];
  for (const v of round.picked) {
    const i = Number(v.slice(1));
    const t = await readTexts(verifierName(label, n, i), [ACCESS_KEYS.vote, ACCESS_KEYS.wallet]);
    votes.push({ label: v, wallet: t[ACCESS_KEYS.wallet], vote: t[ACCESS_KEYS.vote] });
  }
  const yes = votes.filter((v) => v.vote.startsWith("yes")).length;
  const no = votes.filter((v) => v.vote.startsWith("no")).length;
  const all = votes.every((v) => v.vote !== "");
  if (!force && !all && now() < round.until) throw new MarketError(`${votes.filter((v) => v.vote === "").length} verifiers have not voted. The vote window has ${round.until - now()} seconds left.`);
  const status: RoundStatus = yes + no === 0 ? "expired" : yes > no ? "accepted" : "rejected";

  const txs: Hex[] = [];
  for (const v of votes) {
    const i = Number(v.label.slice(1));
    txs.push(...(await revokeSubname(verifierName(label, n, i))));
    if (v.wallet) {
      txs.push(await revokeTextKey(v.wallet as Address, ACCESS_KEYS.vote));
      updateState((s) => (s.voteRoles[v.wallet] = (s.voteRoles[v.wallet] ?? []).filter((x) => x !== verifierName(label, n, i))));
    }
  }
  await writeTexts(round.name, { [ROUND_KEYS.status]: status });
  await writeTexts(versionName(label), { [VERSION_KEYS.access]: "closed" });
  return { status, yes, no, votes, txs };
}

/** A paid buyer gets a subname with the sealed file key. */
export async function buyVersion(label: string, input: { wallet: string; accessKey: string; signature: string; txHash: string }) {
  const { node } = await findVersion(await versionIdOf(label));
  const fileKey = readState().fileKeys[node.id];
  if (!fileKey) throw new MarketError("This version is not for sale: it was never submitted here.", 409);
  const wallet = await checkAccessKey(input.wallet, input.accessKey, input.signature);
  const payer = await checkPayment(input.txHash, PRICE_USDC);
  if (payer.toLowerCase() !== wallet.toLowerCase()) throw new MarketError("The payment came from another wallet.");
  const i = updateState((s) => (s.buyers[label] = (s.buyers[label] ?? 0) + 1));
  const name = buyerName(label, i);
  await registerSubname(name);
  const tx = await writeTexts(name, {
    [ACCESS_KEYS.wallet]: wallet,
    [ACCESS_KEYS.accessKey]: input.accessKey,
    [ACCESS_KEYS.key]: sealFileKey(fileKey, input.accessKey),
  });
  return { name, tx };
}

/** `v3` → the full version id, from the tree name's records. */
async function versionIdOf(label: string): Promise<string> {
  const tree = await loadTree();
  if (!tree.ok) throw new MarketError(tree.error, 500);
  const names = ensNames(tree.data.nodes);
  for (const [id, name] of names) if (name.split(".")[0] === label) return id;
  throw new MarketError(`No version ${label}.`, 404);
}
