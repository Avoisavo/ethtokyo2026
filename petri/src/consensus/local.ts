/**
 * The append-only log. SPEC.md sections 7.3, 8.6 and 8.8.
 *
 * It implements the `ConsensusLog` interface of src/consensus/log.ts, so no
 * other module ever touches the file directly.
 *
 * What it proves:   authorship (the signature is real) and integrity (the hash chain).
 * What it does NOT: time, non-deletion, or independence.
 *
 * Delete this file and history restarts. The `chain` field lets anyone holding an
 * earlier copy prove a line was removed, and `read` refuses to continue on a
 * break. A fresh reader with no earlier copy cannot tell. Every `publish`
 * therefore returns `unverified: true` and a warning the CLI must print.
 */

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  statSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { canonicalBytes, canonicalJson, sha256Hex, type Canon } from '../core/canonical.js';
import { openEnvelope, seal, type SignedEnvelope } from '../trust/envelope.js';
import type { Identity } from '../trust/identity.js';
import type { ConsensusLog, LogEntry, PublishReceipt } from './log.js';
import { PetriMessage } from './messages.js';

/**
 * This file declares NO log path, and it must never declare one.
 *
 * The log belongs to one tree root. `logPath(root)` and `lockPath(root)` in
 * src/store/paths.ts build both names, and the constructor below demands them.
 * A default absolute path would send every tree on the machine into one file:
 * `petri status` would then report another root's nodes as missing from this
 * machine, and a clone in any other directory would publish into a log it does
 * not own.
 */

/** The one-line warning every local publish carries. SPEC.md section 8.7. */
export const LOCAL_LEDGER_WARNING =
  'LOCAL LOG ONLY — this result proves nothing about independence. ' +
  'One person can hold every key in it, and the file can be edited or deleted.';

/** A stale lock is stolen after this long. A publish never holds it this long. */
const LOCK_STALE_MS = 30_000;
/** How long to wait for another process to release the lock. */
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 20;

/** The seed of the running hash chain. The chain makes a deletion detectable. */
const chainSeed = (treeId: string): string => sha256Hex(`petri/chain/1|${treeId}`);

const nextChain = (prevChain: string, seq: number, consensusNanos: string, envelope: Canon): string =>
  sha256Hex(Buffer.concat([
    Buffer.from(prevChain, 'hex'),
    canonicalBytes({ consensusNanos, envelope, seq }),
  ]));

export { chainSeed, nextChain };

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** An exclusive lock over one file, built from `open(..., 'wx')`. */
async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | null = null;

  for (;;) {
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Steal a lock a crashed process left behind.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch { /* the holder released it between our two calls. Retry. */ }
      if (Date.now() > deadline) {
        throw new Error(
          `petri: could not take the log lock at ${lockPath} within ` +
          `${LOCK_TIMEOUT_MS}ms. Another petri process is writing the log.`,
        );
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

/** A line read back off disk, before any check has run. */
type RawEntry = {
  chain: string;
  consensusNanos: string;
  envelope: SignedEnvelope<Canon>;
  seq: number;
};

const HEX64 = /^[0-9a-f]{64}$/;
const NANOS = /^\d{19}$/;

function parseLine(label: string, lineNumber: number, line: string): RawEntry {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`petri: ${label} line ${lineNumber} is not JSON. The log was edited.`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`petri: ${label} line ${lineNumber} is not a log entry. The log was edited.`);
  }
  const e = value as Record<string, unknown>;
  function bad(what: string): never {
    throw new Error(`petri: ${label} line ${lineNumber} has ${what}. The log was edited.`);
  }
  const chain = e['chain'];
  const consensusNanos = e['consensusNanos'];
  const seq = e['seq'];
  const envelope = e['envelope'];

  if (typeof chain !== 'string' || !HEX64.test(chain)) bad('no usable chain hash');
  if (typeof consensusNanos !== 'string' || !NANOS.test(consensusNanos)) bad('a malformed consensusNanos');
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) bad('a malformed sequence number');
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) bad('no envelope');

  return {
    chain,
    consensusNanos,
    envelope: envelope as SignedEnvelope<Canon>,
    seq,
  };
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

export class LocalLog implements ConsensusLog {
  private readonly treeId: string;
  private readonly identity: Identity;
  private readonly path: string;
  private readonly lockPath: string;
  private readonly label: string;

