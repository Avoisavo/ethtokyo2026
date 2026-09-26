import type { InterceptaCall, MessageScan, QuickScan } from "../intercepta/client";
import type { Check, Decision } from "../intercepta/decision";

/**
 * Types shared by the payer, the verifier, the API and the /intercepta page.
 * Type-only, so client components may import them.
 */

/** The three verifiers on the demo page. Only `honest` ever accepts a payment. */
export type VerifierProfile = "honest" | "rogue" | "greedy";
export const PROFILES: VerifierProfile[] = ["honest", "rogue", "greedy"];

/** What the agent buys: a verification run, or a version's record as a markdown file. */
export type Product = "verification" | "markdown";

/** screened: the real flow. preview: the agent before this feature. It builds the authorization and never signs. */
export type PayMode = "screened" | "preview";

export type Requirements = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
};

/** What the verifier reports about its own screen of the payer, and the paid work. */
export type VerifierReply = {
  ok: boolean;
  code?: string;
  detail?: string;
  payerScreen?: { check: Check; call: InterceptaCall<QuickScan> | null };
  verification?: {
    report: string;
    runner: string;
    deltaMedianBp: number;
    status: string;
    statusCode: string;
    statusReason: string;
  };
  settlement?: { success: boolean; transaction: string; network: string; payer?: string; errorReason?: string };
  /** The markdown seller's file name. The file itself goes to PaymentRecord.delivered. */
  file?: string;
};

export type Outcome =
  /** The verifier was paid and the verification ran. */
  | "paid"
  /** Petri stopped before signing: a check held the payment. */
  | "held"
  /** Petri stopped before signing: a check rejected the payment. */
  | "rejected"
  /** Preview only: the authorization was built and not signed. */
  | "previewed"
  /** Signed, sent, verified, and the transfer was broadcast but is not confirmed yet. */
  | "pending"
  /** Signed and sent, and the verifier refused it (for example its payer screen). */
  | "refused"
  /** Something failed that no check decided. Nothing was signed unless `signed` says so. */
  | "error";

export type PaymentRecord = {
  kind: "petri/payment-check/1";
  id: string;
  at: number;
  mode: PayMode;
  /** Missing on records written before markdown existed: those are verification runs. */
  product?: Product;
  versionId: string;
  verifier: VerifierProfile;
  url: string;
  payer: string;
  requirements: Requirements | null;
  intercepta: (InterceptaCall<QuickScan> | InterceptaCall<MessageScan>)[];
  /** The EIP-712 authorization, bigints as strings. Present once the scheme built it. */
  typedData: Record<string, unknown> | null;
  decision: Decision | null;
  signed: boolean;
  sent: boolean;
  outcome: Outcome;
  verifierReply: (VerifierReply & { status: number }) | null;
  /** The bought markdown file, when the product was markdown and the seller delivered it. */
  delivered?: { file: string; bytes: number; markdown: string };
  /** From the verifier's PAYMENT-REQUIRED error when it refused a signed payment. */
  refusedReason?: string;
  error?: string;
  elapsedMs: number;
};
