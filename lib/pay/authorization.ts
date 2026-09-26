import type { TypedDataLike } from "../intercepta/client";
import { SEPOLIA, sameAddress } from "./network";

/**
 * Checks the EIP-3009 authorization the x402 scheme built against the 402 it
 * answers, before anything is signed. Pure. An empty list means it matches.
 *
 * The scheme builds the message from the verifier's own requirements, so a
 * mismatch means a bug or a tampered scheme. The lifetime check matters more:
 * it compares validBefore with Petri's cap, not with the verifier's number.
 */
export function authorizationProblems(
  td: TypedDataLike,
  req: { asset: string; payTo: string; amount: string },
  payer: string,
  nowSeconds: number,
  maxValiditySeconds: number,
): string[] {
  const problems: string[] = [];
  const m = td.message as Record<string, unknown>;
  const big = (v: unknown): bigint | null => {
    try {
      return typeof v === "bigint" ? v : BigInt(String(v));
    } catch {
      return null;
    }
  };

  if (td.primaryType !== "TransferWithAuthorization") problems.push(`primaryType is ${td.primaryType}, not TransferWithAuthorization`);
  if (!sameAddress(String(td.domain.verifyingContract), req.asset)) problems.push("the token is not the asset in the 402");
  if (Number(td.domain.chainId) !== SEPOLIA.chainId) problems.push(`chainId ${String(td.domain.chainId)} is not Sepolia`);
  if (!sameAddress(String(m.from), payer)) problems.push("from is not Petri's wallet");
  if (!sameAddress(String(m.to), req.payTo)) problems.push("to is not the payTo in the 402");
  if (big(m.value) !== big(req.amount)) problems.push(`value ${String(m.value)} is not the price ${req.amount}`);

  const validBefore = big(m.validBefore);
  // 30 s of clock skew between this machine and the chain.
  if (validBefore === null || validBefore > BigInt(nowSeconds + maxValiditySeconds + 30)) {
    problems.push(`validBefore is more than ${maxValiditySeconds} s away`);
  }
  return problems;
}

/** JSON-safe copy of typed data for the record and the page: bigints become strings. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
