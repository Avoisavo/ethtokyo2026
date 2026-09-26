/**
 * The harness market: submit, round, join, pick, vote, close and buy.
 * Server only. Every public fact goes to ENS. Every secret stays in the store.
 *
 * Submit     the docs are encrypted and written to the version name, and the
 *            round opens. Free for a World ID human under a rate limit, or
 *            for a USDC stake.
 * Round      `round.<version>`, under a pending version only. Open for
 *            ROUND_SECONDS. Anyone with a wallet joins the pool. A fresh
 *            World ID for Agents approval gives weight 3, else 1.
 * Pick       when the join window closes, up to ROUND_SIZE members are picked
 *            at random by weight. Each gets `verifier<i>.round.<version>`,
 *            owned by their wallet, expiring, with the file key sealed to their
 *            access key, and the right to write one text key: petri.vote.
 * Close      the votes are counted. The verifier names are burned. The version
 *            moves from `pending` to `accepted` or `rejected`, with the
 *            verifiers' wallets in its records.
 * Buy        a USDC payment gives `buyer<i>.<version>`, owned by the buyer,
 *            for BUYER_DAYS, with the sealed key. Accepted versions only.
 */

import { type Address, type Hex, createPublicClient, decodeEventLog, erc20Abi, http, keccak256, stringToHex, verifyMessage } from "viem";
import { sepolia } from "viem/chains";

import { addresses } from "@/app/ens/_lib/ens/contracts";
import { RECORD_KEYS } from "@/lib/ens/records";
import { SEPOLIA_RPC_URL } from "@/lib/ens/resolve";
import { REAL_TREE, ensNames, moveName } from "@/lib/ens/name";
import { loadTree } from "@/lib/tree";

import { grantTextKey, loadDeployment, readTexts, registerSubname, revokeSubname, revokeTextKey, stateOf, writeTexts } from "./chain";
import { docsHash, encryptText, newFileKey, sealFileKey } from "./crypto";
import { versionDocs } from "./docs";
import {
  ACCESS_KEYS, BUYER_DAYS, FREE_SUBMITS_PER_DAY, PRICE_USDC, ROUND_KEYS, ROUND_SECONDS, ROUND_SIZE, STAKE_USDC,
  VERSION_KEYS, VOTE_SECONDS, WEIGHT_WITHOUT, WEIGHT_WITH_WORLD_ID, type RoundMember, type RoundStatus, buyerName, docKey,
  pickVerifiers, roundName, verifierLabel, verifierName,
} from "./records";
import { readState, updateState } from "./store";

export class MarketError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** A World ID approval older than this does not count as fresh. */
const FRESH_SECONDS = 15 * 60;
const now = () => Math.floor(Date.now() / 1000);

/** The message a wallet signs to prove an access key is theirs. */
export const accessMessage = (accessKey: string): string => `Petri access key ${accessKey.toLowerCase()}`;

/** A version of the real tree by id or short id, with its current ENS name. */
export async function findVersion(id: string) {
  const tree = await loadTree();
  if (!tree.ok) throw new MarketError(`The tree did not load: ${tree.error}`, 500);
  const node = tree.data.nodes.find((n) => n.id === id || n.id.startsWith(id));
  if (!node) throw new MarketError(`No version ${id}.`, 404);
  const name = ensNames(tree.data.nodes, REAL_TREE).get(node.id)!;
  return { node, nodes: tree.data.nodes, name, folder: name.split(".")[1] as "accepted" | "rejected" | "pending" };
}

async function checkAccessKey(wallet: string, accessKey: string, signature: string): Promise<Address> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new MarketError("The wallet is not an address.");
  if (!/^0x0[23][0-9a-fA-F]{64}$/.test(accessKey)) throw new MarketError("The access key must be a compressed public key: 0x02 or 0x03 and 64 hex.");
  const ok = await verifyMessage({ address: wallet as Address, message: accessMessage(accessKey), signature: signature as Hex }).catch(() => false);
  if (!ok) throw new MarketError("The signature does not match the wallet and the access key.");
  return wallet as Address;
}

