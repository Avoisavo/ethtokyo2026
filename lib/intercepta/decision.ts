import type { Detector, InterceptaCall, MessageScan, QuickScan, Trait } from "./client";

/**
 * The payment decision. Pure: no network, no clock, no env. Unit tested in
 * decision.test.ts.
 *
 * Intercepta's address scans return a score and traits, not a verdict, so
 * `addressVerdict` and `messageVerdict` turn a raw call into a level first.
 * `decide` then combines every check: one failing check rejects, one held
 * check holds, and only a full set of passing checks pays.
 *
 * Petri fails closed. A timeout, a 403, an unexpected body or screening that
 * never ran is a hold, never a pay.
 */

export type Level = "clear" | "caution" | "block" | "unavailable" | "skipped";

export type AddressVerdict = { level: Level; score: number | null; traits: Trait[]; reasons: string[] };
export type MessageVerdict = {
  level: Level;
  riskGroup: string | null;
  messageType: string | null;
  detectors: Detector[];
  reasons: string[];
};

export type Thresholds = { blockScore: number; holdScore: number };
export const DEFAULT_THRESHOLDS: Thresholds = { blockScore: 80, holdScore: 30 };

/** Traits that stop a payment outright. Every other trait holds it. The names are Intercepta's enum. */
export const BLOCK_TRAITS = new Set([
  "known_scammer",
  "sanction_address",
  "blacklist",
  "attack_money_target",
  "fake_phishing_transfer",
  "rug_pull",
  "initiator_scam_transactions",
]);

/** Scan Message detectors that stop a payment outright. Any other detector holds it. */
export const BLOCK_DETECTORS = new Set([
  "KNOWN_MALICIOUS",
  "WALLET_DRAINER",
  "SCAM_ADDRESS",
  "MALICIOUS_ADDRESS",
  "BLOCKLIST_SITE",
  "POISONING_ATTACK",
  "INITIATOR_SCAM_TRANSACTIONS",
  "RUG_PULL_RELATED",
]);

export function addressVerdict(call: InterceptaCall<QuickScan> | null, t: Thresholds = DEFAULT_THRESHOLDS): AddressVerdict {
  if (call === null) return { level: "skipped", score: null, traits: [], reasons: ["Screening is off."] };
  if (!call.ok) {
    return { level: "unavailable", score: null, traits: [], reasons: [`Intercepta did not answer: ${call.error}`] };
  }
  const { toxicScore, traits } = call.body;
  const blocking = traits.filter((x) => BLOCK_TRAITS.has(x.name));
  const reasons = traits.map((x) => `${x.name}: ${x.description}`);
  if (blocking.length > 0 || toxicScore >= t.blockScore) {
    return { level: "block", score: toxicScore, traits, reasons: reasons.length ? reasons : [`toxic score ${toxicScore}`] };
  }
  if (traits.length > 0 || toxicScore >= t.holdScore) {
    return { level: "caution", score: toxicScore, traits, reasons: reasons.length ? reasons : [`toxic score ${toxicScore}`] };
  }
  return { level: "clear", score: toxicScore, traits, reasons: [] };
}

export function messageVerdict(call: InterceptaCall<MessageScan> | null): MessageVerdict {
  const none = { riskGroup: null, messageType: null, detectors: [] };
  if (call === null) return { ...none, level: "skipped", reasons: ["Scan Message is off."] };
  if (!call.ok) return { ...none, level: "unavailable", reasons: [`Intercepta did not answer: ${call.error}`] };

  const { riskGroup, messageType, detectors } = call.body;
  const flagged = (call.body.addresses ?? []).flatMap((a) => a.detectors.map((code) => ({ code, address: a.address })));
  const codes = [...detectors.map((d) => d.code), ...flagged.map((f) => f.code)];
  const reasons = [
    ...detectors.map((d) => `${d.code}: ${d.description}`),
    ...flagged.map((f) => `${f.code} on ${f.address}`),
  ];
  const base = { riskGroup, messageType: messageType ?? null, detectors };

  if (riskGroup === "High" || codes.some((c) => BLOCK_DETECTORS.has(c))) {
    return { ...base, level: "block", reasons: reasons.length ? reasons : ["riskGroup High"] };
  }
  if (riskGroup !== "Low" || codes.length > 0) {
    return { ...base, level: "caution", reasons: reasons.length ? reasons : [`riskGroup ${riskGroup}`] };
  }
  // A Low answer with no message type means Intercepta did not parse the authorization. Not a pass.
  if (!messageType) {
    return { ...base, level: "caution", reasons: ["Intercepta did not recognise the authorization (no message type)."] };
  }
  return { ...base, level: "clear", reasons: [] };
}

/* ------------------------------------------------------------------ checks */

export type CheckId = "limit" | "asset" | "validity" | "payto" | "authorization" | "message" | "payer" | "internal";
export type CheckStatus = "pass" | "hold" | "fail" | "skipped";
export type Check = { id: CheckId; label: string; source: "petri" | "intercepta"; status: CheckStatus; code: string; detail: string };

export type Action = "pay" | "hold" | "reject";
export type Decision = { action: Action; code: string; reasons: string[]; checks: Check[] };

const LABEL: Record<CheckId, string> = {
  limit: "Spending limit",
  asset: "Asset",
  validity: "Authorization lifetime",
  payto: "Intercepta Quick Scan on payTo",
  authorization: "Authorization matches the 402",
  message: "Intercepta Scan Message on the authorization",
  payer: "Intercepta Quick Scan on the payer",
  internal: "Petri agent",
};

