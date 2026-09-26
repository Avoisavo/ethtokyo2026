/**
 * What the platform keeps off chain: the file key of each version, the free
 * submits per human, and the access secrets nobody else may see. A JSON file
 * under .market/, which git ignores. Server only.
 *
 * Everything public is on ENS. This file holds only the secrets and counters.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface MarketState {
  /** Version id → the plain file key. */
  fileKeys: Record<string, string>;
  /** World ID nullifier → unix times of its free submits. */
  freeSubmits: Record<string, number[]>;
  /** Version label (`v3`) → the number of rounds opened so far. */
  rounds: Record<string, number>;
  /** Version label → the number of buyers so far. */
  buyers: Record<string, number>;
  /** Wallet → the verifier names it holds a vote role for. */
  voteRoles: Record<string, string[]>;
}

const FILE = path.join(process.cwd(), ".market", "state.json");
const EMPTY: MarketState = { fileKeys: {}, freeSubmits: {}, rounds: {}, buyers: {}, voteRoles: {} };

export function readState(): MarketState {
  if (!existsSync(FILE)) return structuredClone(EMPTY);
  return { ...structuredClone(EMPTY), ...(JSON.parse(readFileSync(FILE, "utf8")) as Partial<MarketState>) };
}

export function writeState(state: MarketState): void {
  mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, FILE);
}

/** Reads, changes and writes in one step. */
export function updateState<T>(fn: (s: MarketState) => T): T {
  const s = readState();
  const out = fn(s);
  writeState(s);
  return out;
}
