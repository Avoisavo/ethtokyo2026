/**
 * The acceptance rule. See SPEC.md section 9.
 *
 * This is a pure function. It does no I/O. It reads no clock. It uses no
 * randomness. The same inputs give the same decision on every machine, forever.
 *
 * It imports only TYPES from src/consensus/messages.js, so replay can call it
 * with a plain object. Section 16.3 rule 2.
 */
import type { VerificationSigned } from '../consensus/messages.js';
import type { Policy } from '../config.js';
import type { DecisionCode, Mode, NodeStatus } from '../core/schema.js';

/** src/core/schema.ts is the bottom of the graph, so the code lives there. */
export type { DecisionCode } from '../core/schema.js';

/* ------------------------------------------------------------------ *
 * 9.1 Inputs
 * ------------------------------------------------------------------ */

export interface CountedVerification {
  /** The VERIFIER public key, taken from the envelope. NEVER from the body. */
  pub: string;
  msg: VerificationSigned;
  seq: number;
}

export interface NodeFacts {
  nodeId: string;
  /** The pub of the FIRST NodeSubmitted for this node. */
  author: string;
  bench: string;
  mode: Mode;
  parent: string;
  /** Keyed by verifier public key. The FIRST message from a key wins. */
  verifications: Map<string, CountedVerification>;
  withdrawn: boolean;   // Set only by a StatusChanged signed by `author`.
  superseded: boolean;  // Set only by a StatusChanged signed by `author`.
}

/* ------------------------------------------------------------------ *
 * 9.2 Output
 * ------------------------------------------------------------------ */

export interface Verdict {
  status: NodeStatus;
  code: DecisionCode;
  /** Plain English. Safe to print straight to a terminal. */
  reason: string;
  /** The agreed delta in basis points, or null when it could not be computed. */
  deltaBp: number | null;
  /** The public keys that counted. */
  counted: string[];
  /** Every verification that did not count, and why. */
  ignored: { pub: string; why: string }[];
}

/* ------------------------------------------------------------------ *
 * 9.3 The function
 * ------------------------------------------------------------------ */

const fmtBp = (bp: number): string => `${bp >= 0 ? '+' : ''}${bp}bp`;
const short = (k: string): string => k.slice(0, 8);

/**
 * The noun for the counted set.
 *
 * A local log proves nothing about who holds the keys. One person can hold every
 * key in it, so the verdict never calls two keys "independent". This mirrors the
 * trust banner of §8.9, which says the same thing.
 */
const NOUN = 'verifications from distinct keys';

/** The sentence that stops a verdict from reading as proof of independence. */
const CAVEAT = ' The ledger is a local log, so one person can hold every key. Distinct keys'
  + ' are not proof of distinct people.';

