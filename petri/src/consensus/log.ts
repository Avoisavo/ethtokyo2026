/**
 * The one consensus-log interface. SPEC.md section 8.1.
 *
 * The local file implements it. The rest of the codebase reads and writes the
 * log only through this interface.
 *
 * Inside one log, `seq` IS the total order. The local log assigns it under an
 * exclusive file lock.
 */

import type { PetriConfig } from '../config.js';
import type { Identity } from '../trust/identity.js';
import type { SignedEnvelope } from '../trust/envelope.js';
import type { PetriMessage } from './messages.js';
import { REPO_ROOT, lockPath, logPath } from '../store/paths.js';
import { LocalLog } from './local.js';

/**
 * One entry in the consensus log.
 *
 * Declared as a type alias, not an interface. A local log line IS the canonical
 * JSON of this object, so it must satisfy `Canon`, and TypeScript gives an
 * implicit index signature to an object type alias only.
 */
export type LogEntry = {
  chain: string;           // sha256 of the previous chain and this entry, as hex.
  consensusNanos: string;  // Decimal nanoseconds since the epoch. Exactly 19 digits.
  envelope: SignedEnvelope<PetriMessage>;
  seq: number;             // A per-log sequence number. 1-based. Gap-free.
};

export interface PublishReceipt {
  seq: number;
  /**
   * Always true. The only log is the local file.
   *
   * SPEC.md section 8.8: a local log proves authorship and integrity. It proves
   * NOTHING about time, non-deletion or independence. The CLI MUST print
   * `warning` whenever this flag is true. There is no flag to hide it.
   */
  unverified: boolean;
  /** The exact warning to print when `unverified` is true. */
  warning: string;
}

export interface ConsensusLog {
  publish(body: PetriMessage): Promise<PublishReceipt>;
  read(afterSeq?: number): AsyncIterable<LogEntry>;
  close(): Promise<void>;
}

/** Open the tree's log. This is the ONLY place a log is constructed. */
export function openLog(
  cfg: PetriConfig,
  identity: Identity,
  root: string = REPO_ROOT,
): ConsensusLog {
  // `root` is the `--root` flag of §14.2. Without it every repository on this
  // machine would append to the one hardcoded log, and a node created under one
  // root would appear in a different root's tree.
  return new LocalLog(cfg.treeId, identity, logPath(root), lockPath(root));
}
