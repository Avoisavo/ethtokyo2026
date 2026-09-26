import "server-only";

import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPRequestContext,
} from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme as ExactEvmFacilitator } from "@x402/evm/exact/facilitator";
import { ExactEvmScheme as ExactEvmServer } from "@x402/evm/exact/server";
import type { NextRequest } from "next/server";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { quickScanAddress, type InterceptaCall, type QuickScan } from "../intercepta/client";
import { getInterceptaConfig } from "../intercepta/config";
import { addressVerdict, payerCheck, type Check } from "../intercepta/decision";
import { paymentKeyOf } from "./authorization";
import type { VerifierConfig } from "./config";
import { SEPOLIA } from "./network";
import type { Product, VerifierProfile } from "./types";

/**
 * The seller's side of x402. It sells two things for USDC:
 *
 *   POST /api/verifier/verify/:versionId   a `petri verify` run by the verifier's key
 *   GET  /api/versions/:versionId/markdown  a version's record as a markdown file
 *
 * Both share one x402 server, one payer screen and one set of spent authorizations.
 *
 * The facilitator runs in this process. x402.org serves only Base Sepolia,
 * and settling here means no third party touches the money. The relayer key
 * pays the gas for transferWithAuthorization.
 *
 * Everything is built lazily on the first request, never at import:
 * `next build` evaluates route modules, and a missing key must become a 503,
 * not a failed build.
 */

export const ROUTE = "POST /api/verifier/verify/[versionId]";
export const MARKDOWN_ROUTE = "GET /api/versions/[versionId]/markdown";

/** The query parameter that names the demo seller on each route. The route handlers read the same one. */
export const PROFILE_PARAM: Record<Product, string> = { verification: "verifier", markdown: "seller" };

export type PayerScreen = { check: Check; call: InterceptaCall<QuickScan> | null };

type Server = {
  http: x402HTTPResourceServer;
  ready: Promise<void>;
  /** The verifier's screen of each payer, by paymentKey. The hook's own message never reaches the payer. */
  payerScreens: Map<string, PayerScreen>;
  /** Authorizations in flight and spent, by paymentKey. */
  pendingNonces: Set<string>;
  usedNonces: Set<string>;
  /** Versions with a paid run in flight: two runs of one version by one key cannot both count. */
  busyVersions: Set<string>;
};

const g = globalThis as unknown as { __petriVerifier?: { key: string; module: object; server: Server } };

/**
 * A new object each time this module is evaluated. The server is cached on
 * globalThis to survive dev hot reloads, but a server built by an older copy
 * of this code has older hooks and fields, so it is never reused.
 */
const MODULE = {};

export function profileOf(value: string | string[] | null | undefined): VerifierProfile {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "rogue" || v === "greedy" ? v : "honest";
}

/** Where each profile is paid, and how much. Only `honest` accepts money (see the routes). */
export function offer(cfg: VerifierConfig, profile: VerifierProfile, product: Product = "verification") {
  const fee = product === "markdown" ? cfg.markdownFeeAtomic : cfg.feeAtomic;
  if (profile === "rogue") return { payTo: cfg.rogue.payTo, amountAtomic: fee };
  if (profile === "greedy") return { payTo: cfg.payTo, amountAtomic: cfg.greedy.feeAtomic };
  return { payTo: cfg.payTo, amountAtomic: fee };
}

