# ENSv2 Playground

One page for trying ENSv2 on **Sepolia**: register a `.eth` name, set records, create subnames, manage who can
do what with access-control policies and groups, and set your primary name.

> The ENSv2 contracts are **not final** and may change before mainnet. Addresses and ABIs are pinned to
> `ensdomains/contracts-v2@71a3b73`, the deployment the [ENS docs](https://docs.ens.domains/ensv2/overview) list.

## Run it

It lives at `/ens` in this app.

```bash
npm install
npm run dev            # http://localhost:3000/ens
```

You need a browser wallet (MetaMask, Rabby, …) on Sepolia with a little Sepolia ETH for gas. Registration fees
are paid in test USDC, which you can mint for free on the page.

Optional: put `NEXT_PUBLIC_SEPOLIA_RPC_URL=...` in `.env.local` to use your own RPC.

## What's on the page

1. **Get ready**: mint test USDC and deploy your own resolver (one per account; it holds your records).
2. **Register a .eth name**: price check, approve USDC, commit, wait ~1 minute, register.
3. **Your name**: status, owner, expiry, renew, point it at your resolver, set ETH address and text records.
4. **Subnames**: deploy a subname registry for your name and create subnames (`alice.yourname.eth`).
5. **Access control**:
   - *Policies* are named sets of permissions on a target: a name, your resolver (records), or a name's
     subname registry. Resolver policies can be limited to a single text key (e.g. only `avatar`).
   - *Groups* are named lists of addresses.
   - Grant or revoke a policy for a group (or one address) and see each member's current permissions.

   ENSv2's Enhanced Access Control stores roles per account on-chain; it has no built-in groups. Policies and
   groups are saved in your browser, and granting sends one transaction per member.
6. **Primary name**: set the name shown for your address (it must resolve back to your address).
7. **Look up**: resolve any name or address through the ENSv2 Universal Resolver.
8. **Publish the Petri tree**: write each tree version's record as text records on its name
   (`addsigs.petriharnessv1.petri.eth`, …). One resolver on `petri.eth` serves every version, so set it up
   first: deploy your resolver (1), register `petri.eth` (2) and point it at your resolver (3). The card shows
   how many records differ from ENS and sends only those, up to 60 per transaction. `npm run ens:publish` does
   the same from a terminal (see the root README).

To try access control end to end, use two wallets: grant a policy to the second wallet, switch to it, and make
the change it was granted (for example, edit a text record in section 3).

## Layout

```
app/ens/page.tsx                    The page
app/ens/layout.tsx                  Wallet providers, the Connect bar, and the .ens-app wrapper
app/ens/ens.css                     Tailwind for this route only, scoped to .ens-app
app/ens/_components/playground/     One component per section
app/ens/_components/                Shared UI (buttons, cards, transaction status, faucet)
app/ens/_lib/wagmi.ts               Wallet / chain config (Sepolia only)
app/ens/_lib/ens/                   ENSv2 helpers: addresses, ABIs, roles, names, factory, access-control catalog
app/ens/_lib/hooks/                 useTx, useMyResolver, useNameInfo, …
app/ens/_lib/relay/                 Keyless relay bundles and tokens (npm run test:ens)
scripts/gen-ens-abis.mjs            Regenerates app/ens/_lib/ens/abis + deployments.ts (npm run gen:ens-abis)
scripts/ens-publish.ts              Writes the Petri tree's records to petri.eth's resolver (npm run ens:publish)
app/api/ens/plan/route.ts           The names and records to publish, for section 8
app/api/ens/records/route.ts        Each version name's text records, for the tree page
lib/ens/                            Version names, the record schema and the resolver reader
```

How the Petri tree uses ENS (names, records, publishing) is in `lib/ens/README.md`.

Folders starting with `_` are private in the App Router: they hold code, not routes.
