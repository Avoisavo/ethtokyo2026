import { DOMAINS, HARNESSES, MODELS, slugOf, type DomainOption, type HarnessOption, type ModelOption } from "./catalog";
import { buildShowcaseTree, SHOWCASE_TREES } from "./showcase";
import { loadDigest, loadTree, type DigestResult } from "./tree";
import type { ExportNode, PetriExport } from "./types";

/** A domain × harness × model that has a tree. The model is fixed; the harness evolves. */
export interface TreeEntry {
  slug: string;
  domain: DomainOption;
  model: ModelOption;
  harness: HarnessOption;
  goal: string;
  source: "real" | "showcase";
  showcaseKey?: string;
}

const pick = <T extends { key: string }>(list: T[], key: string): T => list.find((x) => x.key === key)!;
const entry = (domain: string, harness: string, model: string, goal: string, source: "real" | "showcase", showcaseKey?: string): TreeEntry => ({
  slug: slugOf(domain, harness, model),
  domain: pick(DOMAINS, domain), harness: pick(HARNESSES, harness), model: pick(MODELS, model),
  goal, source, ...(showcaseKey ? { showcaseKey } : {}),
});

export const TREES: TreeEntry[] = [
  entry("research", "hermes-agent", "claude-sonnet-5", "Solve more of 40 research tasks", "showcase", "hermes"),
  entry("coding", "claude-code", "claude-opus-5", "Solve more of 40 coding tasks", "showcase", "claudeCode"),
  entry("coding", "petri-harness-v1", "claude-sonnet-5", "Solve more of 20 coding tasks", "real"),
  entry("finance", "pi", "claude-haiku-4-5", "Solve more of 20 finance analysis tasks", "showcase", "pi"),
  entry("security", "codex-cli", "gpt-5", "Find more of 40 planted vulnerabilities", "showcase", "codex"),
  entry("data-analysis", "openhands", "gemini-2-5-pro", "Solve more of 40 data analysis tasks", "showcase", "openhands"),
];

/**
 * The log's versions, plus the versions proposed from the web app. Those are
 * on ENS but not in the engine log, so they come from the market state, as
 * pending children with the author's claim. The CLI run behind them was a demo.
 */
async function withProposals(data: PetriExport): Promise<PetriExport> {
  const { readState } = await import("./market/store");
  const proposals = readState().proposals.filter((p) => !p.hidden && data.nodes.some((n) => n.id === p.parent));
  if (proposals.length === 0) return data;
  let seq = Math.max(...data.nodes.map((n) => n.seq));
  const extra: ExportNode[] = proposals.map((p) => {
    const parent = data.nodes.find((n) => n.id === p.parent)!;
    const change = p.change ?? "Proposed from the web app.";
    return {
      id: p.id, short: p.id.slice(0, 8), label: p.label, seq: ++seq, parent: p.parent, author: "web",
      hypothesis: change, status: "pending", statusCode: "PENDING",
      statusReason: "Proposed from the web app. The CLI run was a demo. Waiting for verifiers.",
      verifiedDeltaBp: null, disputed: false, mode: data.mode, trust: "local-unverified",
      claim: { perf: p.perf ?? 0, tokens: p.tokens ?? 0, speed: p.speed ?? 0 },
      // Only a real World ID proof gets the real badge. The demo button does not.
      ...(p.submit === "free" ? { worldId: { kind: "submitted" as const, real: true } } : {}),
      detail: {
        proposal: { hypothesis: change, falsifiedIf: "", primaryArea: "recovery", motif: "repair-turn", predictedDelta: 1000, reasoning: "", metric: "score" },
        derivedAreas: ["recovery"], claimedMedianBp: parent.detail.claimedMedianBp, claimedRuns: [],
        provenance: { source: "web", model: "claude-sonnet-5" },
      },
      diff: p.diff ?? "", verifications: [], costs: { medianTokens: 0, medianWallMs: 0, tokensPerTask: 0 },
    };
  });
  return { ...data, nodes: [...data.nodes, ...extra] };
}

export const findTree = (slug: string): TreeEntry | undefined => TREES.find((t) => t.slug === slug);

export type TreeLoad =
  | { ok: true; entry: TreeEntry; data: PetriExport; digest: DigestResult | null }
  | { ok: false; entry: TreeEntry; error: string; root: string };

export async function loadTreeEntry(e: TreeEntry, withDigest = false): Promise<TreeLoad> {
  if (e.source === "showcase") return { ok: true, entry: e, data: buildShowcaseTree(SHOWCASE_TREES[e.showcaseKey!]!), digest: null };
  const [tree, digest] = await Promise.all([loadTree(), withDigest ? loadDigest() : Promise.resolve(null)]);
  return tree.ok
    ? { ok: true, entry: e, data: await withProposals(tree.data), digest }
    : { ok: false, entry: e, error: tree.error, root: tree.root };
}
