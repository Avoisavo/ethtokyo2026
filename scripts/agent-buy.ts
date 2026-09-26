/**
 * An agent buys a version over x402, with Intercepta in the payment path:
 *
 *   npm run agent:buy -- v15            the honest seller: every check passes, and it pays
 *   npm run agent:buy -- v15 rogue      a seller whose wallet Intercepta flags: stopped before signing
 *   npm run agent:buy -- v15 greedy     a seller that asks too much: stopped by Petri's own limit
 *
 * It asks the web app (npm run dev) to run the Petri agent once against the
 * honest seller of the version's file: the 402 with the price, Petri's own
 * limits, Intercepta Quick Scan on the seller's wallet, Intercepta Scan
 * Message on the exact EIP-712 authorization, the signature, and the
 * settlement in Circle USDC on Sepolia. Then it saves the file it bought.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { versionLabels } from "@/lib/ens/name";
import data from "@/lib/snapshot/petri-export.json";
import type { ExportNode } from "@/lib/types";

const WEB = process.env.PETRI_WEB_URL ?? "http://localhost:3000";
const B = "\x1b[1m", D = "\x1b[2m", G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", X = "\x1b[0m";
const mark = (s: string) => (s === "pass" ? `${G}✓${X}` : s === "fail" ? `${R}✕${X}` : s === "hold" ? `${Y}!${X}` : `${D}·${X}`);

async function main() {
  const want = (process.argv[2] ?? "v15").split(".")[0]!;
  const nodes = (data as { nodes: ExportNode[] }).nodes;
  const labels = versionLabels(nodes);
  const node = nodes.find((n) => labels.get(n.id) === want || n.id.startsWith(want));
  if (!node) { console.error(`No version ${want}.`); process.exit(2); }
  const label = labels.get(node.id)!;
  const seller = ["rogue", "greedy"].includes(process.argv[3] ?? "") ? process.argv[3]! : "honest";

  console.log(`${B}agent buys ${label} from the ${seller} seller${X} · x402 · Circle USDC on Sepolia · screened by Intercepta\n`);
  console.log(`${D}POST ${WEB}/api/intercepta/pay  {versionId: ${node.short}, product: markdown, verifier: ${seller}}${X}`);
  const t0 = Date.now();
  const res = await fetch(`${WEB}/api/intercepta/pay`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ versionId: node.id, verifier: seller, mode: "screened", product: "markdown" }),
  }).catch((e: Error) => { console.error(`The web app did not answer at ${WEB}. Run npm run dev. (${e.message})`); process.exit(1); });
  const body = (await res.json()) as { ok: boolean; detail?: string; record?: Record<string, any> };
  if (!body.ok || !body.record) { console.error(`${R}Refused:${X} ${body.detail ?? res.status}`); process.exit(1); }
  const r = body.record;

  if (r.requirements) {
    const q = r.requirements;
    console.log(`\n${B}1. the seller answers 402${X}`);
    console.log(`   price    ${Number(q.amount) / 1e6} USDC`);
    console.log(`   pay to   ${q.payTo}`);
    console.log(`   lifetime ${q.maxTimeoutSeconds} s`);
  }
  console.log(`\n${B}2. the checks before any signature${X}`);
  for (const c of r.decision?.checks ?? []) console.log(`   ${mark(c.status)} ${c.label}${D} · ${c.detail}${X}`);
  for (const call of r.intercepta ?? []) console.log(`   ${D}intercepta ${call.endpoint} · ${call.ok ? "answered" : "failed"} in ${call.latencyMs} ms${call.cached ? " (cached)" : ""}${X}`);
  console.log(`\n${B}3. the decision${X}  ${r.decision?.action === "pay" ? G : R}${r.decision?.action ?? "none"}${X}${D} · ${r.decision?.code ?? ""}${X}`);
  console.log(`   signed ${r.signed ? "yes" : "no"} · sent ${r.sent ? "yes" : "no"}`);

  const s = r.verifierReply?.settlement;
  if (s?.transaction) console.log(`\n${B}4. settled on Sepolia${X}  https://sepolia.etherscan.io/tx/${s.transaction}`);
  if (r.delivered) {
    const dir = path.join(process.cwd(), "bought");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${label}-${r.delivered.file}`);
    writeFileSync(file, r.delivered.markdown);
    console.log(`\n${B}5. the file${X}  ${r.delivered.file} · ${r.delivered.bytes} bytes → ${path.relative(process.cwd(), file)}`);
    console.log(`${D}${r.delivered.markdown.split("\n").slice(0, 8).join("\n")}${X}`);
  }
  console.log(`\n${r.outcome === "paid" ? G : Y}${r.outcome}${X} in ${((Date.now() - t0) / 1000).toFixed(1)} s · every attempt is on ${WEB}/intercepta`);
  if (r.error) console.log(`${R}${r.error}${X}`);
}
main();
