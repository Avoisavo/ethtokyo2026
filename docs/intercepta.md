# How Petri pays with Intercepta

Petri's agent pays other services in USDC over x402. Intercepta checks every payment before money moves.

## How it works

1. **Why scan.** An agent that can pay can be tricked into paying a scam or sanctioned wallet, signing a harmful message, or paying too much.
2. **Ask.** The agent requests something, for example a version as a markdown file.
3. **x402.** The seller answers HTTP 402: "pay 0.01 USDC to wallet X".
4. **Limits.** Petri refuses a fee over $0.50, any token other than Circle USDC, and a signature valid longer than 300 s.
5. **Scan the wallet.** Intercepta Quick Scan checks wallet X. A sanction, scam or blacklist trait rejects the payment.
6. **Scan the signature.** Petri builds the payment permission (EIP-3009), checks it matches the 402, and Intercepta Scan Message checks it.
7. **Sign.** Only when every check passes does the agent's wallet sign. If Intercepta errors or times out, the payment is held, never paid.
8. **Scan the buyer.** The seller checks the signature, then Intercepta Quick Scans the buyer's wallet before it accepts.
9. **Settle.** The seller moves the USDC on Sepolia, then sends the file or the verification report.
10. **Record.** Every attempt, blocked ones included, is one line in `petri/.petri/payments.jsonl`.

## What the agent can buy

| Product | Route | How often |
|---|---|---|
| A version as markdown | `GET /api/versions/:versionId/markdown` | Unlimited. Each purchase pays 0.01 USDC again. |
| A verification run | `POST /api/verifier/verify/:versionId` | **Once per verifier key per version.** Petri counts one report per key, so a second report from the same key would not count, and the verifier refuses before asking for money (`409 already_verified`). |

> **Demo repeat mode.** For demos, the page's "Demo: allow repeat runs" box (on by default) adds `&repeat=1`, and
> the verifier sells a run even when its key already reported. That repeat report is stored and paid for, but it does
> **not** change the version's status. In real use this is off: one run per key per version.

## Try it

`npm run dev`, then open http://localhost:3000/intercepta. The honest seller pays and settles. The rogue seller (a sanctioned
wallet) is rejected by Quick Scan. The greedy seller (0.75 USDC) is rejected by the $0.50 limit. Neither of those signs anything.

The code is `lib/intercepta/` (the Intercepta calls and the pay, hold or reject rules) and `lib/pay/` (the agent and the sellers).
