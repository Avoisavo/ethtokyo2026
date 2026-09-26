# Petri explainer page: the edits for ETHGlobal Tokyo 2026

This is the brief for the one-page explainer at
https://claude.ai/code/artifact/2fb48893-239c-4553-a74c-dd88112e6bcc.
Give this whole file to the AI that edits the page. It keeps the page's style
(the same fonts, colours, SVG line style and small "micro" pictures) and changes
the content below, in page order.

Rules for the editor:
- Keep the existing CSS tokens, fonts and SVG classes. Every new picture uses the
  same stroke widths, the same `--pass` purple and `--fail` red, and the same
  small mono labels as the pictures that exist.
- Every new section gets micro pictures in the same style as "The problem" and
  "The loop": small SVG panels, 200×142 or 200×120 viewBox, one idea each.
- Simple English. One idea per sentence. No jokes.
- Numbers in the pictures are examples unless the text says they are real.

---

## 1 · Header

Change:
- Eyebrow right: `ETHGlobal Online 2026` → `ETHGlobal Tokyo 2026`
- Tagline → **Darwinian evolution for AI agent harnesses.** Versions mutate
  strangers test them, and only checked winners survive. **Failed versions stay
  forever**, so nobody repeats them.
- Add one small line under the tagline, in `.lede` style:
  *A harness is the code around a model: the prompt, the retry loop, the context it reads.*

Keep the big tree picture and its legend.

---

## 2 · The problem (rewrite as a blocked flow)

Eyebrow: THE PROBLEM. Title: **Nothing flows from one agent builder to the next**

Replace the three boxes with ONE wide picture (`.plate.wide`, viewBox 1000×220):
a flow from left to right with a red wall before each arrow.

```
[ idea ]  ─┃─>  [ score ]  ─┃─>  [ other people ]  ─┃─>  [ next builder ]
           1                 2                       3
```

- Each box is a `.prob-card` rectangle with a mono label.
- Each wall is a thick red bar (`fill: var(--fail)`) with a small lock on it, the
  same lock as the old "Team A / Team B" picture.
- The arrows are `.prob-stroke` with a `.prob-head`.

Under the picture, three `.prob-panel` items with a micro picture each (200×142):

| # | Micro picture | Label | Line |
|---|---|---|---|
| 1 | The old "blog post → agent → score ?" picture. Keep it. | Nobody measures | An idea ships with no score. "Feels better" is the only number. |
| 2 | The old "laptop +20% in a locked box, a person outside with ?" picture. Keep it. | Nobody can check | A score on your own laptop proves nothing to anyone else. |
| 3 | The old "Team A March / Team B May, both fail, a wall between" picture. Keep it. | Nobody shares the failures | The dead ends stay in one terminal. The next team pays for the same mistake. |

Caption: *Three walls. Petri removes each one with a rule, not a promise.*

---

## 3 · The mechanism

Keep the whole section: the three Darwin panels and the bacteria table.

---

## 4 · NEW · The people (World ID)

Insert AFTER "The mechanism" and BEFORE "The record".

Eyebrow: THE PEOPLE. Title: **One human, one voice**

Lede: *Two roles need trust: the one who submits, and the ones who check. World ID answers one question for each: is this one human, right now? It never learns who.*

Use the `.loop-board` layout (six frames with a micro picture and text). Six frames:

| # | Micro picture (200×120) | Name | Line |
|---|---|---|---|
| 01 | A person icon (the `.loop-person` head and shoulders), a small phone next to it with a face outline and a check mark in `--pass`. Under it, mono label `1 human`. | Submit for free | Prove you are one human with World ID Selfie Check. 3 free submits a day per human. |
| 02 | The same person, but the phone shows an ✕ in `--fail`. Next to it a coin with `5 USDC` in mono. An arrow from the coin to a small pool of three small circles. | No World ID? Stake | Stake 5 USDC instead. The checkers share it. |
| 03 | A clock with a small slice (reuse the clock from the bacteria table, slice in `--pass`), mono label `5 min`. To the right, five small hollow circles in a row: the pool. | A round opens | Any wallet joins the pool. The round stays open for 5 minutes. |
| 04 | Two wallets side by side. Left: a small person-with-phone-check above it, and three purple bars under it. Right: no phone, one grey bar. Mono labels `×3` and `×1`. | Fresh approval counts more | A checker whose agent gets a fresh human approval (World ID for Agents) joins with weight 3. Without it, weight 1. |
| 05 | A row of five hollow circles. Two are filled `--pass`. Above them a dice-like square with mono `seed 0x58b3…`. | Picked at random | Up to 5 are picked by weight. The seed is written down, so anyone can replay the pick. |
| 06 | A phone with an ✕ in `--fail`, a person icon, and a dashed line to the pool that stops at a small red bar. | No approval, no join | The human cancels, or the approval expires. The agent is not in the pool. |

Caption: *World ID Selfie Check answers "how many times has this human done this". World ID for Agents answers "did a human say yes just now".*

