import type { Metadata } from "next";

import { getConfig } from "@/lib/selfie-check/config";

import WorldFlow from "./world-flow";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "World ID · IDKit use case",
  description:
    "Selfie Check gates a withdrawal: IDKit request, server-side verification, the rejected paths, and the integration debrief.",
};

export default function WorldPage() {
  // Only names and non-secret values cross to the client. The signing key
  // stays in lib/selfie-check/config.ts.
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

  return <WorldFlow config={config} />;
}
