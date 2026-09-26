/**
 * The stage demo of a proposal: `pnpm demo:propose --parent v2.accepted.<tree>.petri.eth --perf 10 --tokens -5 --speed -3 --change "..."`.
 *
 * It prints the run a proposal goes through, writes the patch (3 new
 * functions) and your claim to .petri/scratch/demo-proposal/, and stops there.
 * It does not change the log. The Propose tab of the web app reads the file,
 * and the World ID step and every ENS write after it are real.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, '.petri', 'scratch', 'demo-proposal');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}
const num = (name: string, fallback: number): number => {
  const n = Number(arg(name, String(fallback)));
  if (!Number.isFinite(n)) { console.error(`--${name} must be a number of percent`); process.exit(2); }
  return Math.round(n);
};

// The parent is its ENS name, such as v2.accepted.claude-sonnet-5.petri-harness-v1.coding.petri.eth. A bare v2 works too.
const TREE = 'claude-sonnet-5.petri-harness-v1.coding.petri.eth';
const parentName = arg('parent', `v1.accepted.${TREE}`);
const parent = parentName.split('.')[0]!;
if (parentName.includes('.') && !/^v[1-9][0-9]*\.(accepted|rejected|pending)\./.test(parentName)) {
  console.error(`--parent must be a version name such as v2.accepted.${TREE}`); process.exit(2);
}
if (parentName.includes('.') && !parentName.endsWith(`.${TREE}`)) { console.error(`--parent must be a version of ${TREE}`); process.exit(2); }
const change = arg('change', 'Add one repair turn after an empty reply, so a draft with no code block gets a second chance.');
const perf = num('perf', 10);
const tokens = num('tokens', -5);
const speed = num('speed', -3);
if (!/^v[1-9][0-9]*$/.test(parent)) { console.error(`--parent must be a version name such as v2.accepted.${TREE}`); process.exit(2); }
if (change.trim().length < 10) { console.error('--change must say what changed, in 10 characters or more'); process.exit(2); }

// The parent must be a version of the log: v<n> counts NodeSubmitted in log order.
const log = join(ROOT, '.petri', 'log.jsonl');
const ids = existsSync(log)
  ? readFileSync(log, 'utf8').split('\n').filter(Boolean)
      .map((l) => (JSON.parse(l) as { envelope?: { body?: { type?: string; node?: string } } }).envelope?.body)
      .filter((b) => b?.type === 'NodeSubmitted').map((b) => b!.node!)
  : [];
const parentId = ids[Number(parent.slice(1)) - 1];
if (!parentId) { console.error(`no version ${parent} in the log`); process.exit(2); }

const RECOVERY = `/** True when the reply holds no fenced code block. */
export function isEmptyReply(reply: string): boolean {
  return !/\`\`\`[a-z]*\\n[\\s\\S]*?\`\`\`/.test(reply);
}

/** The one extra message after an empty reply: restate the symbols it must export. */
export function repairPrompt(symbols: readonly string[]): string {
  return \`Your last reply had no code block. Reply with one TypeScript block that exports: \${symbols.join(', ')}.\`;
}

/** Asks once more, only when the first reply is empty. Returns the better reply. */
export async function repairTurn(ask: (msg: string) => Promise<string>, reply: string, symbols: readonly string[]): Promise<string> {
  if (!isEmptyReply(reply)) return reply;
  return ask(repairPrompt(symbols));
}
`;
const diff = [
  'diff --git a/harness/recovery.ts b/harness/recovery.ts',
  ...RECOVERY.trimEnd().split('\n').map((l) => `+${l}`),
  'diff --git a/harness/loop.ts b/harness/loop.ts',
  '-  const reply = await ctx.model(prompt);',
  '+  const first = await ctx.model(prompt);',
  '+  const reply = await repairTurn(ctx.model, first, task.symbols);',
].join('\n');

const pct = (n: number) => `${n > 0 ? '+' : ''}${n}%`;
const claim = `perf ${pct(perf)} · tokens ${pct(tokens)} · speed ${pct(speed)}`;

mkdirSync(join(OUT, 'harness'), { recursive: true });
writeFileSync(join(OUT, 'harness', 'recovery.ts'), RECOVERY);
writeFileSync(join(OUT, 'change.diff'), `${diff}\n`);
writeFileSync(join(OUT, 'proposal.json'), `${JSON.stringify({ parent, parentName, parentId, change, perf, tokens, speed, diff, at: Date.now() }, null, 2)}\n`);

// A tenth of each pause, so the run prints fast but still line by line.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms / 10));
// Colour only on a terminal: green for a step that passed, grey for model text.
const tty = process.stdout.isTTY;
const c = (code: string) => (t: string) => (tty ? `\x1b[${code}m${t}\x1b[0m` : t);
const dim = c('2');
const ok = c('32');
const head = c('1');
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

const lines: [string, number][] = [
  [head('DEMO  a stage run. It writes the proposal for the web page and does not change the log.'), 200],
  ['', 0],
  [`parent     ${parentName}`, 200],
  [`change     ${change}`, 200],
  ['workspace  .petri/scratch/demo-proposal', 300],
  ['', 0],
  [head('read       the files the agent reads first'), 200],
  [`  digest            18 versions · recovery OPEN, 1 try · loop SATURATED`, 250],
  ['  harness/loop.ts        64 lines   ask the model, take the code out', 200],
  ['  harness/recovery.ts    22 lines   what to do after a bad reply', 200],
  ['  harness/prompt.ts      41 lines   the instructions and the worked example', 200],
  ['  SPEC.md §11            the rules: 2 files, 120 lines, contract.ts frozen', 400],
  ['', 0],
  [head('model      call 1 · claude-sonnet-5 · 3,214 tokens in · 412 out · 2.1 s'), 700],
  [dim(`  > in   "Here are the digest and harness/. Propose one change to ${parent}. Say the area and why."`), 300],
  [dim(`  < out  "${clip(change, 70)} Area: recovery. 2 of 20 tasks fail on an empty reply."`), 500],
  [head('model      call 2 · claude-sonnet-5 · 4,020 tokens in · 845 out · 3.4 s'), 900],
  [dim('  > in   "Write the patch. At most 2 files and 120 lines. Relative imports only."'), 300],
  [dim('  < out  "```ts  export function isEmptyReply(reply: string): boolean { … }  ```"'), 500],
  [head('model      call 3 · claude-sonnet-5 · 1,806 tokens in · 96 out · 0.8 s'), 700],
  [dim('  > in   "Check your patch against the rules. Reply OK or the rule it breaks."'), 300],
  [dim('  < out  "OK. 2 files, 18 lines, no new imports outside harness/."'), 400],
  ['', 0],
  [head('write      the files the agent changed'), 200],
  [` harness/recovery.ts | 15 +++++++++++++++   isEmptyReply, repairPrompt, repairTurn`, 250],
  [` harness/loop.ts     |  3 ++-              calls repairTurn after the first reply`, 250],
  [' 2 files changed, 17 insertions(+), 1 deletion(-)', 400],
  ['', 0],
  [head('check      the rules, before anything runs'), 200],
  [`  patch      2 files, 18 lines        ${ok('ok')}`, 300],
  [`  typecheck  tsc --noEmit             ${ok('ok')}`, 500],
  [`  sandbox    relative imports only    ${ok('ok')}`, 300],
  [`  contract   contract.ts untouched    ${ok('ok')}`, 300],
  ['', 0],
  [head('run        3 tasks against the parent, with your key'), 400],
  [`  task-04    candidate ${ok('pass')}   parent fail   the empty reply was repaired`, 500],
  [`  task-11    candidate ${ok('pass')}   parent pass`, 400],
  [`  task-17    candidate ${ok('pass')}   parent pass`, 400],
  ['', 0],
  [head('report'), 0],
  ['  runner     your key, .petri/identity.json', 150],
  [`  parent     ${parent}  2 of 3 tasks`, 150],
  [`  candidate  new   3 of 3 tasks`, 150],
  [`  claim      ${claim}`, 150],
  ['  status     pending · two other keys must verify it', 300],
  ['', 0],
  [ok('ready      open the Propose tab of the web app. It shows this proposal.'), 0],
];
for (const [line, ms] of lines) { console.log(line); await wait(ms); }
