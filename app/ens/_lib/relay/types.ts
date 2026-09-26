// JSON shapes of the relay's HTTP API, shared by the server routes and the admin app.
// Bigints are serialized as decimal strings.

import type { Address } from "viem";

import type { Bundle, ProviderId } from "./bundle";

export type LevelStatus = "registered" | "reserved" | "available" | "missing";

/** One level of the chain from the company root down to a name. */
export type LevelView = {
  /** Full name at this level, e.g. "eng.acme.eth". */
  name: string;
  /** Registry holding this level's label. */
  registry: Address | null;
  /** Resolver set on this level's entry: where its bundle lives (the parent's resolver, by design). */
  resolver: Address | null;
  /** This level's own subname registry, if any. */
  subregistry: Address | null;
  status: LevelStatus;
  owner: Address | null;
  /** Unix seconds. */
  expiry: number | null;
  /** EAC resource of the entry (decimal); changes when the label is re-registered. */
  resource: string | null;
  bundle: Bundle | null;
  /** Dollars spent in the current period, per provider. */
  spent: Partial<Record<ProviderId, number>>;
  checks: {
    /** Registry is a genuine ENSv2 UserRegistry proxy (null when not applicable, e.g. ETHRegistry). */
    registryVerified: boolean | null;
    /** Resolver is a genuine PermissionedResolver proxy. */
    resolverVerified: boolean | null;
    /** The registry's parent pointer matches the path used (no aliasing). */
    canonical: boolean | null;
  };
};

/** GET /api/relay/policy?name=&provider= — what the relay would decide right now (no auth, read-only). */
export type PolicyResponse = {
  name: string;
  provider: ProviderId | null;
  root: string;
  allowed: boolean;
  /** Why it would be refused, or null. */
  reason: string | null;
  /** Smallest remaining dollar budget across capped levels, or null if uncapped. */
  remaining: number | null;
  levels: LevelView[];
};

/** GET /api/relay/status */
export type StatusResponse = {
  /** RELAY_ROOT_NAME, e.g. "acme.eth"; null when unset. */
  root: string | null;
  providers: { id: ProviderId; label: string; configured: boolean; metered: boolean }[];
  recordPrefix: string;
  dnsAlias: { from: string; to: string } | null;
  requireCanonical: boolean;
  /** Relay base URL tools should use, e.g. "http://localhost:3000/api/relay". */
  baseUrl: string;
};

/** GET /api/relay/log — newest first. */
export type LogEntry = {
  ts: number;
  name: string | null;
  provider: string;
  method: string;
  path: string;
  allowed: boolean;
  reason: string | null;
  /** Upstream HTTP status, when the call was forwarded. */
  status: number | null;
  costUsd: number | null;
  /** True when cost was estimated (e.g. stream aborted before usage arrived). */
  estimated: boolean;
  signer: Address | null;
};

/** GET /api/ens/children?name= — names registered directly under a name. */
export type ChildrenResponse = {
  name: string;
  /** The name's subname registry, or null if it has none. */
  registry: Address | null;
  children: ChildView[];
};

export type ChildView = {
  label: string;
  name: string;
  status: LevelStatus;
  owner: Address | null;
  expiry: number | null;
  resolver: Address | null;
  subregistry: Address | null;
  bundle: Bundle | null;
};

/** Error body for every relay/API failure. */
export type RelayError = { error: string; reason?: string };
