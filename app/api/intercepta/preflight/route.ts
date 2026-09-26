import { createPublicClient, erc20Abi, formatEther, formatUnits, http } from "viem";
import { sepolia } from "viem/chains";

import { getInterceptaConfig } from "@/lib/intercepta/config";
import { formatUsdc } from "@/lib/intercepta/decision";
import { getPayerConfig, getVerifierConfig, sepoliaRpcUrl } from "@/lib/pay/config";
import { SEPOLIA } from "@/lib/pay/network";
import { engineInstalled, verifierIdentity } from "@/lib/pay/petri-verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PreCheck = { id: string; label: string; status: "ok" | "blocked" | "warn"; detail: string; fix?: string };

/**
 * GET /api/intercepta/preflight
 *
 * Everything a paid verification needs, checked without spending an Intercepta
 * request: the key, the payer's USDC, the relayer's gas, the Petri engine and
 * the verifier's Petri key. Addresses only; keys never leave the server.
 */
export async function GET() {
  const checks: PreCheck[] = [];
  const client = createPublicClient({ chain: sepolia, transport: http(sepoliaRpcUrl(), { timeout: 8000 }) });

  const ic = getInterceptaConfig();
  checks.push(
    ic.ok
      ? {
          id: "intercepta",
          label: "Intercepta key",
          status: "ok",
          detail: `Set. Scan Message ${ic.config.scanMessage ? "on" : "off"}; block at score ≥ ${ic.config.thresholds.blockScore}, hold at ≥ ${ic.config.thresholds.holdScore}.`,
        }
      : { id: "intercepta", label: "Intercepta key", status: "blocked", detail: ic.problems[0].issue, fix: ic.problems[0].fix },
  );

  const payer = getPayerConfig();
  let payerAddress: string | null = null;
  if (!payer.ok) {
    for (const p of payer.problems) checks.push({ id: `payer:${p.name}`, label: "Petri agent wallet", status: "blocked", detail: `${p.name}: ${p.issue}`, fix: p.fix });
  } else {
    payerAddress = payer.config.address;
    try {
      const bal = await client.readContract({ address: SEPOLIA.usdc, abi: erc20Abi, functionName: "balanceOf", args: [payer.config.address] });
      checks.push({
        id: "payer",
        label: "Petri agent wallet (payer)",
        status: bal > 0n ? "ok" : "blocked",
        detail: `${payer.config.address} holds ${formatUnits(bal, 6)} USDC on Sepolia. Limit ${formatUsdc(payer.config.maxAtomic)} a payment, authorizations valid ≤ ${payer.config.maxValiditySeconds} s.`,
        fix: bal > 0n ? undefined : "Get Sepolia USDC at faucet.circle.com (choose Ethereum Sepolia).",
      });
    } catch (e) {
      checks.push({ id: "payer", label: "Petri agent wallet (payer)", status: "warn", detail: `${payer.config.address}. Balance unreadable: ${String(e).slice(0, 120)}` });
    }
  }

  const verifier = getVerifierConfig();
  let verifierInfo: { payTo: string; relayer: string; rogue: string; fee: string; markdownFee: string; greedyFee: string; screenPayer: boolean } | null = null;
  if (!verifier.ok) {
    for (const p of verifier.problems) checks.push({ id: `verifier:${p.name}`, label: "Verifier", status: "blocked", detail: `${p.name}: ${p.issue}`, fix: p.fix });
  } else {
    const v = verifier.config;
    verifierInfo = {
      payTo: v.payTo,
      relayer: v.relayerAddress,
      rogue: v.rogue.payTo,
      fee: formatUsdc(v.feeAtomic),
      markdownFee: formatUsdc(v.markdownFeeAtomic),
      greedyFee: formatUsdc(v.greedy.feeAtomic),
      screenPayer: v.screenPayer,
    };
    try {
      const wei = await client.getBalance({ address: v.relayerAddress });
      checks.push({
        id: "relayer",
        label: "Seller relayer (settles on Sepolia)",
        status: wei >= 1_000_000_000_000_000n ? "ok" : wei > 0n ? "warn" : "blocked",
        detail: `${v.relayerAddress} holds ${Number(formatEther(wei)).toFixed(4)} Sepolia ETH for gas. Paid to ${v.payTo}.`,
        fix: wei > 0n ? undefined : "Send it a little Sepolia ETH from any faucet.",
      });
    } catch (e) {
      checks.push({ id: "relayer", label: "Seller relayer", status: "warn", detail: `${v.relayerAddress}. Balance unreadable: ${String(e).slice(0, 120)}` });
    }
    if (payerAddress && payerAddress.toLowerCase() === v.payTo.toLowerCase()) {
      checks.push({ id: "same-wallet", label: "Payer and payee", status: "warn", detail: "The agent would pay itself. Use two different wallets for a clear demo." });
    }
  }

  const engine = engineInstalled();
  checks.push(
    engine
      ? { id: "engine", label: "Petri engine", status: "ok", detail: "Installed. The file is read from the live Petri log." }
      : { id: "engine", label: "Petri engine", status: "warn", detail: "Not installed. The file is read from the saved snapshot, which may be behind the log.", fix: "cd petri && npx pnpm@10 install" },
  );
  const id = verifier.ok ? verifierIdentity(verifier.config.petriHome) : null;
  if (id) {
    checks.push(
      id.ok
        ? { id: "verifier-key", label: "Petri key (reads the live log)", status: "ok", detail: `runner ${id.identity.runnerId.slice(0, 16)}… (${id.identity.label || "no label"})` }
        : { id: "verifier-key", label: "Petri key (reads the live log)", status: "warn", detail: id.detail, fix: "Without it the file comes from the saved snapshot." },
    );
  }

  return Response.json({ checks, payer: payerAddress, verifier: verifierInfo }, { headers: { "cache-control": "no-store" } });
}
