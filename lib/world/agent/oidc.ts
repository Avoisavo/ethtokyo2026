import "server-only";

import { createPublicKey, generateKeyPairSync, sign, verify, type JsonWebKey } from "node:crypto";

import { ORB_ACR, type AgentConfig } from "./config";

/**
 * The OIDC calls for the device authorization grant, and ID token validation.
 *
 * Validation is done here with node:crypto rather than trusted from the token
 * response: the RS256 signature against the IdP's JWKS, then issuer, audience,
 * expiry, and freshness. Decoding a JWT is not validating it.
 */

type Discovery = {
  issuer: string;
  token_endpoint: string;
  device_authorization_endpoint: string;
  jwks_uri: string;
};

const TIMEOUT_MS = 10_000;
/** Allowed clock skew, in seconds. */
const SKEW = 30;

let discoveryCache: { at: number; value: Discovery } | null = null;
let jwksCache: { at: number; keys: JsonWebKey[] } | null = null;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.json();
}

export async function discover(issuer: string): Promise<Discovery> {
  if (discoveryCache && Date.now() - discoveryCache.at < 10 * 60_000) return discoveryCache.value;
  const value = (await getJson(`${issuer}/.well-known/openid-configuration`)) as Discovery;
  discoveryCache = { at: Date.now(), value };
  return value;
}

async function getJwks(jwksUri: string, force = false): Promise<JsonWebKey[]> {
  if (!force && jwksCache && Date.now() - jwksCache.at < 10 * 60_000) return jwksCache.keys;
  const { keys } = (await getJson(jwksUri)) as { keys: JsonWebKey[] };
  jwksCache = { at: Date.now(), keys };
  return keys;
}

/** POST a form to the IdP, authenticating with the client's registered method. */
async function postForm(config: AgentConfig, url: string, fields: Record<string, string>) {
  const body = new URLSearchParams(fields);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (config.authMethod === "client_secret_basic") {
    // RFC 6749 §2.3.1: form-encode each part before base64.
    const pair = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`;
    headers.Authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
  } else {
    body.set("client_id", config.clientId);
    body.set("client_secret", config.clientSecret);
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

export type DeviceStart = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

export async function startDeviceAuthorization(config: AgentConfig) {
  const d = await discover(config.issuer);
  return postForm(config, d.device_authorization_endpoint, { scope: "openid" }) as Promise<{
    status: number;
    json: Partial<DeviceStart> & { error?: string; error_description?: string };
  }>;
}

export async function pollDeviceToken(config: AgentConfig, deviceCode: string) {
  const d = await discover(config.issuer);
  const fields: Record<string, string> = {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
  };
  return postForm(config, d.token_endpoint, fields) as Promise<{
    status: number;
    json: { id_token?: string; error?: string; error_description?: string };
  }>;
}

/**
 * Probe the client credentials without starting a real attempt: redeem a
 * device code that cannot exist. Bad credentials answer `invalid_client`;
 * good ones get past authentication and answer `invalid_grant`.
 */
export async function probeClient(config: AgentConfig) {
  return pollDeviceToken(config, "preflight-probe-not-a-real-device-code");
}

/* ------------------------------------------------------------ validation */

export type Check = { id: string; label: string; status: "pass" | "fail"; detail: string };

export type IdClaims = {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  azp?: string;
  exp?: number;
  iat?: number;
  auth_time?: number;
  acr?: string;
  amr?: string[];
};

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/**
 * Validate an ID token for this client. `notBefore` is when the approval
 * attempt started (seconds): the proof must belong to this attempt, not an
 * older session.
 */
export async function validateIdToken(
  config: AgentConfig,
  token: string,
  notBefore: number,
): Promise<{ ok: boolean; checks: Check[]; claims: IdClaims }> {
  const checks: Check[] = [];
  const add = (id: string, label: string, pass: boolean, detail: string) =>
    checks.push({ id, label, status: pass ? "pass" : "fail", detail });

  const parts = token.split(".");
  if (parts.length !== 3) {
    add("format", "Token format", false, "Not a compact JWS (expected 3 parts).");
    return { ok: false, checks, claims: {} };
  }
  let header: { alg?: string; kid?: string };
  let claims: IdClaims;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]) as IdClaims;
  } catch {
    add("format", "Token format", false, "Header or payload is not valid base64url JSON.");
    return { ok: false, checks, claims: {} };
  }

  // 1. Signature, against the IdP's published keys only.
  let sigOk = false;
  let sigDetail = "";
  if (header.alg !== "RS256") {
    sigDetail = `alg is ${String(header.alg)}, only RS256 is accepted.`;
  } else {
    const d = await discover(config.issuer);
    let keys = await getJwks(d.jwks_uri);
    let jwk = keys.find((k) => (k as { kid?: string }).kid === header.kid);
    if (!jwk) {
      // Handle key rotation: refresh once on an unknown kid.
      keys = await getJwks(d.jwks_uri, true);
      jwk = keys.find((k) => (k as { kid?: string }).kid === header.kid);
    }
    if (!jwk) {
      sigDetail = `kid "${String(header.kid)}" is not in the IdP's JWKS.`;
    } else {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      sigOk = verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        key,
        Buffer.from(parts[2], "base64url"),
      );
      sigDetail = sigOk ? `RS256, verified with IdP key ${String(header.kid)}.` : "Signature does not verify with the IdP key.";
    }
  }
  add("signature", "Signature", sigOk, sigDetail);
  // Nothing in an unsigned or forged payload can be trusted, so stop here.
  if (!sigOk) return { ok: false, checks, claims };

  const now = Math.floor(Date.now() / 1000);
  add("iss", "Issuer", claims.iss === config.issuer, `iss = ${String(claims.iss)}`);

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const audOk = aud.includes(config.clientId) && (aud.length === 1 || claims.azp === config.clientId);
  add("aud", "Audience", audOk, audOk ? "Issued to this client." : `aud = ${JSON.stringify(claims.aud)}`);

  const expOk = typeof claims.exp === "number" && claims.exp + SKEW > now;
  add("exp", "Expiry", expOk, expOk ? `Valid for ${claims.exp! - now}s more.` : "Token has expired.");

  const at = claims.auth_time;
  const freshOk = typeof at === "number" && at >= notBefore - SKEW && at <= now + SKEW;
  add(
    "fresh",
    "Fresh proof",
    freshOk,
    freshOk
      ? "auth_time is inside this approval attempt, so the human proved just now."
      : `auth_time ${String(at)} is not inside this attempt (started ${notBefore}).`,
  );

  add("acr", "Assurance", claims.acr === ORB_ACR, `acr = ${String(claims.acr)}`);
  add("sub", "Subject", typeof claims.sub === "string" && claims.sub.length > 0, "Pairwise subject present.");

  return { ok: checks.every((c) => c.status === "pass"), checks, claims };
}

/**
 * A token that looks right but was signed by a key the IdP never published.
 * Used to show that validation rejects it.
 */
export function forgeIdToken(config: AgentConfig, kid: string | undefined): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", typ: "JWT", kid: kid ?? "forged" });
  const body = enc({
    iss: config.issuer,
    sub: "forged-subject",
    aud: config.clientId,
    exp: now + 300,
    iat: now,
    auth_time: now,
    acr: ORB_ACR,
    amr: ["pop"],
  });
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

/** The kid of the IdP's first signing key, so a forged token points at a real key. */
export async function firstKid(config: AgentConfig): Promise<string | undefined> {
  const d = await discover(config.issuer);
  const keys = await getJwks(d.jwks_uri);
  return (keys[0] as { kid?: string } | undefined)?.kid;
}