  /**
   * `path` and `lockPath` are REQUIRED. Both derive from the tree root, so one
   * machine can hold many trees and no tree ever writes into another's log.
   */
  constructor(treeId: string, identity: Identity, path: string, lockPath: string) {
    this.treeId = treeId;
    this.identity = identity;
    this.path = path;
    this.lockPath = lockPath;
    // Every message names the file in full. Two trees on one machine both hold a
    // `.petri/log.jsonl`, so a short label would say nothing about which broke.
    this.label = path;
  }

  /**
   * Append one canonical JSON line under an exclusive lock, then fsync.
   * `consensusNanos` is forced to increase, even when the wall clock moves back.
   */
  async publish(body: PetriMessage): Promise<PublishReceipt> {
    const parsed = PetriMessage.safeParse(body);
    if (!parsed.success) {
      throw new Error(`petri: refusing to publish a malformed message: ${parsed.error.message}`);
    }
    const envelope = seal('msg', parsed.data, this.identity);

    return withLock(this.lockPath, async () => {
      const tail = this.readTail();
      const seq = tail.seq + 1;
      const consensusNanos = this.nextNanos(tail.nanos);
      const chain = nextChain(tail.chain, seq, consensusNanos, envelope);
      const entry: LogEntry = { chain, consensusNanos, envelope, seq };
      this.append(canonicalJson(entry));
      return {
        seq,
        unverified: true,
        warning: LOCAL_LEDGER_WARNING,
      };
    });
  }

  /**
   * Stream the log in sequence order. Three checks run on EVERY entry, and any
   * failure throws:
   *   1. `seq` increases by exactly 1. A gap means lines were removed.
   *   2. `chain` reproduces. A mismatch means the file was edited.
   *   3. The envelope signature verifies.
   *
   * `afterSeq` filters what is yielded. Every earlier line is still checked,
   * because the hash chain can only be rebuilt from the seed forward.
   */
  read(afterSeq = 0): AsyncIterable<LogEntry> {
    const { path, label, treeId } = this;
    async function* generate(): AsyncGenerator<LogEntry> {
      const lines = readLines(path);
      let prevChain = chainSeed(treeId);
      let expected = 1;

      for (let i = 0; i < lines.length; i++) {
        const raw = parseLine(label, i + 1, lines[i]!);

        if (raw.seq !== expected) {
          throw new Error(
            `petri: ${label} jumps from sequence ${expected - 1} to ${raw.seq}. Lines were removed.`,
          );
        }
        const want = nextChain(prevChain, raw.seq, raw.consensusNanos, raw.envelope);
        if (want !== raw.chain) {
          throw new Error(`petri: ${label} hash chain breaks at sequence ${raw.seq}. The log was edited.`);
        }
        const opened = openEnvelope<Canon>('msg', raw.envelope);
        if (!opened.ok) {
          throw new Error(`petri: ${label} sequence ${raw.seq} has a bad signature.`);
        }
        const msg = PetriMessage.safeParse(opened.body);
        if (!msg.success) {
          throw new Error(
            `petri: ${label} sequence ${raw.seq} carries a message Petri does not recognise.`,
          );
        }

        prevChain = raw.chain;
        expected = raw.seq + 1;

        if (raw.seq <= afterSeq) continue;
        yield {
          chain: raw.chain,
          consensusNanos: raw.consensusNanos,
          envelope: { body: msg.data, pub: opened.pub, sig: raw.envelope.sig, ver: 1 },
          seq: raw.seq,
        };
      }
    }
    return generate();
  }

  async close(): Promise<void> {
    // Nothing to release. The lock is taken and dropped inside publish.
  }

  /** The sequence, chain and timestamp of the last line, or the empty-log start state. */
  private readTail(): { seq: number; chain: string; nanos: bigint | null } {
    const lines = readLines(this.path);
    const last = lines[lines.length - 1];
    if (last === undefined) return { seq: 0, chain: chainSeed(this.treeId), nanos: null };
    const raw = parseLine(this.label, lines.length, last);
    return { seq: raw.seq, chain: raw.chain, nanos: BigInt(raw.consensusNanos) };
  }

  /** Monotonic. A clock that moves backwards can never reorder the log. */
  private nextNanos(last: bigint | null): string {
    const wall = BigInt(Date.now()) * 1_000_000n;
    const next = last === null ? wall : (wall > last ? wall : last + 1n);
    return next.toString().padStart(19, '0');
  }

  private append(line: string): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, 'a', 0o644);
    try {
      writeSync(fd, `${line}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