---

## 5 · The record

Keep "What one node holds". Two small changes:

- Add one row to the card, after RESULT and before CHECKERS:
  `FILES` · `harness.md  prompt.ts  loop.ts  recovery.ts …` · then a small lock icon and the mono word `encrypted` in `--ink-faint`.
- Caption → *One node: the change, the guess, the score, two signatures, and the files nobody outside the round can read.*

---

## 6 · NEW · The names (ENSv2)

Insert AFTER "The record" and BEFORE "The loop".

Eyebrow: THE NAMES. Title: **Every version, round and checker is an ENS name**

Lede: *ENSv2 on Sepolia holds the rights. A right is a subname. It can expire, and it cannot be moved.*

Picture 1, a wide plate: the name tree, drawn in the same style as the big tree
at the top (edges `.edge`, circles `.n-fill` and `.n-hollow`, mono labels).
Draw it as a tree, left to right, with the text next to each node:

```
petri.eth
└─ petriharnessv1-claudesonnet5-coding.petri.eth   the tree · petri.v1 … petri.v18 = version ids
   └─ v18.…                                        a version · 20 records + the encrypted files
      ├─ v18-1.v18.…                               its round · status, pool, seed, closes at
      │  ├─ k1.v18-1.v18.…                         a picked checker · sealed key, vote · expires
      │  └─ k2.v18-1.v18.…
      └─ buyer-1.v18.…                             a buyer · sealed key
```

Caption: *Real subnames in ENSv2 registries, not wildcards. The Universal Resolver walks the tree from petri.eth down.*

Then three `.panel` items with micro pictures (200×120):

| # | Micro picture | Heading | Line |
|---|---|---|---|
| 1 | A name card (`.trust-box`) with mono `k1.v18-1…` on it. Inside: a small key icon, and the word `sealed`. A small clock in the corner with mono `expires`. A grey arrow trying to leave the card, stopped by a small red bar (cannot transfer). | Access is a subname | The checker's name holds the file key, sealed to their browser key. The name expires when the vote window ends. It holds no roles, so it cannot be transferred. |
| 2 | The same name card. One row on it: `petri.vote = yes`. A small person-and-key icon writes into that row with a purple check. A second person tries and gets a red ✕. | A vote only its owner can write | Enhanced Access Control gives the checker one right: write `petri.vote`. The close takes it back and burns the name. |
| 3 | A version card `v18.…` with three rows of grey ciphertext bars and a lock. Next to it a coin `1 USDC` and an arrow to a new small card `buyer-1` with a key on it. | The files never leave the chain | The ciphertext sits in the version's records. Pay 1 USDC once, and a buyer name holds the key for you. |

Under the panels, a small `.slab` code block with the real records of one checker name:

```
k1.v18-1.v18.petriharnessv1-claudesonnet5-coding.petri.eth
petri.wallet       0x1f4e…9c2a
petri.access-key   0x02a7…44e1
petri.key          A3t9…   (the file key, sealed to that access key)
petri.vote         yes:+7000bp
expires            when the vote window ends
```

---

## 7 · The loop

Keep the six frames. Change three:

| Step | Name | Line |
|---|---|---|
| 04 | Send it in | World ID for free, or stake 5 USDC. You can't check your own. |
| 05 | Picked checkers run it | Up to 5, chosen at random. Each reads the files, runs old and new, then writes a vote with their own wallet. |
| 06 | The round closes | Pass or fail, it stays. Checker names burn. Access closes. |

Micro picture changes:
- 04: keep the key-that-cannot-sign picture. Add a small phone with a check in the top right corner.
- 05: the two people (B and C) become up to five small person icons in a row, two filled. Keep the old/new bars for the first two.
- 06: keep the passed/failed picture. Add a small burned name card at the bottom: a card with mono `k1…` and a dashed outline (`.evo-ghost`).

Caption stays: *Every change takes the same six steps. Numbers are examples.*

---

## 8 · The limits

Keep the box. Add three lines at the end:

- **The ciphertext stays on Sepolia forever.** A checker or buyer who leaks the key leaks the files. Pay-per-use is a promise, not an enforcement.
- **The vote right is per text key, not per name.** During the window, a checker could write `petri.vote` on another name. The close revokes it.
- **The pick runs on our server.** The seed is public, so anyone can replay it. Nobody can stop the server from choosing when to close.

---

## 9 · NEW · What happened on Sepolia (small, before the footer)

Eyebrow: THE PROOF. Title: **This ran for real**

A `.slab` block:

```
petri.eth            registered · 1 resolver · 3 registries
versions             v1 … v18 · 328 records on chain
one round on v18     submit 3 txs · join 1 · pick 4 · vote 1 · close 3
after close          the sealed key is gone · petri.access = closed
```

Caption: *Every line above is a Sepolia transaction. The demo replays it live.*

---

## 10 · Footer

`ETHGlobal Tokyo 2026 · Continuity track · ENSv2 on Sepolia · World ID`