const check = (id: CheckId, source: Check["source"], status: CheckStatus, code: string, detail: string): Check => ({
  id,
  label: LABEL[id],
  source,
  status,
  code,
  detail,
});

/** USDC has 6 decimals. */
export function formatUsdc(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const frac = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} USDC`;
}

export function limitCheck(amount: bigint, limit: bigint): Check {
  return amount <= limit
    ? check("limit", "petri", "pass", "within_limit", `${formatUsdc(amount)} is within the ${formatUsdc(limit)} limit.`)
    : check("limit", "petri", "fail", "over_limit", `${formatUsdc(amount)} is above the ${formatUsdc(limit)} limit.`);
}

export function assetCheck(ok: boolean, detail: string): Check {
  return ok ? check("asset", "petri", "pass", "asset_allowed", detail) : check("asset", "petri", "fail", "asset_not_allowed", detail);
}

/**
 * The signed authorization is a bearer instrument until `validBefore`, and the
 * verifier chooses maxTimeoutSeconds. Petri caps it with its own number.
 */
export function validityCheck(maxTimeoutSeconds: number, capSeconds: number): Check {
  return maxTimeoutSeconds <= capSeconds
    ? check("validity", "petri", "pass", "validity_ok", `Valid for ${maxTimeoutSeconds} s, within Petri's ${capSeconds} s cap.`)
    : check("validity", "petri", "fail", "validity_too_long", `The verifier asked for ${maxTimeoutSeconds} s. Petri signs for at most ${capSeconds} s.`);
}

export function payToCheck(v: AddressVerdict): Check {
  const top = v.traits.find((t) => BLOCK_TRAITS.has(t.name))?.name ?? v.traits[0]?.name ?? "score";
  switch (v.level) {
    case "clear":
      return check("payto", "intercepta", "pass", "payto_clear", `Toxic score ${v.score}, no risk traits.`);
    case "block":
      return check("payto", "intercepta", "fail", `intercepta_block:${top}`, v.reasons.join(" · "));
    case "caution":
      return check("payto", "intercepta", "hold", `intercepta_caution:${top}`, v.reasons.join(" · "));
    case "unavailable":
      return check("payto", "intercepta", "hold", "screening_unavailable", v.reasons.join(" · "));
    case "skipped":
      return check("payto", "petri", "hold", "screening_disabled", "Screening is off. Petri never pays an unscreened wallet.");
  }
}

export function authorizationCheck(problems: string[]): Check {
  return problems.length === 0
    ? check("authorization", "petri", "pass", "authorization_matches", "to, value, token, chain and lifetime match the 402.")
    : check("authorization", "petri", "fail", "authorization_mismatch", problems.join(" · "));
}

export function messageCheck(v: MessageVerdict): Check {
  const top = v.detectors[0]?.code ?? v.riskGroup ?? "unknown";
  switch (v.level) {
    case "clear":
      return check("message", "intercepta", "pass", "message_clear", `${v.messageType}, riskGroup ${v.riskGroup}, no detectors.`);
    case "block":
      return check("message", "intercepta", "fail", `intercepta_message_block:${top}`, v.reasons.join(" · "));
    case "caution":
      return check("message", "intercepta", "hold", `intercepta_message_caution:${top}`, v.reasons.join(" · "));
    case "unavailable":
      return check("message", "intercepta", "hold", "message_screening_unavailable", v.reasons.join(" · "));
    case "skipped":
      return check("message", "petri", "skipped", "message_scan_off", "Scan Message is turned off (INTERCEPTA_SCAN_MESSAGE=off).");
  }
}

/** The verifier's side: may it accept money from this payer? Screening explicitly turned off accepts. */
export function payerCheck(v: AddressVerdict): Check {
  const top = v.traits.find((t) => BLOCK_TRAITS.has(t.name))?.name ?? v.traits[0]?.name ?? "score";
  switch (v.level) {
    case "clear":
      return check("payer", "intercepta", "pass", "payer_clear", `Toxic score ${v.score}, no risk traits.`);
    case "block":
      return check("payer", "intercepta", "fail", `intercepta_block:${top}`, v.reasons.join(" · "));
    case "caution":
      return check("payer", "intercepta", "hold", `intercepta_caution:${top}`, v.reasons.join(" · "));
    case "unavailable":
      return check("payer", "intercepta", "hold", "screening_unavailable", v.reasons.join(" · "));
    case "skipped":
      return check("payer", "petri", "skipped", "payer_screen_off", "Payer screening is off (PETRI_VERIFIER_SCREEN_PAYER=off).");
  }
}

/** Anything no other check decided. x402's own spend cap rejects; every other surprise holds. */
export function internalCheck(detail: string, spendControl: boolean): Check {
  return spendControl
    ? check("internal", "petri", "fail", "x402_spend_controls", detail)
    : check("internal", "petri", "hold", "internal_error", detail);
}

/** Reject beats hold, and hold beats pay. The code is the first check that did not pass. */
export function decide(checks: Check[]): Decision {
  const failed = checks.find((c) => c.status === "fail");
  const held = checks.find((c) => c.status === "hold");
  const action: Action = failed ? "reject" : held ? "hold" : "pay";
  return {
    action,
    code: (failed ?? held)?.code ?? "all_checks_passed",
    reasons: checks.filter((c) => c.status === "fail" || c.status === "hold").map((c) => `${c.label}: ${c.detail}`),
    checks,
  };
}