/** Checks a USDC transfer to the platform wallet of at least `usdc`, used once. Returns the sender. */
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
        const fresh = updateState((s) => {
          if (s.usedPayments.includes(txHash.toLowerCase())) return false;
          s.usedPayments.push(txHash.toLowerCase());
          return true;
        });
        if (!fresh) throw new MarketError("This payment was already used.");
        return ev.args.from;
      }
    } catch (e) {
      if (e instanceof MarketError) throw e;
      /* not a Transfer */
    }
  }
  throw new MarketError(`The transaction does not pay ${usdc} USDC to ${dep.owner}.`);
}

/**
 * Encrypts a version's documents with its file key and writes them to its
 * name, once. Returns the file key. A later call only checks the records.
 */
async function ensureDocs(node: { id: string; hypothesis: string }, name: string, extra: Record<string, string> = {}): Promise<string> {
  const fileKey = readState().fileKeys[node.id] ?? newFileKey();
  updateState((s) => (s.fileKeys[node.id] = fileKey));
  const have = await readTexts(name, [VERSION_KEYS.docHash]);
  const docs = versionDocs(node.id, node.hypothesis);
  const hash = docsHash(docs);
  const records: Record<string, string> = { ...extra };
  if (have[VERSION_KEYS.docHash] !== hash) {
    records[VERSION_KEYS.docList] = Object.keys(docs).join(",");
    records[VERSION_KEYS.docHash] = hash;
    records[VERSION_KEYS.price] = String(PRICE_USDC);
    for (const [file, text] of Object.entries(docs)) records[docKey(file)] = encryptText(fileKey, text);
  }
  if (Object.keys(records).length > 0) await writeTexts(name, records);
  return fileKey;
}

export type SubmitMode = { kind: "free"; nullifier: string } | { kind: "stake"; txHash: string };

/** Encrypts the version's docs, writes them to its name, and opens the round. Pending versions only. */
export async function submitVersion(id: string, mode: SubmitMode) {
  const { node, name, folder } = await findVersion(id);
  if (folder !== "pending") throw new MarketError(`${name.split(".")[0]} is already ${folder}. Only a pending version can be submitted.`, 409);
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
    submitter = await checkPayment(mode.txHash, STAKE_USDC);
    submit = `stake:USDC:${STAKE_USDC}`;
  }

  // The file key stays on the server: ensureDocs returns it, and it is never sent back.
  await ensureDocs(node, name, { [VERSION_KEYS.submit]: submit, [VERSION_KEYS.submitter]: submitter });
  const round = await openRound(name);
  return { id: node.id, name, submit, round };
}

/** Opens the round of a pending version. It expires ROUND_SECONDS from now. */
export async function openRound(version: string) {
  const name = roundName(version);
  const until = now() + ROUND_SECONDS;
  const { exists } = await stateOf(name);
  if (exists) {
    const t = await readTexts(name, [ROUND_KEYS.status]);
    if (t[ROUND_KEYS.status] === "open" || t[ROUND_KEYS.status] === "picked") throw new MarketError("The round is already running.", 409);
    // An expired round: burn it, then open again.
    await revokeSubname(name);
  }
  await registerSubname(name, BigInt(until + VOTE_SECONDS));
  await writeTexts(name, {
    [ROUND_KEYS.status]: "open",
    [ROUND_KEYS.until]: String(until),
    [ROUND_KEYS.size]: String(ROUND_SIZE),
    [ROUND_KEYS.pool]: "[]",
    [ROUND_KEYS.seed]: "",
    [ROUND_KEYS.picked]: "",
  });
  return { name, until };
}

