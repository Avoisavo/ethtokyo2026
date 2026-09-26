/**
 * Registers an agent in World AgentBook with AgentKit, so anyone can check that
 * a verified human stands behind it.
 *
 *   npm run world:agentkit -- 0xAgentAddress           register, then wait for it
 *   npm run world:agentkit -- 0xAgentAddress --check   only look it up
 *
 * Registering runs `@worldcoin/agentkit-cli register`, which prints a World App
 * link. Open it on your phone and approve with World ID. This script then polls
 * AgentBook (through `@worldcoin/agentkit`) until the address resolves to a human.
 */

import { parseArgs } from "node:util";

import { isAddress } from "viem";

import { getAgentBookVerifyLink, pollAgentBook } from "@/lib/world/agentkit/agentbook";
import { checkAgentHuman } from "@/lib/world/agentkit/world-agentkit";

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { check: { type: "boolean" } } });
  const address = positionals[0]?.trim() ?? "";
  if (!isAddress(address)) {
    console.error("Usage: npm run world:agentkit -- <agent EVM address> [--check]");
    return 1;
  }

  const human = await checkAgentHuman(address);
  if (human) {
    console.log(`${address} is registered in AgentBook. Human: ${human}`);
    return 0;
  }
  console.log(`${address} is not registered in AgentBook.`);
  if (values.check) return 0;

  console.log("Running agentkit-cli register…");
  const link = await getAgentBookVerifyLink(address, { echo: true });
  if (!link) {
    console.error("agentkit-cli printed no World App link. Run `npx @worldcoin/agentkit-cli register <address>` to see why.");
    return 1;
  }
  console.log(`\nOpen this link in World App and approve:\n  ${link}\n\nWaiting for AgentBook (up to 3 minutes)…`);
  const registered = await pollAgentBook(address);
  if (!registered) {
    console.error("Not registered yet. Approve in World App, then run this again with --check.");
    return 1;
  }
  console.log(`Registered. Human: ${registered}`);
  return 0;
}

main().then((code) => process.exit(code), (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
