import type { Metadata } from "next";

import { getConfig } from "@/lib/world/idkit/config";
import { getAgentConfig } from "@/lib/world/agent/config";

import AgentFlow, { type AgentPageConfig } from "./agent-flow";
import WorldFlow from "./world-flow";
import s from "./world.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "World ID · Continuity Track",
  description:
    "Left: IDKit Selfie Check gating a withdrawal. Right: World ID for Agents approving an agent's payment.",
};

export default function WorldPage() {
  // Only names and non-secret values cross to the client. Signing keys and
  // client secrets stay in lib/.
  const result = getConfig();
  const config = result.ok
    ? {
        ok: true as const,
        appId: result.config.appId,
        rpId: result.config.rpId,
        action: result.config.action,
        environment: result.config.environment,
        proofVersion: result.config.proofVersion,
      }
    : { ok: false as const, missing: result.problems.map((p) => `${p.name}: ${p.issue}`) };

  const agent = getAgentConfig();
  const agentConfig: AgentPageConfig = agent.ok
    ? { ok: true, clientId: agent.config.clientId, issuer: agent.config.issuer }
    : { ok: false, missing: agent.problems.map((p) => `${p.name}: ${p.issue}`) };

  return (
    <main className={`container container-wide ${s.page}`}>
      <header className={s.pageHead}>
        <h1>World ID · Continuity Track</h1>
        <p className={s.lede}>
          Left, sections 1–5: Best IDKit Use Case. Right, sections 6–11: Best Use of World ID for Agents. Each section
          shows its own status.
        </p>
      </header>
      <div className={s.columns}>
        <WorldFlow config={config} />
        <AgentFlow config={agentConfig} />
      </div>
    </main>
  );
}
