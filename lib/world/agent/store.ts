import "server-only";

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Check } from "./oidc";

/**
 * Demo-grade state for the agent flow.
 *
 * Attempts live in memory (on globalThis so they survive dev-server HMR). The
 * device code never leaves this module's records. The agent's human owner, the
 * `(iss, sub)` pair bound on the first approval, is persisted to a JSON file in
 * the OS temp dir so it survives restarts, the same way lib/world/idkit does.
 */

export type AttemptStatus = "pending" | "approved" | "denied" | "expired" | "cancelled" | "rejected" | "error";

export type AgentTask = { id: string; label: string; detail: string };

export const TASK: AgentTask = {
  id: "send_usdc",
  label: "Send 25 USDC to merchant.eth",
  detail: "The agent found an invoice and wants to pay it on your behalf. Simulated transfer, no funds move.",
};

export type Attempt = {
  id: string;
  task: AgentTask;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  startedAt: number;
  /** World's device-code expiry. */
  expiresAt: number;
  /** Optional shorter deadline set by the agent, to demo an expired request. */
  deadline: number | null;
  interval: number;
  nextPollAt: number;
  inFlight: boolean;
  status: AttemptStatus;
  code?: string;
  detail?: string;
  checks?: Check[];
  subShort?: string;
  acr?: string;
  authTime?: number;
  executed?: { at: number; receipt: string };
};

export type Owner = { iss: string; sub: string; boundAt: number };

const g = globalThis as unknown as { __worldAgentAttempts?: Map<string, Attempt> };
const attempts = (g.__worldAgentAttempts ??= new Map<string, Attempt>());

export function newAttemptId(): string {
  return randomUUID();
}

export function saveAttempt(a: Attempt) {
  attempts.set(a.id, a);
}

export function getAttempt(id: string): Attempt | undefined {
  return attempts.get(id);
}

/** What the browser may see. No device code, no token. */
export function publicAttempt(a: Attempt) {
  return {
    id: a.id,
    task: a.task,
    userCode: a.userCode,
    verificationUri: a.verificationUri,
    verificationUriComplete: a.verificationUriComplete,
    startedAt: a.startedAt,
    expiresAt: a.deadline ?? a.expiresAt,
    status: a.status,
    code: a.code,
    detail: a.detail,
    checks: a.checks,
    subShort: a.subShort,
    acr: a.acr,
    authTime: a.authTime,
    executed: a.executed,
  };
}
export type PublicAttempt = ReturnType<typeof publicAttempt>;

const DIR = join(tmpdir(), "world-agent-demo");
const FILE = join(DIR, "owner.json");

export function getOwner(): Owner | null {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Owner;
  } catch {
    return null;
  }
}

export function setOwner(owner: Owner | null) {
  mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(owner), "utf8");
  renameSync(tmp, FILE);
}

export function shortSub(sub: string): string {
  return sub.length > 16 ? `${sub.slice(0, 8)}…${sub.slice(-6)}` : sub;
}
