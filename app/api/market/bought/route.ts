import { readTexts } from "@/lib/market/chain";
import { ACCESS_KEYS, VERSION_KEYS, buyerName, docKey } from "@/lib/market/records";
import { findVersion } from "@/lib/market/service";
import { readState } from "@/lib/market/store";
import { handle } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * What a buyer needs to open their copy: the sealed key on their buyer name,
 * and the encrypted files on the version name. All of it is public on ENS.
 * `wallet` picks the buyer name that belongs to that wallet.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  const wallet = (url.searchParams.get("wallet") ?? "").toLowerCase();
  return handle(async () => {
    const v = await findVersion(id);
    const count = readState().buyers[v.node.id] ?? 0;
    let buyer: { name: string; key: string; accessKey: string } | null = null;
    for (let i = count; i >= 1 && !buyer; i--) {
      const name = buyerName(v.name, i);
      const t = await readTexts(name, [ACCESS_KEYS.wallet, ACCESS_KEYS.key, ACCESS_KEYS.accessKey]);
      if (t[ACCESS_KEYS.wallet].toLowerCase() === wallet) buyer = { name, key: t[ACCESS_KEYS.key], accessKey: t[ACCESS_KEYS.accessKey] };
    }
    const list = (await readTexts(v.name, [VERSION_KEYS.docList]))[VERSION_KEYS.docList];
    const files = list ? list.split(",") : [];
    const docs = files.length ? await readTexts(v.name, files.map(docKey)) : {};
    return { version: v.name, buyer, files, docs: Object.fromEntries(files.map((f) => [f, docs[docKey(f)] ?? ""])) };
  });
}
