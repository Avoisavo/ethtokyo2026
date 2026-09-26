# Continuity track plan: ENSv2 + World ID on Petri

This file holds the full plan and every decision made so far. A new AI session
reads this file first, then continues the work. Written 2026-09-27.

## Prizes we enter (ETHGlobal Tokyo 2026, Continuity Track)

| Prize | Amount | What it needs |
|---|---|---|
| ENS: Best Integration of ENSv2 into an Existing Project | $4,000 | ENSv2 on Sepolia is a real part of the product. Live demo link. Open source. |
| World: [Cont] Best IDKit Use Case | $2,500 | One real trust moment, the right credential, server-side verify, a failed path, and a debrief. |
| World: [Cont] Best Use of World ID for Agents | $2,500 | An agent action that runs only after a fresh human approval. A denied path. A debrief. Proofs are mocked at this event. |

A project can enter World, ENS and one more sponsor. We do World and ENS first.

## Rules from the user

- Everything in this repo is committed and pushed as **JingYuan0926**. Do not use the Avoisavo key here.
- Write in Simplified Technical English. One idea per sentence. Active voice. Simple words.
- Never commit `.env.local` or `petri/.env`.
- Sepolia and test USDC are fine. The judges said so.
- Keep it simple. It is a hackathon. Do not add extra features outside the mechanism.

## The mechanism (from the judges' feedback)

**Submitting a version**
1. A submitter with World ID submits for free, under a rate limit. The platform's verifier pool checks it.
2. A submitter without World ID stakes test USDC. The chosen verifiers share the stake.

**A verify round**
3. A round opens for 5 minutes. Up to 5 verifiers join.
4. When it closes, the platform picks verifiers **at random** from the pool. A verifier with a fresh World ID approval has a higher weight. This makes collusion harder.
5. Each verifier has a reputation score from past rounds.

**Access to the harness files (ENSv2)**
6. The harness markdown files (the 9 parts below, plus any other `.md`) are encrypted. The ciphertext goes into the version's text records.
7. A chosen verifier gets their own subname under the round. They sign with their wallet. The platform encrypts the file key to that wallet's public key and writes it to the verifier's text record.
8. The verifier decrypts and reads the files. They write their vote, yes or no, to a text record that only they can write.
9. When the round ends (accepted, rejected or expired), the platform revokes every verifier subname. Access is closed.

**Using an accepted harness**
10. A user pays once in test USDC. They get their own subname with the file key encrypted to their wallet. The payment goes to the platform and the submitter.

The 9 harness parts: instructions, tools, the loop, context management, memory,
recovery, limits, output checking, logging.

## ENS names and records

Parent: `petri.eth` on Sepolia. The server wallet owns it, one UserRegistry and one
PermissionedResolver. Labels cannot hold spaces, dots or `×`, so the tree name is
a plain label.

| Name | What | Records |
|---|---|---|
| `petri.eth` | the platform | |
| `petriharnessv1-claudesonnet5-coding.petri.eth` | the tree "Petri harness v1 × Claude Sonnet 5 (Coding)" | `petri.tree`, `petri.v1` = the root version id, so anyone can see which version `v1` is |
| `v3.petriharnessv1-claudesonnet5-coding.petri.eth` | one version. `v1` is the root. Numbers follow log order. | the 20 records in `lib/ens/records.ts`, plus `petri.doc.<file>` (encrypted), `petri.doc.hash`, `petri.submit` (`free` or `stake:USDC:5`), `petri.access` (`open` or `closed`) |
| `v3-1.v3.petriharnessv1-claudesonnet5-coding.petri.eth` | the verify round of `v3` (`v3.1` in the UI) | `petri.round.until`, `petri.round.status`, `petri.round.pool`, `petri.round.seed` |
| `k3.v3-1.v3.petriharnessv1-claudesonnet5-coding.petri.eth` | one chosen verifier. Non-transferable (roleBitmap 0). Expires at `round.until`. | `petri.key` (file key encrypted to their wallet, the platform writes it), `petri.vote` (only this verifier can write it, through a key-scoped EAC role) |
| `buyer-1.v3.….petri.eth` | one buyer | `petri.key` |

Close: `unregister` each verifier subname, then `linkToRecord(name, 0)` so the old
records stop resolving through the parent resolver. Set `petri.access` = `closed`.

## World ID choices

| Flow | Trust moment | Credential | Failed path |
|---|---|---|---|
| IDKit | Submit a version for free | Proof of Human. One nullifier per human per action, which the rate limit needs. Selfie Check is not needed and the simulator cannot test it. | No World ID: the submitter must stake USDC. |
| World ID for Agents | A verifier's agent joins a round | The event's dev environment (`sandbox.auth.world.org`). Fresh approval raises the pick weight. | Cancelled or expired approval: the agent is not in the pool. |