export function evaluate(node: NodeFacts, policy: Policy): Verdict {
  const none = { counted: [], ignored: [], deltaBp: null };
  if (node.withdrawn) {
    return { ...none, status: 'withdrawn', code: 'WITHDRAWN', reason: 'Withdrawn by the author.' };
  }
  if (node.superseded) {
    return { ...none, status: 'superseded', code: 'SUPERSEDED', reason: 'Superseded by the author.' };
  }

  // 1. Keep only the verifications that count.
  const counted: CountedVerification[] = [];
  const ignored: { pub: string; why: string }[] = [];

  for (const v of node.verifications.values()) {
    // Design rule 1. The author can never accept their own node.
    if (v.pub === node.author) {
      ignored.push({ pub: v.pub, why: 'self-verification: the signer is the node author' }); continue;
    }
    if (v.msg.node !== node.nodeId) {
      ignored.push({ pub: v.pub, why: 'the report is for another node' }); continue;
    }
    if (v.msg.parent !== node.parent) {
      ignored.push({ pub: v.pub, why: 'the verifier re-ran the wrong parent' }); continue;
    }
    if (v.msg.mode !== node.mode) {
      ignored.push({ pub: v.pub, why: `mode ${v.msg.mode} cannot support a ${node.mode} node` }); continue;
    }
    if (v.msg.runs < policy.minRuns) {
      ignored.push({ pub: v.pub, why: `only ${v.msg.runs} runs, the minimum is ${policy.minRuns}` }); continue;
    }
    if (v.msg.runs % 2 === 0) {
      ignored.push({ pub: v.pub, why: 'an even run count has no unique median' }); continue;
    }
    if (policy.trustedRunners.length > 0 && !policy.trustedRunners.includes(v.pub)) {
      ignored.push({ pub: v.pub, why: 'the runner is not on the trusted list for this tree' }); continue;
    }
    counted.push(v);
  }
  // Two verifications from ONE key already collapse: `verifications` is a Map keyed by
  // public key, and replay inserts only the first message from each key, by sequence.

  const keys = counted.map((v) => v.pub);

  // 2. A dirty batch disqualifies the node. Tampering is not a score.
  const dirty = counted.filter((v) => !v.msg.clean);
  if (dirty.length > 0) {
    return {
      status: 'rejected', code: 'NOT_CLEAN', deltaBp: null, counted: keys, ignored,
      reason: `${dirty.length} verification(s) reported an unclean batch. A tampered or `
        + `incomplete run cannot support a node. Runners: ${dirty.map((v) => short(v.pub)).join(', ')}.`,
    };
  }

  if (counted.length < policy.minVerifications) {
    return {
      status: 'pending', code: 'INSUFFICIENT_VERIFICATIONS', deltaBp: null, counted: keys, ignored,
      reason: `${counted.length} of ${policy.minVerifications} ${NOUN}. `
        + `The author's own runs never count.`,
    };
  }

  // 3. Refuse to judge a measurement that is too noisy to mean anything.
  for (const v of counted) {
    if (v.msg.spreadBp > policy.maxRunSpreadBp) {
      return {
        status: 'pending', code: 'RUNS_TOO_NOISY', deltaBp: null, counted: keys, ignored,
        reason: `Runner ${short(v.pub)} scored a spread of ${v.msg.spreadBp}bp over ${v.msg.runs} `
          + `runs, above the limit of ${policy.maxRunSpreadBp}bp. The median is not trustworthy. `
          + `Raise the run count and verify again.`,
      };
    }
  }

  // 4. Compare the verifiers with each other.
  const deltas = counted.map((v) => v.msg.deltaMedianBp);
  const lo = Math.min(...deltas);
  const hi = Math.max(...deltas);
  const span = hi - lo;

  const anyWin = hi >= policy.minDeltaBp;
  const anyLoss = lo <= -policy.minDeltaBp;

  if (anyWin && anyLoss) {
    return {
      status: 'contested', code: 'CONTESTED', deltaBp: null, counted: keys, ignored,
      reason: `The verifiers disagree on the sign. Deltas: `
        + `${counted.map((v) => `${short(v.pub)} ${fmtBp(v.msg.deltaMedianBp)}`).join(', ')}. `
        + `This node is neither accepted nor rejected. The disagreement is on the record.`,
    };
  }

  if (span > policy.maxRunnerDisagreementBp) {
    return {
      status: 'pending', code: 'RUNNERS_DISAGREE', deltaBp: null, counted: keys, ignored,
      reason: `The verifier deltas span ${span}bp (${deltas.join(', ')}), above the limit of `
        + `${policy.maxRunnerDisagreementBp}bp. One machine differs from the others. `
        + `A further independent verification is required.`,
    };
  }

  // 5. Decide. Every counted verifier must clear the margin on its own.
  //    The reported delta is the most conservative one.
  const isRoot = node.parent === 'root';

  if (lo >= policy.minDeltaBp) {
    return {
      status: 'accepted', code: isRoot ? 'ROOT_BASELINE' : 'WIN', deltaBp: lo, counted: keys, ignored,
      reason: isRoot
        ? `Root baseline set at ${fmtBp(lo)} over the empty harness, by ${counted.length} `
          + `distinct runner keys. Every runner cleared the ${policy.minDeltaBp}bp margin.${CAVEAT}`
        : `${counted.length} ${NOUN}, every one at or above `
          + `+${policy.minDeltaBp}bp. Worst delta ${fmtBp(lo)}. This is a real improvement.`
          + CAVEAT,
    };
  }

  if (hi <= -policy.minDeltaBp) {
    return {
      status: 'rejected', code: 'REGRESSION', deltaBp: hi, counted: keys, ignored,
      reason: `${counted.length} ${NOUN}, every one at or below `
        + `-${policy.minDeltaBp}bp. Best delta ${fmtBp(hi)}. This is a measured regression. `
        + `The change makes the harness worse.${CAVEAT}`,
    };
  }

  return {
    status: 'rejected', code: 'WITHIN_NOISE', deltaBp: lo, counted: keys, ignored,
    reason: `Deltas ${deltas.map(fmtBp).join(', ')} sit inside the ${policy.minDeltaBp}bp noise `
      + `band. That is a tie, not a regression. The change showed no measurable effect. `
      + `The node stays in the tree so nobody retries it.`,
  };
}
