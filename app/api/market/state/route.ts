import { readTexts } from "@/lib/market/chain";
import { ACCESS_KEYS, VERSION_KEYS, verifierName } from "@/lib/market/records";
import { currentRound, findVersion, readRound } from "@/lib/market/service";
import { handle } from "../_shared";

export const dynamic = "force-dynamic";

/** Everything the market page shows for one version: its records, the current round and its verifiers. */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  return handle(async () => {
    const v = await findVersion(id);
    const version = await readTexts(v.name, [VERSION_KEYS.submit, VERSION_KEYS.submitter, VERSION_KEYS.access, VERSION_KEYS.price, VERSION_KEYS.docList, VERSION_KEYS.docHash]);
    const n = currentRound(v.label);
    const round = n > 0 ? await readRound(v.label, n).catch(() => null) : null;
    const verifiers = [];
    for (const k of round?.picked ?? []) {
      const name = verifierName(v.label, n, Number(k.slice(1)));
      const t = await readTexts(name, Object.values(ACCESS_KEYS));
      verifiers.push({ label: k, name, wallet: t[ACCESS_KEYS.wallet], human: t[ACCESS_KEYS.human], vote: t[ACCESS_KEYS.vote], key: t[ACCESS_KEYS.key], accessKey: t[ACCESS_KEYS.accessKey] });
    }
    return { id: v.node.id, short: v.node.short, label: v.label, name: v.name, hypothesis: v.node.hypothesis, version, n, round, verifiers, now: Math.floor(Date.now() / 1000) };
  });
}