export function getVerifierServer(cfg: VerifierConfig): Server {
  const key = JSON.stringify([cfg.relayerAddress, cfg.payTo, cfg.feeAtomic.toString(), cfg.markdownFeeAtomic.toString(), cfg.rogue.payTo, cfg.greedy.feeAtomic.toString(), cfg.timeoutSeconds, cfg.screenPayer, cfg.rpcUrl]);
  if (g.__petriVerifier?.key === key && g.__petriVerifier.module === MODULE) return g.__petriVerifier.server;

  const relayer = privateKeyToAccount(cfg.relayerKey);
  const wc = createWalletClient({ account: relayer, chain: sepolia, transport: http(cfg.rpcUrl) }).extend(publicActions);
  const facilitator = new x402Facilitator().register(
    SEPOLIA.caip2,
    new ExactEvmFacilitator(
      toFacilitatorEvmSigner({
        address: relayer.address,
        getCode: (a) => wc.getCode(a),
        readContract: (a) => wc.readContract({ ...a, args: a.args || [] }),
        verifyTypedData: (a) => wc.verifyTypedData(a as Parameters<typeof wc.verifyTypedData>[0]),
        writeContract: (a) => wc.writeContract({ ...a, args: a.args || [] } as Parameters<typeof wc.writeContract>[0]),
        sendTransaction: (a) => wc.sendTransaction(a),
        waitForTransactionReceipt: (a) => wc.waitForTransactionReceipt(a),
      }),
    ),
  );
  const local: FacilitatorClient = {
    verify: (p, r) => facilitator.verify(p, r),
    settle: (p, r) => facilitator.settle(p, r),
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  };

  const payerScreens = new Map<string, PayerScreen>();

  // The payer screen runs after the facilitator checked the signature, so a forged
  // header spends no Intercepta request, and before any work or settlement.
  // It screens the payer the facilitator verified, never a field a caller could add.
  // A hook that throws is only logged by x402 (fail open), so this one never throws.
  const resource = new x402ResourceServer(local).register(SEPOLIA.caip2, new ExactEvmServer()).onAfterVerify(async (ctx) => {
    if (!ctx.result.isValid) return;
    const key = paymentKeyOf(ctx.paymentPayload.payload);
    const payer = ctx.result.payer ?? "";
    if (key === null || !payer || key.split(":")[0] !== payer.toLowerCase()) {
      return { abort: true, reason: "payer_mismatch:only a single EIP-3009 authorization from the verified payer is accepted" };
    }
    let screen: PayerScreen;
    try {
      if (!cfg.screenPayer) {
        screen = { check: payerCheck(addressVerdict(null)), call: null };
      } else {
        const ic = getInterceptaConfig();
        const call = ic.ok
          ? await quickScanAddress(payer, ic.config.client)
          : ({ endpoint: "quick-scan", subject: payer, at: Date.now(), latencyMs: 0, cached: false, ok: false, status: null, error: "INTERCEPTA_API_KEY is not set" } as const);
        screen = { check: payerCheck(addressVerdict(call, ic.ok ? ic.config.thresholds : undefined)), call };
      }
    } catch (e) {
      const call = { endpoint: "quick-scan", subject: payer, at: Date.now(), latencyMs: 0, cached: false, ok: false, status: null, error: String(e) } as const;
      screen = { check: payerCheck(addressVerdict(call)), call };
    }
    payerScreens.set(key, screen);
    if (screen.check.status === "fail" || screen.check.status === "hold") {
      return { abort: true, reason: `payer_${screen.check.status === "fail" ? "rejected" : "held"}:${screen.check.code}` };
    }
  });

  // Each route reads exactly the one parameter its handler reads (PROFILE_PARAM). If the price
  // and the handler read different ones, ?seller=honest&verifier=rogue would let the "honest"
  // handler accept a payment made to the rogue wallet.
  const profile = (c: HTTPRequestContext, product: Product) => profileOf(c.adapter.getQueryParam?.(PROFILE_PARAM[product]));
  const accepts = (product: Product) => ({
    scheme: "exact",
    network: SEPOLIA.caip2,
    maxTimeoutSeconds: cfg.timeoutSeconds,
    payTo: (c: HTTPRequestContext) => offer(cfg, profile(c, product), product).payTo,
    price: (c: HTTPRequestContext) => ({
      amount: offer(cfg, profile(c, product), product).amountAtomic.toString(),
      asset: SEPOLIA.usdc,
      extra: { ...SEPOLIA.usdcDomain },
    }),
  });
  const server = new x402HTTPResourceServer(resource, {
    [ROUTE]: {
      accepts: accepts("verification"),
      description: "Petri verification run: replay mode, 5 runs a side, a report signed by the verifier's key",
      mimeType: "application/json",
    },
    [MARKDOWN_ROUTE]: {
      accepts: accepts("markdown"),
      description: "A Petri version's record as markdown: hypothesis, status, re-runs by other keys, the change",
      mimeType: "application/json",
    },
  });

  const built: Server = {
    http: server,
    ready: server.initialize(),
    payerScreens,
    pendingNonces: new Set(),
    usedNonces: new Set(),
    busyVersions: new Set(),
  };
  // A failed initialize is retried on the next request instead of being cached forever.
  built.ready.catch(() => {
    if (g.__petriVerifier?.server === built) delete g.__petriVerifier;
  });
  g.__petriVerifier = { key, module: MODULE, server: built };
  return built;
}

export function nextAdapter(req: NextRequest): HTTPAdapter {
  return {
    getHeader: (n) => req.headers.get(n) ?? undefined,
    getMethod: () => req.method,
    getPath: () => req.nextUrl.pathname,
    getUrl: () => req.url,
    getAcceptHeader: () => req.headers.get("accept") ?? "",
    getUserAgent: () => req.headers.get("user-agent") ?? "",
    getQueryParams: () => Object.fromEntries(req.nextUrl.searchParams.entries()),
    getQueryParam: (n) => req.nextUrl.searchParams.get(n) ?? undefined,
  };
}

/** paymentKeyOf for a PAYMENT-SIGNATURE header, or null when it does not decode. */
export function paymentKeyOfHeader(header: string): string | null {
  try {
    return paymentKeyOf(decodePaymentSignatureHeader(header).payload);
  } catch {
    return null;
  }
}
