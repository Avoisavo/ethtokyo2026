import "server-only";

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { PETRI_ROOT } from "../tree";

/**
 * The work the verifier sells: a real `petri verify <version>` with the
 * verifier's own ed25519 key (PETRI_HOME), in replay mode, 5 runs a side.
 *
 * `preflight` runs before the 402, so Petri never quotes a price for a run
 * that cannot happen or cannot count: the engine must be installed, the
 * version scored, and the key neither the author's nor one that already
 * reported on this version. A repeat from one key is ignored by the acceptance rule.
 */

const run = promisify(execFile);
const TSX = path.join(PETRI_ROOT, "node_modules", ".bin", "tsx");

export const engineInstalled = () => existsSync(TSX);

type Fail = { ok: false; status: number; code: string; detail: string };

export type VerifierIdentity = { runnerId: string; label: string };

export function verifierIdentity(home: string | null): { ok: true; identity: VerifierIdentity } | Fail {
  if (!home) {
    return { ok: false, status: 503, code: "verifier_key_missing", detail: "Set PETRI_VERIFIER_HOME to a folder with a Petri identity.json." };
  }
  try {
    const raw = JSON.parse(readFileSync(path.join(home, "identity.json"), "utf8")) as { runnerId?: string; label?: string };
    if (typeof raw.runnerId !== "string") throw new Error("no runnerId");
    return { ok: true, identity: { runnerId: raw.runnerId, label: raw.label ?? "" } };
  } catch {
    return {
      ok: false,
      status: 503,
      code: "verifier_key_missing",
      detail: `No Petri key in ${home}. Create one: cd petri && PETRI_HOME=${home} corepack pnpm petri id create --label verifier`,
    };
  }
}

const petri = (args: string[], home: string, timeout: number) =>
  run(TSX, ["src/cli/index.ts", "--json", ...args], {
    cwd: PETRI_ROOT,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PETRI_HOME: home },
  });

/** Petri exit codes (petri/src/core/errors.ts) as HTTP statuses. */
function failure(e: unknown, fallback: string): Fail {
  const err = e as { code?: number | string; stderr?: string; message: string; killed?: boolean };
  // stderr also carries the trust banner. The engine's own errors start with "petri:".
  const lines = (err.stderr?.trim() || err.message).split("\n");
  const own = lines.filter((l) => l.startsWith("petri:"));
  const detail = (own.length ? own : lines.slice(-6)).join("\n");
  if (err.killed) return { ok: false, status: 504, code: "verify_timeout", detail };
  const status = { 2: 404, 4: 409, 5: 503 }[Number(err.code)] ?? 500;
  const code = { 404: "version_not_found", 409: "verify_refused", 503: "engine_environment" }[status] ?? fallback;
  return { ok: false, status, code, detail };
}

/** alreadyVerified: this key reported on the version before, so a new report will not count. */
export type Preflight = { ok: true; runnerId: string; alreadyVerified: boolean } | Fail;

/**
 * `petri --json show <id> --diff`: the live record of one version. Read-only,
 * but the engine opens the tree with a key, so it runs as the verifier's key.
 */
export async function petriShow(versionId: string, home: string): Promise<{ ok: true; node: unknown } | Fail> {
  try {
    const { stdout } = await petri(["show", versionId, "--diff"], home, 30_000);
    return { ok: true, node: (JSON.parse(stdout) as { node: unknown }).node };
  } catch (e) {
    return failure(e, "show_failed");
  }
}

/**
 * `allowRepeat` is for demos only. In Petri one key counts once per version, so
 * a repeat report is stored and published but never changes the version's status.
 */
export async function preflight(versionId: string, home: string | null, opts: { allowRepeat?: boolean } = {}): Promise<Preflight> {
  if (!engineInstalled()) {
    return { ok: false, status: 503, code: "engine_not_installed", detail: "The Petri engine is not installed. Run: cd petri && corepack pnpm install" };
  }
  const id = verifierIdentity(home);
  if (!id.ok) return id;
  const { runnerId } = id.identity;
  try {
    const { stdout } = await petri(["show", versionId], home!, 30_000);
    const node = (JSON.parse(stdout) as {
      node: { id: string; manifest: { author: string }; detail: { mechanical: { cls: string } }; verifications: { pub: string }[] };
    }).node;
    if (node.detail.mechanical.cls !== "ok") {
      return { ok: false, status: 409, code: "version_not_scored", detail: `${versionId} was stopped before scoring. There is nothing to verify.` };
    }
    if (node.manifest.author === runnerId) {
      return { ok: false, status: 409, code: "verifier_is_author", detail: "This verifier's key wrote the version. Its report would not count." };
    }
    const alreadyVerified = node.verifications.some((v) => v.pub === runnerId);
    if (alreadyVerified && !opts.allowRepeat) {
      return { ok: false, status: 409, code: "already_verified", detail: "This verifier's key already reported on this version. A second report would not count." };
    }
    return { ok: true, runnerId, alreadyVerified };
  } catch (e) {
    return failure(e, "preflight_failed");
  }
}

/** `petri --json status <id>`: the keys the acceptance rule counted for this version. */
export async function petriCountedKeys(versionId: string, home: string): Promise<{ ok: true; counted: string[] } | Fail> {
  try {
    const { stdout } = await petri(["status", versionId], home, 30_000);
    return { ok: true, counted: (JSON.parse(stdout) as { counted: string[] }).counted };
  } catch (e) {
    return failure(e, "status_failed");
  }
}

export type VerifyResult =
  | {
      ok: true;
      report: string;
      runner: string;
      deltaMedianBp: number;
      status: string;
      statusCode: string;
      statusReason: string;
    }
  | Fail;

const g = globalThis as unknown as { __petriVerifyLock?: Promise<unknown> };

/**
 * One verify at a time: runs share the scratch harness folders and the log lock.
 * `recheck` runs inside the lock, just before the verify, so a run queued behind
 * another run of the same version is refused instead of producing a report that cannot count.
 */
export async function runVerify(versionId: string, home: string, recheck?: () => Promise<Preflight>): Promise<VerifyResult> {
  const previous = g.__petriVerifyLock ?? Promise.resolve();
  const mine = previous.catch(() => undefined).then(async (): Promise<VerifyResult> => {
    try {
      const again = recheck ? await recheck() : null;
      if (again && !again.ok) return again;
      const { stdout } = await petri(["verify", versionId], home, 180_000);
      const r = JSON.parse(stdout) as Extract<VerifyResult, { ok: true }> & { seq: number | null };
      // petri stores a report it could not publish and still exits 0. It does not count yet.
      if (r.seq === null || r.seq === undefined) {
        return { ok: false, status: 503, code: "report_not_published", detail: "The report was stored but not published to the log (the log lock was busy)." };
      }
      return {
        ok: true,
        report: r.report,
        runner: r.runner,
        deltaMedianBp: r.deltaMedianBp,
        status: r.status,
        statusCode: r.statusCode,
        statusReason: r.statusReason,
      };
    } catch (e) {
      return failure(e, "verify_failed");
    }
  });
  g.__petriVerifyLock = mine;
  return mine;
}
