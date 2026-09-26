/**
 * One command for a verifier: `pnpm demo:verify v18`.
 *
 * It uses the key in ~/my-verifier (or PETRI_HOME), and makes it first when
 * it is missing. Then it runs the real `petri verify <version> --show`, which
 * re-runs the version and its parent and signs the result into the log.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const version = (process.argv[2] ?? 'v18').split('.')[0]!;
const home = process.env['PETRI_HOME'] ?? join(homedir(), 'my-verifier');
const env = { ...process.env, PETRI_HOME: home };
const petri = (args: string[]) =>
  spawnSync(join(ROOT, 'node_modules', '.bin', 'tsx'), ['src/cli/index.ts', ...args], { cwd: ROOT, env, stdio: 'inherit' }).status ?? 1;

if (!existsSync(join(home, 'identity.json'))) {
  console.log(`key        none in ${home}. Making one.\n`);
  const made = petri(['id', 'create', '--label', 'verifier']);
  if (made !== 0) process.exit(made);
  console.log('');
} else {
  console.log(`key        ${join(home, 'identity.json')}\n`);
}
process.exit(petri(['verify', version, '--show']));
