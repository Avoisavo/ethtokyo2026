/**
 * Shared plumbing for every command: the global flags, the loaded config, the
 * store, the identity and the log.
 *
 * This file is CLI-owned glue. It writes nothing under `.petri/` itself.
 * Every write goes through `store` or `consensus`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Command } from 'commander';

import { loadConfig, type PetriConfig } from '../config.js';
import { contentId, type Canon } from '../core/canonical.js';
import type { Mode } from '../core/schema.js';
import type { ConsensusLog } from '../consensus/log.js';
import { openLog } from '../consensus/log.js';
import type { EnvDescriptor } from '../trust/report.js';
import { loadIdentity, type Identity } from '../trust/identity.js';
import { configPath, identityPath, logPath, petriDir } from '../store/paths.js';
import { PetriStore } from '../store/store.js';
import { EXIT, fail } from './exit.js';
import { printBanner, trustLabel, type TrustLabel } from './banner.js';

/** The repo root that ships this CLI. It is the default `--root`. */
export const DEFAULT_ROOT: string = resolve(fileURLToPath(new URL('../../', import.meta.url)));

export interface GlobalOptions {
  root: string;
  json: boolean;
  quiet: boolean;
  color: boolean;
}

/** Read the global flags of §14.2 from any sub-command. */
export function globalOptions(cmd: Command): GlobalOptions {
  const o = cmd.optsWithGlobals() as {
    root?: string;
    json?: boolean;
    quiet?: boolean;
    color?: boolean;
  };
  const raw = o.root ?? DEFAULT_ROOT;
  return {
    root: isAbsolute(raw) ? raw : resolve(process.cwd(), raw),
    json: o.json === true,
    quiet: o.quiet === true,
    color: o.color !== false,
  };
}

export interface Ctx extends GlobalOptions {
  config: PetriConfig;
  store: PetriStore;
  benchDir: string;
  trust: TrustLabel;
  /** Load the identity on demand. A read-only command must not need a key. */
  identity(): Identity;
  /** Open the consensus log on demand. */
  log(): ConsensusLog;
  closeLog(): Promise<void>;
}

/**
 * Open a repository. Exits NOT_FOUND when `.petri/` or its config is missing,
 * and prints the trust banner unless the caller asks for silence.
 */
export function openCtx(cmd: Command, opts: { banner?: boolean } = {}): Ctx {
  const g = globalOptions(cmd);
  if (!existsSync(petriDir(g.root))) {
    fail(
      EXIT.NOT_FOUND,
      `no .petri directory under ${g.root}. Run \`petri init\` first.`,
    );
  }
  if (!existsSync(configPath(g.root))) {
    fail(
      EXIT.NOT_FOUND,
      `no config at ${configPath(g.root)}. Run \`petri init\` first.`,
    );
  }

  let config: PetriConfig;
  try {
    config = loadConfig(configPath(g.root));
  } catch (err) {
    fail(EXIT.INTEGRITY, `config is unusable: ${(err as Error).message}`);
  }

  const store = new PetriStore(g.root);
  let identity: Identity | null = null;
  let log: ConsensusLog | null = null;

  const ctx: Ctx = {
    ...g,
    config,
    store,
    benchDir: resolve(g.root, 'bench'),
    trust: trustLabel(),
    identity(): Identity {
      if (identity === null) {
        try {
          identity = loadIdentity(identityPath(g.root));
        } catch (err) {
          fail(EXIT.NOT_FOUND, (err as Error).message);
        }
      }
      return identity;
    },
    log(): ConsensusLog {
      log ??= openLog(config, ctx.identity(), g.root);
      return log;
    },
    async closeLog(): Promise<void> {
      if (log !== null) {
        await log.close();
        log = null;
      }
    },
  };

  if (opts.banner !== false) printBanner(config, g.root);
  return ctx;
}

/** Write one line to stdout. Never coloured. */
export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** Write progress to stderr. `--quiet` suppresses it. The banner is never suppressed. */
export function note(ctx: Pick<Ctx, 'quiet'>, line: string): void {
  if (!ctx.quiet) process.stderr.write(`${line}\n`);
}

/**
 * Print a machine-readable document. §8.7: every export carries `trust` and
 * `mode` at the top level, so a JSON consumer cannot lose the honesty label.
 */