export async function readRound(version: string) {
  const name = roundName(version);
  const t = await readTexts(name, Object.values(ROUND_KEYS));
  if (t[ROUND_KEYS.status] === "") throw new MarketError(`No round under ${version}.`, 404);
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

/**
 * Adds a wallet to the pool. `attemptId` is a World ID for Agents attempt that
 * a human approved in the last FRESH_SECONDS. It raises the weight. Each
 * approval joins once.
 */
export async function joinRound(id: string, input: { wallet: string; accessKey: string; signature: string; attemptId?: string }) {
  const { name: version } = await findVersion(id);
  const round = await readRound(version);
  if (round.status !== "open") throw new MarketError(`The round is ${round.status}, not open.`);
  if (now() >= round.until) throw new MarketError("The join window has closed. The round waits for the pick.");
  const wallet = await checkAccessKey(input.wallet, input.accessKey, input.signature);
  if (round.pool.some((m) => m.wallet.toLowerCase() === wallet.toLowerCase())) throw new MarketError("This wallet is already in the pool.");

  let human: RoundMember["human"] = "none";
  if (input.attemptId) {
    // The agent store is server-only, so the terminal scripts never load it.
    const { getAttempt } = await import("@/lib/world/agent/store");
    const a = getAttempt(input.attemptId);
    if (!a || a.status !== "approved") throw new MarketError("The World ID approval is missing, or it did not succeed. Join without it, with weight 1.");
    if ((a.authTime ?? 0) < now() - FRESH_SECONDS) throw new MarketError("The World ID approval is not fresh. Ask again.");
    const fresh = updateState((s) => {
      if (s.usedApprovals.includes(input.attemptId!)) return false;
      s.usedApprovals.push(input.attemptId!);
      return true;
    });
    if (!fresh) throw new MarketError("This approval was already used to join.");
    human = "world";
  }
  const member: RoundMember = { wallet, accessKey: input.accessKey, human, weight: human === "world" ? WEIGHT_WITH_WORLD_ID : WEIGHT_WITHOUT, joinedAt: now() };
  const pool = [...round.pool, member];
  const tx = await writeTexts(round.name, { [ROUND_KEYS.pool]: JSON.stringify(pool) });
  return { member, pool, tx };
}

/** Picks the verifiers once the join window is over. */
export async function pickRound(id: string, force = false) {
  const { node, name: version } = await findVersion(id);
  const round = await readRound(version);
  if (round.status !== "open") throw new MarketError(`The round is ${round.status}.`);
  if (!force && now() < round.until) throw new MarketError(`The join window is open for ${round.until - now()} more seconds.`);
  const fileKey = readState().fileKeys[node.id];
  if (!fileKey) throw new MarketError("This version was never submitted here, so there is no file key.", 409);

  // The seed is public and replayable: the round name, its close time, the pool, and the latest block.
  const client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) });
  const block = await client.getBlock();
  const seed = keccak256(stringToHex(`${round.name}|${round.until}|${JSON.stringify(round.pool)}|${block.hash}`));
  const picked = pickVerifiers(round.pool, round.size, seed);
  const until = now() + VOTE_SECONDS;
  const verifiers: { label: string; name: string; wallet: string }[] = [];
  for (const [i, m] of picked.entries()) {
    const vName = verifierName(version, i + 1);
    await registerSubname(vName, BigInt(until), m.wallet as Address);
    await writeTexts(vName, {
      [ACCESS_KEYS.wallet]: m.wallet,
      [ACCESS_KEYS.accessKey]: m.accessKey,
      [ACCESS_KEYS.key]: sealFileKey(fileKey, m.accessKey),
      [ACCESS_KEYS.human]: m.human,
      [ACCESS_KEYS.vote]: "",
    });
    await grantTextKey(m.wallet as Address, ACCESS_KEYS.vote);
    verifiers.push({ label: verifierLabel(i + 1), name: vName, wallet: m.wallet });
  }
  await writeTexts(round.name, {
    [ROUND_KEYS.status]: picked.length === 0 ? "expired" : "picked",
    [ROUND_KEYS.seed]: seed,
    [ROUND_KEYS.picked]: verifiers.map((v) => v.label).join(","),
    [ROUND_KEYS.until]: String(until),
  });
  return { seed, verifiers, until, block: block.number };
}

