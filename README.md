# Petri

Petri's a version tree for AI agent harnesses. A harness is the code around a model:
the prompt, the retry loop, the context it reads. Petri records every change to it.

Each version in the tree holds three things:

1. A hypothesis in plain English, with the result that would prove it wrong.
2. A benchmark score, measured as the median of 5 runs.
3. Signatures from other keys that re-ran the measurement.

A version is accepted only when 2 other keys re-run it and agree. Rejected versions are
never deleted, so the next agent reads them and does not try the same idea again.


![Petri, explained: the tree, the problem, the mechanism, the record, the loop and the limits](docs/petri-overview.png)

*How Petri works, on one page. The numbers in this explainer are examples. The real recorded tree and its scores are further down, and live at [ethonline2026-two.vercel.app](https://ethonline2026-two.vercel.app/tree/coding--petri-harness-v1--claude-sonnet-5).*

---

## The problem

1. **Nobody measures.** Teams change a prompt, then say the agent "feels better". There is
   no baseline and no repeat count.
2. **Failures stay private.** A dead end stays in one person's terminal. The next engineer
   tries the same idea again and pays for the same tokens.
3. **Nobody can check a claim.** A reported gain cannot be re-run, because the harness and
   the measurement are not published.

## How Petri answers it

| Problem | What Petri does |
|---|---|
| Nobody measures | Every version runs 20 coding tasks 5 times. The median counts. |
| Failures stay private | Rejected versions stay in the tree with their reason. `petri digest` gives them to the next agent. |
| Nobody can check a claim | A version id is the SHA-256 of its manifest. Other keys re-run both the parent and the version, then sign the result. |

The evolution model:

- **Variation:** a version changes at most 2 files and 120 lines of its parent.
- **Inheritance:** a version starts from its parent's harness files.
- **Selection:** the acceptance rule in `petri/src/policy/acceptance.ts` sets the status.

---

## The acceptance rule

1. A verifier re-runs the parent and the version. Each side runs 5 times.
2. The author's key cannot verify its own version. Two reports from one key count as one.
3. The version is **accepted** when 2 distinct keys each measure at least +1000 basis points.
   (100 basis points = 1%.)
4. At or below -1000 basis points, it is **rejected** as a regression.
5. Between those limits, it is **rejected** as within noise.
6. A version that a guard or the typecheck stopped is never scored. It stays **pending**.

---

## Run it

You need Node and pnpm. No API key is needed.

### The web app

```bash
npm install
npm run dev          # http://localhost:3000
```

1. Open http://localhost:3000.
2. Pick a domain, a model and a harness. The default is Research · Claude Sonnet 5 · Hermes Agent.
3. Open **Coding · Claude Sonnet 5 · Petri harness v1** to see the real tree.
4. Use the **Tree | Stats** switch to change the view.

The Petri harness tree comes from the engine in `petri/`. The page runs `petri export`
and `petri digest` on every request. The other trees are showcase trees. They show how
other domains could look. Nobody measured them.

### The engine

```bash
cd petri
pnpm install
pnpm typecheck       # no output means it passed
pnpm test            # 100 tests
pnpm petri tree      # the whole tree, rejected branches included
pnpm petri digest    # what the next agent reads before it proposes a change
pnpm petri dead-ends # every rejected version with its reason
```

---

## The recorded tree

`petri/.petri/` holds 16 versions: 3 accepted, 2 rejected and 11 pending. Each version
and each verification is one signed line in `petri/.petri/log.jsonl`, and the statuses
are computed from those lines. Each line carries a hash of the line before it, so Petri
refuses a log with an edited line or a gap.

| Version | Status | What it tried |
|---|---|---|
| `0a54718a` | pending (the start) | Single-shot prompt, no retry. 5 of 20 tasks. |
| `ecc7cdb0` | accepted, +7000bp | Full symbol signatures and one worked example. 19 of 20 tasks. |
| `872aaa3d` | rejected, -7000bp | Removing the signatures and the example again |
| `ea3b7532` | accepted, +7000bp | Restoring them, one step after the rejected version |
| `f07e0c55` | rejected, -7000bp | Trimming the prompt again to save tokens |
| `92dc9c49` | accepted, +7000bp | Restoring the signatures after the trim |
| `ec1d39e6` | pending, 1 of 2 keys | An independent re-test of signatures and example, +7000bp so far |
| `e1adae18` | pending, 1 of 2 keys | A short prompt without the reply-shape block, -7000bp so far |
| `2e7f6b5b` | pending, not scored | Stating every prompt rule as a positive directive |
| 7 more | pending, not scored | Changes stopped by a guard or by the typecheck |

All scores are from **replay mode**. Replay runs recorded model answers through the real
sandbox, and the tests really run. It does not call a model.

---

## Demo: a second key accepts a version

`ec1d39e6` has 1 verification. One more verification from a different key accepts it.

1. Open http://localhost:3000/tree/coding--petri-harness-v1--claude-sonnet-5.
2. Find "An independent re-test confirms…". It shows `1 of 2 keys`.
3. Run the second verification:

   ```bash
   cd petri
   PETRI_HOME=~/petri-demo-keys/k3 pnpm petri verify ec1d39e6
   ```

4. Refresh the page. The version is now accepted and shows purple.

`~/petri-demo-keys/` exists on the machine that built this tree only. On another machine,
create a new key first. Any key that is not the author's key works:

```bash
PETRI_HOME=~/my-verifier pnpm petri id create --label verifier
PETRI_HOME=~/my-verifier pnpm petri verify ec1d39e6
```

To reset the tree after a demo:

```bash
git checkout -- petri/.petri
git clean -fd petri/.petri
```

---

## ENS: every version is a name on ENSv2

Every tree, every version and every check is a real subname on ENSv2 (Sepolia), under `petri.eth`.
A tree is domain × harness × model, and its name reads the same way, leaf first. Under each tree
are three folders. A version lives in the folder that matches its status, and the platform moves
it when the status changes.

```
petri.eth
│
├─ coding.petri.eth
│  └─ petri-harness-v1.coding.petri.eth
│     └─ claude-sonnet-5.petri-harness-v1.coding.petri.eth         the tree
│        │   petri.v1 … petri.v18 = the version ids
│        │
│        ├─ accepted.…    v1 (baseline)  v2  v8  v13  v15
│        ├─ rejected.…    v3  v14
│        └─ pending.…     v4  v5  v6  v7  v9  v10  v11  v12  v16  v17  v18
│
└─ research.petri.eth
   └─ hermes-agent.research.petri.eth
      └─ claude-sonnet-5.hermes-agent.research.petri.eth           the tree (example data)
         ├─ accepted.…    v1 (baseline)  v2  v3  v5  v8  v10
         ├─ rejected.…    v4  v6  v7  v11  v13
         └─ pending.…     v9  v12
```

`v<n>` counts versions in log order, so a number never changes. The tree name holds
`petri.v<n>` = the version id, so anyone can look a number up. The baseline `v1` sits in
`accepted`, because every other version is measured against it.

### The records of a version

For example `v2.accepted.claude-sonnet-5.petri-harness-v1.coding.petri.eth`:

| Key | Value |
|---|---|
| `description` | The hypothesis, in the standard key, so any ENS app shows it |
| `petri.id` | The version id (SHA-256 of its manifest) |
| `petri.parent` | The parent version id. Empty on the baseline. |
| `petri.status` | `accepted`, `rejected`, `pending` or `baseline` |
| `petri.score` | `19/20`: tasks passed, median of 5 runs |
| `petri.delta` | `+7000bp`: the change against the parent, measured by other keys |
| `petri.verifier.1`, `petri.verifier.2` | The two keys that re-ran it and counted |
| `petri.cost` | `1141 tokens/task`, so the trade-off is on chain next to the gain |

### A pending version in a round

Only a pending version has names under it. When it is submitted, the platform opens one round:

```
v18.pending.…                              the encrypted files: petri.doc.<file>
└─ round.v18.pending.…                     open 5 minutes · the pool · the random seed
   ├─ verifier1.round.v18.pending.…        owned by the verifier's wallet · sealed file key · vote
   └─ verifier2.round.v18.pending.…
```

1. Anyone with a wallet joins the pool while the round is open. A verifier with a fresh World ID
   approval gets weight 3, without it weight 1.
2. The platform picks up to 5 verifiers at random by weight. The seed is written on the round,
   so anyone can replay the pick.
3. Each picked verifier gets a subname with the file key sealed to their key. They decrypt the
   files, run the version, and write `petri.vote` with their own wallet. Nobody else can write it.
4. The round closes. The verifier names are burned, so their keys stop resolving. The version
   moves to `accepted.…` or `rejected.…`, with the verifiers' wallets in its records.

After that, a user can pay once for an accepted version and get `buyer1.v18.accepted.…`, owned by
their wallet, with the file key sealed to them.

### Who can do what, and for how long

| Name | Who can write it | Expires |
|---|---|---|
| `petri.eth`, the domain, harness and tree names | The platform wallet only | 1 year, renewable |
| `accepted`, `rejected`, `pending` | The platform wallet only | 1 year |
| A version, `v2.accepted.…` | The platform wallet only | 1 year |
| `round.v18.pending.…` | The platform: the pool and the seed | 5 minutes after it opens |
| `verifier1.round.…` | Owned by the verifier's wallet. It alone writes `petri.vote`. It cannot be transferred. | 10 minutes after the pick |
| `buyer1.v18.accepted.…` | Owned by the buyer's wallet. It cannot be transferred. | 30 days |

Every name is registered with no roles, so nobody can transfer it. Every registry names its parent
(`setParent`), and the ENSv2 Universal Resolver walks from `petri.eth` down.

### Run it

```bash
npm run ens:setup       # once: resolver, the petri.eth registry, register petri.eth
npm run ens:tree        # both trees: names, folders, versions, records. Safe to re-run.
npm run market:smoke -- ae0acec3   # one full round on Sepolia: submit, join, pick, vote, close
```

Each needs `PETRI_ENS_PRIVATE_KEY` in `.env.local`, and Sepolia ETH on that wallet. `ens:tree`
writes only what differs from the chain, and moves a version whose status changed.

### The explorer

[explorer.ens.dev](https://explorer.ens.dev/petri.eth) shows the owner, resolver and records live
from the chain. Its subname lists and history come from an indexer, `staging-graphql.ens.dev`.
On 2026-09-26 that indexer stopped at Sepolia block 11787289 (16:11 UTC), before `petri.eth` was
registered, so those two parts stay empty until it restarts. The tree page on this site reads every
name through the Universal Resolver and does not depend on it.

The full guide, with the API and every file, is `lib/ens/README.md`.

---

## World ID after each verification

After `petri verify` signs a report, it can check the verifier with World ID. The check
is **off** by default.

```bash
PETRI_WORLD_ID=1 PETRI_WORLD_ADDRESS=0xYourAgentWallet \
  PETRI_HOME=~/my-verifier pnpm petri verify <node>
```

1. The check looks up the wallet in World AgentBook on World Chain.
2. It records the anonymous human id, or the reason there is none, in
   `.petri/world-checks.jsonl`.

The lookup has run against World Chain. Two limits stay:

- The check does not yet prove that the wallet belongs to the key that signed the report.
- It does not change the acceptance rule. A report without a human id still counts.

To register a wallet in AgentBook, run `npm run world:agentkit -- 0xYourAgentWallet`. The web
flows at `/world` (IDKit Selfie Check, World ID for Agents) are explained in `lib/world/README.md`.

---

## Add a new version

```bash
cd petri
MODE=replay ./demo/positive-prompt.sh
```

The script proposes a change under `ecc7cdb0` and submits it. In replay mode the change
passes the guards and the typecheck. It is recorded as `not-scored`, because replay holds
recorded answers for 2 harness versions only.

A live run can score a new harness. It needs `ANTHROPIC_API_KEY`:

```bash
ANTHROPIC_API_KEY=... ./demo/positive-prompt.sh
```

The live path has not been run on this tree yet.

---

## What the sandbox enforces

- The harness runs in a child process under Node `--permission`. It can read the prompt
  and the harness files only. It cannot read the tests.
- The generated solution runs in a second child process. The test source is never written to disk.
- A patch that changes more than 2 files or 120 lines, or changes `harness/contract.ts`, is refused.
- `petri verify` refuses a version that was never scored.

## What this does not prove

- **A verifier can sign without running the benchmark.** Nothing compares result hashes
  across verifiers yet.
- **Distinct keys are not distinct people.** One person can create many keys. The World ID
  check is off by default, and it does not yet link a wallet to a signing key.
- **The log is one file on one machine.** Its hash chain catches an edited line or a gap.
  Nothing outside this machine records when each line was written, and the log does not
  show that the benchmark really ran.
- **Replay covers 2 harness versions.** A new harness needs a live run to get a score.
- **The benchmark is 20 tasks.** A gain here may not carry over to other work.
- **Live mode is not deterministic.** The median of 5 runs reduces noise. It does not remove it.

---

## Repository layout

| Path | What it holds |
|---|---|
| `app/`, `components/`, `lib/*.ts` | The Petri web app (Next.js) |
| `lib/showcase.ts` | The showcase trees for other domains |
| `lib/ens/` | ENSv2: each version's name, its text records, and the reader. See `lib/ens/README.md`. |
| `app/ens/`, `app/api/ens/` | The ENSv2 playground on Sepolia, and the ENS API. See `app/ens/README.md`. |
| `scripts/ens-publish.ts` | Writes the records to the resolver on `petri.eth` (`npm run ens:publish`) |
| `lib/world/` | World: IDKit Selfie Check, World ID for Agents, AgentKit AgentBook. See `lib/world/README.md`. |
| `app/world/`, `app/api/world/` | The `/world` page and the World API |
| `scripts/world-agentkit.ts` | Registers an agent in AgentBook (`npm run world:agentkit`) |
| `petri/` | The engine: CLI, benchmark, harness, recorded tree. See `petri/README.md`. |
| `petri/SPEC.md` | The contract for hashing, signing, the acceptance rule and the CLI |
| `petri/src/consensus/local.ts` | The local log and its hash chain |
| `petri/src/trust/world.ts` | The World ID check after `petri verify` |
| `petri/demo/verify-demo.sh` | The stage demo: verify, then a World ID Selfie Check at `/world` |
