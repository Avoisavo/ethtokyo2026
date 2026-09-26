import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { PETRI_ROOT } from "../tree";
import type { PaymentRecord } from "./types";

/**
 * Every payment attempt, including the blocked and held ones, is one line in
 * petri/.petri/payments.jsonl, beside log.jsonl and world-checks.jsonl. The
 * page, the README and a judge read the same record the agent wrote.
 *
 * Reset with the rest of the demo state: git clean -fd petri/.petri
 */
export const PAYMENTS_PATH = path.join(PETRI_ROOT, ".petri", "payments.jsonl");

export function appendPaymentRecord(r: PaymentRecord): void {
  try {
    mkdirSync(path.dirname(PAYMENTS_PATH), { recursive: true });
    appendFileSync(PAYMENTS_PATH, `${JSON.stringify(r)}\n`, "utf8");
  } catch {
    // A read-only deploy cannot write. The API response still carries the record.
  }
}

/** The newest records first. */
export function readPaymentRecords(limit = 20): PaymentRecord[] {
  if (!existsSync(PAYMENTS_PATH)) return [];
  try {
    return readFileSync(PAYMENTS_PATH, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .reverse()
      .flatMap((line) => {
        try {
          const r = JSON.parse(line) as PaymentRecord;
          return r.kind === "petri/payment-check/1" ? [r] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