/**
 * Counts the votes, burns every verifier name, and moves the version to
 * `accepted` or `rejected`. With no votes, the round expires and the version
 * stays pending.
 */
export async function closeRound(id: string, force = false) {
  const { node, nodes, name: version } = await findVersion(id);
  const round = await readRound(version);
  if (round.status !== "picked") throw new MarketError(`The round is ${round.status}, not picked.`);
  const votes: { label: string; wallet: string; vote: string }[] = [];
  for (const v of round.picked) {
    const i = Number(v.replace("verifier", ""));
    const t = await readTexts(verifierName(version, i), [ACCESS_KEYS.vote, ACCESS_KEYS.wallet]);
    votes.push({ label: v, wallet: t[ACCESS_KEYS.wallet], vote: t[ACCESS_KEYS.vote] });
  }
  const yes = votes.filter((v) => v.vote.startsWith("yes"));
  const no = votes.filter((v) => v.vote.startsWith("no"));
  const all = votes.every((v) => v.vote !== "");
  if (!force && !all && now() < round.until) throw new MarketError(`${votes.filter((v) => v.vote === "").length} verifiers have not voted. The vote window has ${round.until - now()} seconds left.`);
  const status: RoundStatus = yes.length + no.length === 0 ? "expired" : yes.length > no.length ? "accepted" : "rejected";

  const txs: Hex[] = [];
  for (const v of votes) {
    const i = Number(v.label.replace("verifier", ""));
    txs.push(...(await revokeSubname(verifierName(version, i))));
    if (v.wallet) txs.push(await revokeTextKey(v.wallet as Address, ACCESS_KEYS.vote));
  }
  await writeTexts(round.name, { [ROUND_KEYS.status]: status });
  if (status === "expired") return { status, yes: yes.length, no: no.length, votes, txs, moved: null };

  // Move the version: the same records under the new folder, with the verifiers' wallets.
  const { nodeRecords } = await import("@/lib/ens/records");
  const records: Record<string, string> = {
    ...nodeRecords(node, nodes, 20, 2),
    [RECORD_KEYS.status]: status,
    [RECORD_KEYS.verifier1]: (yes.length > no.length ? yes : no)[0]?.wallet ?? "",
    [RECORD_KEYS.verifier2]: (yes.length > no.length ? yes : no)[1]?.wallet ?? "",
  };
  const moved = moveName(version, status);
  await registerSubname(moved);
  await writeTexts(moved, records);
  txs.push(...(await revokeSubname(round.name)));
  txs.push(...(await revokeSubname(version)));
  updateState((s) => (s.moved[node.id] = status));
  return { status, yes: yes.length, no: no.length, votes, txs, moved };
}

/** A paid buyer gets a subname, owned by their wallet, with the sealed file key. Accepted versions only. */
export async function buyVersion(id: string, input: { wallet: string; accessKey: string; signature: string; txHash: string }) {
  const { node, name: version, folder } = await findVersion(id);
  if (folder !== "accepted" && readState().moved[node.id] !== "accepted") throw new MarketError("Only an accepted version can be bought.", 409);
  const wallet = await checkAccessKey(input.wallet, input.accessKey, input.signature);
  const payer = await checkPayment(input.txHash, PRICE_USDC);
  if (payer.toLowerCase() !== wallet.toLowerCase()) throw new MarketError("The payment came from another wallet.");
  // The first buyer of a version makes the platform publish its encrypted files.
  const fileKey = await ensureDocs(node, moveName(version, "accepted"));
  const i = updateState((s) => (s.buyers[node.id] = (s.buyers[node.id] ?? 0) + 1));
  const name = buyerName(moveName(version, "accepted"), i);
  await registerSubname(name, BigInt(now() + BUYER_DAYS * 86400), wallet);
  const tx = await writeTexts(name, {
    [ACCESS_KEYS.wallet]: wallet,
    [ACCESS_KEYS.accessKey]: input.accessKey,
    [ACCESS_KEYS.key]: sealFileKey(fileKey, input.accessKey),
  });
  return { name, version: moveName(version, "accepted"), tx };
}