export function emitJson(ctx: Pick<Ctx, 'config' | 'trust'>, body: Record<string, unknown>): void {
  out(
    JSON.stringify(
      { trust: ctx.trust, mode: ctx.config.mode, ledger: ctx.config.ledger, ...body },
      null,
      2,
    ),
  );
}

/** Parse an odd run count. §14.1: an even run count is USAGE. */
export function parseRuns(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 3 || n > 99) {
    fail(EXIT.USAGE, `--runs must be an integer between 3 and 99, got ${value}`);
  }
  if (n % 2 === 0) {
    fail(EXIT.USAGE, `--runs must be odd, got ${n}. An even count has no unique median.`);
  }
  return n;
}

export function parseInt10(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) fail(EXIT.USAGE, `${flag} must be an integer, got ${value}`);
  return n;
}

export function parseMode(value: string | undefined, fallback: Mode): Mode {
  if (value === undefined) return fallback;
  if (value !== 'live' && value !== 'replay') {
    fail(EXIT.USAGE, `--mode must be live or replay, got ${value}`);
  }
  return value;
}

/** The git commit of this checkout, or 'unknown'. Descriptive only. */
export function petriCommit(root: string): string {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The model name a run records. §11.5: a graded fallback is labelled `graded`. */
export function modelNameFor(mode: Mode, allowGraded: boolean): string {
  if (mode === 'live') return 'claude-sonnet-5';
  return allowGraded ? 'graded' : 'none';
}

export function buildEnv(ctx: Ctx, mode: Mode, allowGraded: boolean): EnvDescriptor {
  return {
    arch: process.arch,
    benchId: ctx.config.bench.id,
    ledger: ctx.config.ledger,
    mode,
    model: modelNameFor(mode, allowGraded),
    nodeVersion: process.version,
    petriCommit: petriCommit(ctx.root),
    platform: process.platform,
  };
}

/**
 * A TypeScript interface carries no implicit index signature, so a record that
 * satisfies `Canon` at run time still needs a cast at compile time.
 * Every cast in the CLI goes through this one function, so they are countable.
 */
export const asCanon = (value: unknown): Canon => value as Canon;

export const envHashOf = (env: EnvDescriptor): string => contentId(asCanon(env));

/**
 * The node ids in the order the log first submitted them. `v1` is the first.
 * The web app and the ENS names count versions the same way.
 */
function submittedOrder(store: PetriStore): string[] {
  const file = logPath(store.root);
  if (!existsSync(file)) return [];
  const ids: string[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const body = (JSON.parse(line) as { envelope?: { body?: { type?: string; node?: string } } }).envelope?.body;
    if (body?.type === 'NodeSubmitted' && body.node && !ids.includes(body.node)) ids.push(body.node);
  }
  return ids;
}

/**
 * Resolve a node id the user typed. A unique 8-or-more character prefix works,
 * and so does a version number: `v1` is the first node the log submitted.
 */
export function resolveNodeId(store: PetriStore, needle: string): string {
  const v = /^v([1-9][0-9]*)$/.exec(needle);
  if (v) {
    const id = submittedOrder(store)[Number(v[1]) - 1];
    if (id === undefined || !store.hasNode(id)) fail(EXIT.NOT_FOUND, `no version ${needle}`);
    return id;
  }
  if (/^[0-9a-f]{64}$/.test(needle)) {
    if (!store.hasNode(needle)) fail(EXIT.NOT_FOUND, `no node ${needle}`);
    return needle;
  }
  if (!/^[0-9a-f]{4,63}$/.test(needle)) {
    fail(EXIT.USAGE, `"${needle}" is not a node id. Use a version number such as v3, or a lowercase hexadecimal id.`);
  }
  const hits = store.listNodeIds().filter((id) => id.startsWith(needle));
  if (hits.length === 0) fail(EXIT.NOT_FOUND, `no node starts with ${needle}`);
  if (hits.length > 1) {
    fail(
      EXIT.USAGE,
      `${needle} matches ${hits.length} nodes: ${hits.map((h) => h.slice(0, 12)).join(', ')}`,
    );
  }
  return hits[0]!;
}