## Known limits to write in the README

1. The encrypted files stay on Sepolia forever. A verifier or buyer who leaks the key leaks the files. Pay-per-use is a promise, not an enforcement.
2. The random pick runs on our server, not on chain. The server writes the seed and the pool to the round's text records, so anyone can replay it.
3. Selfie Check works only on protocol 3.0 today (see FEEDBACK.md).

## State right now

- `petri.eth` is **free** on Sepolia. Nobody registered it. Checked 2026-09-27.
- Server wallet: `0xF1122BbDb1970aF6eb04a5B43e3864193f050c06`. It holds 1 Sepolia ETH. Its key is `PETRI_ENS_PRIVATE_KEY` in `.env.local`. `NEXT_PUBLIC_PETRI_ENS_ADDRESS` holds the address.
- `main` is pushed to GitHub (28d7a0b).
- No World app values are in `.env.local` yet. The teammate's app is `app_3e8f709b907e4985aab5fa3b28269b00`, RP `rp_e4636b70dd1ec3a9`, action `continuity-gate` (see FEEDBACK.md). Its signing key must be pasted by the user.

## What exists already (do not rebuild)

- `lib/ens/`: version names (old label scheme, to be replaced by `v<n>`), the 20-record schema, the Universal Resolver reader. `app/api/ens/records` and `app/api/ens/plan`.
- `app/ens/`: the playground. It has working code for deployProxy (resolver and UserRegistry), commit/register, setSubregistry, UserRegistry.register, EAC grants and `grantSetterRoles`.
- `scripts/ens-publish.ts`: writes records with `PETRI_ENS_PRIVATE_KEY`.
- `lib/world/idkit/`: Selfie Check with server verify. `lib/world/agent/`: World ID for Agents OIDC device flow, with a forged-token refusal. `lib/world/agentkit/`: AgentBook lookup.
- `app/world/`: the two World flows. Their stories are "withdraw" and "send 25 USDC". They must point at the mechanism above.
- `lib/ens/README.md`, `lib/world/README.md`, `app/ens/README.md`, `FEEDBACK.md`.

## ENSv2 facts (checked against the deployed bytecode, contracts-v2@71a3b73)

- `PermissionedResolver.setText(bytes name, string key, string value)`. The name is DNS-encoded bytes, not a namehash. The docs page shows `bytes32`, which is wrong for this deployment.
- `UserRegistry.register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry)`. The caller needs `ROLE_REGISTRAR`. `roleBitmap = 0` makes the subname non-transferable. `expiry` is absolute unix time.
- `unregister(uint256 labelhash)` burns the subname. Then call `resolver.linkToRecord(dnsName, 0)`, or the old records still resolve through the parent's resolver.
- `linkToNode(bytes sourceName, bytes32 targetNode)` makes an alias (for `best.petri.eth`).
- Registration: commit, wait 60 s, register. Minimum 28 days. Paid in MockUSDC (`mint` is open). ETH is not accepted. About 8 USDC for a 1-year name.
- Always pass the labelhash as the id. Token ids change on every role change.
- viem 2.35+ resolves ENSv2 names on `sepolia` with no override.

## IDKit facts (checked against @worldcoin/idkit 4.3.0)

- Server: `signRequest({signingKeyHex, action, ttl})` from `@worldcoin/idkit/signing`. Pass `action` for a uniqueness request.
- Client: `IDKitRequestWidget` with `preset={proofOfHuman({signal})}` or `selfieCheck`. `allow_legacy_proofs` is required. Import it only from a `"use client"` component.
- Verify: `POST https://developer.world.org/api/v4/verify/{rp_id}` with the result as-is. A reused nullifier still returns 200 with "nullifier reuse". **The server must deduplicate.**
- Also check `responses[0].signal_hash === hashSignal(signal)`.
- A signal string that is `0x` + even hex is hashed as raw bytes. Any other string as UTF-8.
- The simulator supports Proof of Human on staging only. Selfie Check needs a real phone (sandbox build).
- Staging or sandbox proofs need the `x-staging-verification-token` header, from the portal MCP `set_world_id_staging_verification`.

## Build order

1. `scripts/ens-setup.ts`: one-time. Mint USDC, deploy resolver and UserRegistry, register `petri.eth`, create the tree name. Save the addresses to `lib/ens/deployment.json`.
2. Rename versions to `v<n>` in `lib/ens/name.ts`, and add the tree-level records.
3. Server: submit → encrypt the files → version subname + records. IDKit on submit, stake fallback.
4. Rounds: open, join (World ID for Agents approval), random pick, verifier subnames, vote, close.
5. Buy once.
6. Web pages for each step, on the tree page.
7. Update README.md, and the two World debriefs.
