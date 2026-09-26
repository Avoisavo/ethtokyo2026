import type { Metadata } from "next";

import { getInterceptaConfig } from "@/lib/intercepta/config";
import { getPayerConfig, getVerifierConfig } from "@/lib/pay/config";
import { readPaymentRecords } from "@/lib/pay/record";
import { loadTree } from "@/lib/tree";

import PayFlow, { type VersionOption } from "./pay-flow";
import s from "@/app/world/world.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Intercepta · Paid verification",
  description: "The Petri agent pays a verifier over x402. Intercepta screens the wallet and the authorization before anything is signed.",
};

export default async function InterceptaPage({ searchParams }: PageProps<"/intercepta">) {
  const { version } = await searchParams;
  const tree = await loadTree();

  // A version a guard or the typecheck stopped was never scored, so nobody can verify it.
  const versions: VersionOption[] = tree.ok
    ? tree.data.nodes
        .filter((n) => !n.detail.mechanical || n.detail.mechanical.cls === "ok")
        .map((n) => ({
          id: n.id,
          short: n.short,
          label: n.label,
          hypothesis: n.hypothesis,
          status: n.status,
          keys: n.verifications.filter((v) => v.counted).length,
        }))
    : [];

  // Only names cross to the client. Keys stay in lib/.
  const missing = [getInterceptaConfig(), getPayerConfig(), getVerifierConfig()].flatMap((c) =>
    c.ok ? [] : c.problems.map((p) => `${p.name}: ${p.issue}`),
  );

  const wanted = typeof version === "string" ? version.toLowerCase() : "";
  const initialVersion =
    versions.find((v) => wanted && v.id.startsWith(wanted))?.id ??
    versions.find((v) => v.id.startsWith("e1adae18"))?.id ??
    versions[0]?.id ??
    "";

  return (
    <main className={`container ${s.page}`}>
      <header className={s.pageHead}>
        <span className="tag tag-real">Intercepta · Add Payment Screening to Your Agent or x402 Service</span>
        <h1>Paid verification, screened before anything is signed</h1>
        <p className={s.lede}>
          A version needs two independent keys to re-run it. Here the Petri agent pays a verifier for that run over
          x402, in test USDC on Sepolia. Before the agent signs, Intercepta screens the wallet it would pay and the exact
          payment authorization. Before the verifier accepts, it screens the payer. Any failure holds the payment; nothing
          is paid by default.
        </p>
      </header>
      <PayFlow versions={versions} initialVersion={initialVersion} missing={missing} initialRecords={readPaymentRecords(20)} />
    </main>
  );
}
