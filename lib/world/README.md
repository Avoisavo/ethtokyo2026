# World: IDKit and AgentKit

Everything World lives in three folders under `lib/world/`, one per integration. The page is
`/world`, and the API routes are under `/api/world/`.

| Folder | Package | What it does |
|---|---|---|
| `idkit/` | `@worldcoin/idkit` | Selfie Check: a human proves they are the same person before a withdrawal |
| `agent/` | World ID OIDC (sandbox) | World ID for Agents: a human approves an agent's payment in World App |
| `agentkit/` | `@worldcoin/agentkit` | AgentBook: checks that a verified human stands behind an agent's wallet |

## Set up

Copy `.env.example` to `.env.local` and fill in the World values. Each flow reports what is
missing, so you can set up one and leave the other empty.

| Variable | Used by | Where to get it |
|---|---|---|
| `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY` | `idkit/` | developer.world.org: App overview, then World ID Configuration |
| `WORLD_ACTION`, `WORLD_ENVIRONMENT` | `idkit/` | Your choice. Never change the action once people have verified. |
| `WORLD_RP_SIGNER_ADDRESS` | `idkit/` | Optional. Catches a wrong signing key before World App does. |
| `WORLD_AGENT_CLIENT_ID`, `WORLD_AGENT_CLIENT_SECRET` | `agent/` | sandbox.auth.world.org/portal: register a confidential client |
| (none) | `agentkit/` | AgentBook is public on World Chain. No key is needed. |

```bash
npm install
npm run dev          # http://localhost:3000/world
```

## 1. IDKit: Selfie Check

The left column of `/world`, sections 1 to 5.

1. The page asks the server for a signed request: `POST /api/world/selfie-check/context`. The
   server signs it with `WORLD_RP_SIGNING_KEY` (`@worldcoin/idkit/signing`), so the key never
   reaches the browser.
2. `IDKitRequestWidget` shows a QR code. The person scans it with World App and takes the Selfie Check.
3. The page forwards the result to `POST /api/world/selfie-check/verify`. The server verifies the
   proof with the Developer Portal (v4). The same person always gets the same nullifier for this
   action, so the server can tell whether it is the person who opened the account.

`GET /api/world/selfie-check/preflight` probes the app, action and RP registration with the
Developer Portal before anyone scans, and names the fix for anything that fails.

| File | Role |
|---|---|
| `app/world/live-widget.tsx` | The IDKit widget |
| `app/world/world-flow.tsx` | Sections 1 to 5 |
| `idkit/config.ts`, `idkit/preflight.ts` | Settings, and the live checks of those settings |
| `idkit/verify.ts`, `idkit/policy.ts` | Proof verification, and the continuity and freshness rules |
| `idkit/session.ts`, `idkit/store.ts`, `idkit/types.ts` | The account cookie, saved state, shared types |

## 2. World ID for Agents

The right column of `/world`, sections 6 to 11. An agent wants to pay. A human approves in
World App, and the backend checks the approval before the agent runs.

1. `POST /api/world/agent/start` starts an OIDC device authorization. The browser gets only the
   user code and the approval link.
2. The human approves in World App with a fresh proof.
3. `POST /api/world/agent/poll` redeems the device code and validates the ID token: the RS256
   signature, issuer, audience, expiry and freshness.

`POST /api/world/agent/forged` runs the same validator on a token signed by a key the IdP
never published, to show it is refused. `POST /api/world/agent/reset`
forgets the bound owner. `GET /api/world/agent/preflight` checks the client settings.

| File | Role |
|---|---|
| `app/world/agent-flow.tsx` | Sections 6 to 11 |
| `agent/config.ts` | Settings |
| `agent/oidc.ts` | Device grant and token validation |
| `agent/store.ts` | Attempts and the bound owner |

## 3. AgentKit: AgentBook

AgentBook is a registry on World Chain (`eip155:480`). It maps an agent's wallet to the
anonymous id of the verified human who registered it.

Register an agent. The script prints a World App link. Approve it on your phone, and the script
waits until AgentBook has the wallet:

```bash
npm run world:agentkit -- 0xYourAgentWallet
```

Check an agent from the command line, or over HTTP:

```bash
npm run world:agentkit -- 0xYourAgentWallet --check
curl "http://localhost:3000/api/world/agentkit?address=0xYourAgentWallet"
# {"address":"0x…","chain":"eip155:480","registered":true,"human":"0x…"}
```

The engine uses the same lookup after `petri verify`, when `PETRI_WORLD_ID=1` is set. See
"World ID after each verification" in the root README.

| File | Role |
|---|---|
| `agentkit/world-agentkit.ts` | `createAgentBookVerifier` and the lookup |
| `agentkit/agentbook.ts` | Registration through `@worldcoin/agentkit-cli`, and polling |
| `app/api/world/agentkit/route.ts` | `GET /api/world/agentkit?address=…` |
| `scripts/world-agentkit.ts` | `npm run world:agentkit` |
| `petri/src/trust/world.ts` | The engine's check after `petri verify` |
