/**
 * The Intercepta (Web3 Antivirus) API: Quick Scan Address and Scan Message.
 *
 * A plain module, not server-only, so the node tests can import it. The caller
 * passes the key. Never import this from a client component.
 *
 * It never throws. A timeout, a 403 or a 5xx comes back as a failed call, and
 * the decision engine turns that into a hold. Checked live on 2026-09-27:
 *
 *   - Quick Scan answers 200 {toxicScore, traits[]}. A fresh address scores 0
 *     with no traits. Traits arrive without the documented txsCount.
 *   - Scan Message answers 201. `message` must be the typed-data OBJECT. The
 *     documented JSON-string form parses nothing and comes back "Low".
 *   - Neither endpoint takes a testnet chain id. Intercepta scores an address
 *     by its mainnet history, so a Sepolia payment is screened under chain "1".
 */

export const INTERCEPTA_BASE_URL = "https://api.web3antivirus.io";

export type Trait = { name: string; risk: number; description: string; txsCount?: number };
export type QuickScan = { toxicScore: number; traits: Trait[] };

export type Detector = { code: string; description: string };
export type MessageScan = {
  messageType: string | null;
  riskGroup: string;
  detectors: Detector[];
  addresses: { address: string; type: string; detectors: string[] }[];
};

export type InterceptaCall<T> = {
  endpoint: "quick-scan" | "scan-message";
  /** The address that was scanned, or the signer for Scan Message. */
  subject: string;
  at: number;
  latencyMs: number;
  cached: boolean;
} & ({ ok: true; status: number; body: T } | { ok: false; status: number | null; error: string });

export type ClientOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Quick Scan results are cached per address. 0 turns the cache off. */
  cacheTtlMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
};

/** EIP-712 typed data as viem and x402 hand it to a signer: bigints, numeric chainId, no EIP712Domain. */
export type TypedDataLike = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

const g = globalThis as unknown as { __interceptaQuickScan?: Map<string, InterceptaCall<QuickScan>> };
const cache = (g.__interceptaQuickScan ??= new Map());

/** GET /api/public/v2/extension/account/{address}/quick-scan */
export async function quickScanAddress(address: string, o: ClientOptions): Promise<InterceptaCall<QuickScan>> {
  // Always the hex address. Intercepta resolves mainnet ENS, and Petri's names live on Sepolia.
  const subject = address.toLowerCase();
  const now = (o.now ?? Date.now)();
  const hit = cache.get(subject);
  if (hit && hit.ok && now - hit.at < (o.cacheTtlMs ?? 300_000)) return { ...hit, cached: true };

  const call = await request<QuickScan>(o, "GET", `/api/public/v2/extension/account/${subject}/quick-scan`, undefined, "quick-scan", subject);
  if (call.ok && !isQuickScan(call.body)) {
    return { ...call, ok: false, error: "unexpected response shape", status: call.status } as InterceptaCall<QuickScan>;
  }
  if (call.ok) cache.set(subject, call);
  return call;
}

/** POST /api/public/v2/extension/analysis/signature */
export async function scanMessage(
  i: { from: string; typedData: TypedDataLike; chainId: string; website?: string },
  o: ClientOptions,
): Promise<InterceptaCall<MessageScan>> {
  const from = i.from.toLowerCase();
  const call = await request<MessageScan>(
    o,
    "POST",
    "/api/public/v2/extension/analysis/signature",
    {
      from,
      chainId: i.chainId,
      message: toInterceptaTypedData(i.typedData),
      // A localhost origin reads as a newly created website, so only real origins are sent.
      ...(i.website?.startsWith("https://") ? { website: i.website } : {}),
    },
    "scan-message",
    from,
  );
  if (call.ok && !isMessageScan(call.body)) {
    return { ...call, ok: false, error: "unexpected response shape", status: call.status } as InterceptaCall<MessageScan>;
  }
  return call;
}

/** Typed data in the JSON Intercepta parses: bigints as decimal strings, EIP712Domain listed. */
export function toInterceptaTypedData(td: TypedDataLike): Record<string, unknown> {
  const domainTypes = [
    ["name", "string"],
    ["version", "string"],
    ["chainId", "uint256"],
    ["verifyingContract", "address"],
    ["salt", "bytes32"],
  ]
    .filter(([name]) => td.domain[name] !== undefined)
    .map(([name, type]) => ({ name, type }));
  const withDomain = { ...td, types: { EIP712Domain: domainTypes, ...td.types } };
  return JSON.parse(JSON.stringify(withDomain, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function request<T>(
  o: ClientOptions,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  endpoint: InterceptaCall<T>["endpoint"],
  subject: string,
): Promise<InterceptaCall<T>> {
  const timeoutMs = o.timeoutMs ?? 6000;
  const base = { endpoint, subject, at: (o.now ?? Date.now)(), cached: false };
  const t0 = performance.now();
  try {
    const res = await (o.fetch ?? fetch)(`${(o.baseUrl ?? INTERCEPTA_BASE_URL).replace(/\/+$/, "")}${path}`, {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "X-API-KEY": o.apiKey,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const latencyMs = Math.round(performance.now() - t0);
    const json: unknown = await res.json().catch(() => null);
    if (res.ok && json !== null) return { ...base, latencyMs, ok: true, status: res.status, body: json as T };
    return { ...base, latencyMs, ok: false, status: res.status, error: errorText(json) ?? `HTTP ${res.status}` };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - t0);
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    return { ...base, latencyMs, ok: false, status: null, error: timedOut ? `timed out after ${timeoutMs} ms` : String(e) };
  }
}

/** A 403 reads {status, response, errors[{field, message}]}. `response` may also be an object. */
function errorText(json: unknown): string | null {
  if (json === null || typeof json !== "object") return null;
  const j = json as { response?: unknown; message?: unknown; errors?: { message?: unknown }[] };
  if (typeof j.response === "string") return j.response;
  if (j.response && typeof j.response === "object" && typeof (j.response as { message?: unknown }).message === "string") {
    return (j.response as { message: string }).message;
  }
  if (typeof j.message === "string") return j.message;
  const first = j.errors?.[0]?.message;
  return typeof first === "string" ? first : null;
}

function isQuickScan(b: unknown): b is QuickScan {
  const q = b as QuickScan;
  return !!q && typeof q.toxicScore === "number" && Array.isArray(q.traits) && q.traits.every((t) => typeof t?.name === "string");
}

function isMessageScan(b: unknown): b is MessageScan {
  const m = b as MessageScan;
  return !!m && typeof m.riskGroup === "string" && Array.isArray(m.detectors) && Array.isArray(m.addresses ?? []);
}
