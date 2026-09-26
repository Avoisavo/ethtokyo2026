import "server-only";

/**
 * Configuration for World ID for Agents: the sandbox World ID IdP, used as a
 * confidential OIDC client through the device authorization grant.
 *
 * The device grant is the agent-shaped flow: the agent never sees a browser
 * callback, the human approves in the World ID app with a fresh proof, and the
 * backend redeems the device code. It also sidesteps the sandbox rule that
 * rejects http://localhost callbacks. A device-only client still needs one
 * registered HTTPS redirect URI, which this flow never uses.
 *
 * Client secret and device codes stay on the server. Nothing here is ever sent
 * to the browser except the client ID.
 */

export const DEFAULT_ISSUER = "https://sandbox.auth.world.org";

/** The only authentication class the IdP implements. */
export const ORB_ACR = "https://world.org/oidc/acr/orb-v3";

export type AgentConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  authMethod: "client_secret_basic" | "client_secret_post";
};

export type AgentConfigResult =
  | { ok: true; config: AgentConfig }
  | { ok: false; problems: { name: string; issue: string; fix: string }[] };

export function getAgentConfig(): AgentConfigResult {
  const problems: { name: string; issue: string; fix: string }[] = [];
  const issuer = (process.env.WORLD_AGENT_ISSUER?.trim() || DEFAULT_ISSUER).replace(/\/+$/, "");
  const clientId = process.env.WORLD_AGENT_CLIENT_ID?.trim();
  const clientSecret = process.env.WORLD_AGENT_CLIENT_SECRET?.trim();
  const rawMethod = process.env.WORLD_AGENT_AUTH_METHOD?.trim() || "client_secret_basic";

  if (!clientId) {
    problems.push({
      name: "WORLD_AGENT_CLIENT_ID",
      issue: "Not set.",
      fix: `Register an OIDC client at ${issuer}/portal and copy its client ID.`,
    });
  }
  if (!clientSecret) {
    problems.push({
      name: "WORLD_AGENT_CLIENT_SECRET",
      issue: "Not set.",
      fix: "Copy the client secret shown once at registration. Server-side only; never prefix with NEXT_PUBLIC_.",
    });
  }
  if (rawMethod !== "client_secret_basic" && rawMethod !== "client_secret_post") {
    problems.push({
      name: "WORLD_AGENT_AUTH_METHOD",
      issue: `"${rawMethod}" is not supported here.`,
      fix: "Use client_secret_basic (portal default) or client_secret_post, matching the client's registration.",
    });
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      issuer,
      clientId: clientId!,
      clientSecret: clientSecret!,
      authMethod: rawMethod as AgentConfig["authMethod"],
    },
  };
}
