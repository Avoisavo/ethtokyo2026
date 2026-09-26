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
  /** Version id → the number of buyers so far. */
  buyers: Record<string, number>;
  /** Payment tx hashes that were used once. */
  usedPayments: string[];
  /** World ID approval attempt ids that joined a round. */
  usedApprovals: string[];
  /** Version id → the folder the market moved it to, before the log catches up. */
  moved: Record<string, "accepted" | "rejected">;
  /** Versions proposed from the page, with a demo CLI run. They are on ENS, not in the engine log. */
  proposals: {
    id: string; label: string; parent: string; name: string; at: number;
    change?: string; perf?: number; tokens?: number; speed?: number; diff?: string;
    /** Removed from the tree by its author. The ENS name stays. */
    hidden?: boolean;
    /** `free` (a real World ID proof), `free:demo`, or `stake:USDC:5`. */
    submit?: string;
  }[];
}

const FILE = path.join(process.cwd(), ".market", "state.json");
const EMPTY: MarketState = { fileKeys: {}, freeSubmits: {}, buyers: {}, usedPayments: [], usedApprovals: [], moved: {}, proposals: [] };

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
