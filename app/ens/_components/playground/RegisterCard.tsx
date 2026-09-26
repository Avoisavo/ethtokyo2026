"use client";

import { useState } from "react";
import { type Address, type Hex, bytesToHex, erc20Abi, formatUnits, zeroAddress, zeroHash } from "viem";
import { useConnection, usePublicClient, useReadContract, useWriteContract } from "wagmi";

import { TxButton, TxStatus } from "@/app/ens/_components/Tx";
import { Badge, Card, Field, Input, Notice, Row, Select } from "@/app/ens/_components/ui";
import { ETHRegistrarAbi } from "@/app/ens/_lib/ens/abis/ETHRegistrar";
import { PAYMENT_TOKENS, addresses } from "@/app/ens/_lib/ens/contracts";
import { tryNormalize } from "@/app/ens/_lib/ens/names";
import { useLocalJson } from "@/app/ens/_lib/hooks/useLocalJson";
import { useMyResolver } from "@/app/ens/_lib/hooks/useMyResolver";
import { useNow } from "@/app/ens/_lib/hooks/useNow";
import { useTx } from "@/app/ens/_lib/hooks/useTx";
import { useWorkspace } from "@/app/ens/_lib/hooks/useWorkspace";
import { CHAIN_ID } from "@/app/ens/_lib/wagmi";

const YEAR = 365n * 24n * 60n * 60n;
const USDC = PAYMENT_TOKENS.MockUSDC;
const REGISTRAR = addresses.ETHRegistrar;
// ETHRegistrar.MIN_COMMITMENT_AGE on Sepolia is 60s; a few extra seconds absorb clock skew.
const COMMIT_WAIT = 60 + 5;

type Pending = { secret: Hex; duration: string; resolver: Address };

export function RegisterCard({ onRegistered }: { onRegistered: (name: string) => void }) {
  const { address } = useConnection();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { mutateAsync } = useWriteContract();
  const { add } = useWorkspace();
  const my = useMyResolver();
  const tx = useTx();
  const now = useNow();

  const [input, setInput] = useState("");
  const [years, setYears] = useState("1");
  const normalized = tryNormalize(input.replace(/\.eth$/, ""));
  const label = normalized && !normalized.includes(".") ? normalized : null;

  const [pending, setPending] = useLocalJson<Pending | null>(
    label && address ? `ensv2:commit:${address}:${label}` : null,
    null,
  );
  const duration = pending ? BigInt(pending.duration) : BigInt(years) * YEAR;
  const resolver = pending?.resolver ?? my.resolver;

  const available = useReadContract({
    address: REGISTRAR,
    abi: ETHRegistrarAbi,
    functionName: "isAvailable",
    args: label ? [label] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!label },
  });
  const price = useReadContract({
    address: REGISTRAR,
    abi: ETHRegistrarAbi,
    functionName: "getRegisterPrice",
    args: label ? [label, duration, USDC.address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!label && available.data === true },
  });
  const total = price.data ? price.data[0] + price.data[1] : undefined;

  const allowance = useReadContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, REGISTRAR] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!address },
  });
  const balance = useReadContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!address },
  });

  const commitment = useReadContract({
    address: REGISTRAR,
    abi: ETHRegistrarAbi,
    functionName: "makeCommitment",
    args:
      label && address && pending
        ? [label, address, pending.secret, zeroAddress, pending.resolver, duration, zeroHash]
        : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!label && !!address && !!pending },
  });
  const committedAt = useReadContract({
    address: REGISTRAR,
    abi: ETHRegistrarAbi,
    functionName: "commitmentAt",
    args: commitment.data ? [commitment.data] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!commitment.data },
  });
  const commitTime = committedAt.data ? Number(committedAt.data) : 0;
  const readyAt = commitTime ? commitTime + COMMIT_WAIT : 0;
  const waitLeft = readyAt && now ? Math.max(0, readyAt - now) : null;

  const needsApproval = total !== undefined && (allowance.data ?? 0n) < total;
  const lowBalance = total !== undefined && balance.data !== undefined && balance.data < total;

  const approve = async () => {
    if (total === undefined) return;
    // 1% headroom: the price is quoted from an oracle and can move by rounding.
    const r = await tx.run(() =>
      mutateAsync({
        address: USDC.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [REGISTRAR, (total * 101n) / 100n],
        chainId: CHAIN_ID,
      }),
    );
    if (r) allowance.refetch();
  };

  const commit = async () => {
    if (!label || !address || !client || !resolver) return;
    let p = pending;
    if (!p) {
      p = {
        secret: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
        duration: duration.toString(),
        resolver,
      };
      setPending(p);
    }
    const c = await client.readContract({
      address: REGISTRAR,
      abi: ETHRegistrarAbi,
      functionName: "makeCommitment",
      args: [label, address, p.secret, zeroAddress, p.resolver, BigInt(p.duration), zeroHash],
    });
    const r = await tx.run(() =>
      mutateAsync({ address: REGISTRAR, abi: ETHRegistrarAbi, functionName: "commit", args: [c], chainId: CHAIN_ID }),
    );
    if (r) {
      await commitment.refetch();
      committedAt.refetch();
    }
  };

  const register = async () => {
    if (!label || !address || !pending) return;
    const r = await tx.run(() =>
      mutateAsync({
        address: REGISTRAR,
        abi: ETHRegistrarAbi,
        functionName: "register",
        args: [label, address, pending.secret, zeroAddress, pending.resolver, duration, USDC.address, zeroHash],
        chainId: CHAIN_ID,
      }),
    );
    if (r) {
      const name = `${label}.eth`;
      setPending(null);
      add("names", name);
      available.refetch();
      balance.refetch();
      onRegistered(name);
    }
  };

  const step = !my.deployed ? 0 : needsApproval ? 1 : !commitTime ? 2 : waitLeft !== 0 ? 3 : 4;

  return (
    <Card
      title="2. Register a .eth name"
      description="Registration is commit-reveal: you commit to a secret, wait a minute so nobody can front-run you, then register. Fees are paid in test USDC."
    >
      <Row>
        <Field label="Name">
          <div className="flex items-center gap-1">
            <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="myname" className="w-56" />
            <span className="font-mono text-sm">.eth</span>
          </div>
        </Field>
        <Field label="Duration">
          <Select value={pending ? String(duration / YEAR) : years} onChange={(e) => setYears(e.target.value)} disabled={!!pending}>
            {["1", "2", "3", "5"].map((y) => (
              <option key={y} value={y}>
                {y} year{y === "1" ? "" : "s"}
              </option>
            ))}
          </Select>
        </Field>
        {label && available.data !== undefined && (
          <Badge tone={available.data ? "success" : "danger"}>{available.data ? "available" : "taken"}</Badge>
        )}
        {total !== undefined && (
          <span className="text-sm">
            Price: <span className="font-mono">{formatUnits(total, USDC.decimals)} USDC</span>
          </span>
        )}
      </Row>
      {input && !label && <Notice tone="warning">Enter a single valid label, e.g. &quot;myname&quot;.</Notice>}
      {price.error && <Notice tone="warning">Can&apos;t price this name (it may be too short or not available).</Notice>}
      {lowBalance && <Notice tone="warning">Not enough test USDC; mint some in step 1.</Notice>}

      {label && available.data && address && (
        <ol className="flex flex-col gap-2 text-sm">
          <Step n={0} current={step} title="Deploy your resolver (step 1)">
            {step === 0 && (
              <TxButton tx={my.tx} onClick={my.deploy}>
                Deploy my resolver
              </TxButton>
            )}
          </Step>
          <Step n={1} current={step} title="Approve USDC spending">
            {step === 1 && (
              <TxButton tx={tx} onClick={approve} disabled={lowBalance}>
                Approve {total !== undefined ? formatUnits((total * 101n) / 100n, USDC.decimals) : ""} USDC
              </TxButton>
            )}
          </Step>
          <Step n={2} current={step} title="Commit">
            {step === 2 && (
              <TxButton tx={tx} onClick={commit}>
                Commit
              </TxButton>
            )}
          </Step>
          <Step n={3} current={step} title="Wait about a minute">
            {step === 3 && <span className="font-mono">{waitLeft === null ? "…" : `${waitLeft}s`}</span>}
          </Step>
          <Step n={4} current={step} title="Register">
            {step === 4 && (
              <TxButton tx={tx} onClick={register} disabled={lowBalance}>
                Register {label}.eth
              </TxButton>
            )}
          </Step>
        </ol>
      )}
      {pending && (
        <button type="button" onClick={() => setPending(null)} className="self-start text-xs text-zinc-500 hover:underline">
          Start over (discard the saved commitment for {label}.eth)
        </button>
      )}
      <TxStatus tx={tx} />
      <TxStatus tx={my.tx} showEvents={false} />
    </Card>
  );
}

function Step({ n, current, title, children }: { n: number; current: number; title: string; children?: React.ReactNode }) {
  const done = current > n;
  return (
    <li className={`flex flex-wrap items-center gap-3 ${current < n ? "opacity-50" : ""}`}>
      <span className={`w-5 text-center ${done ? "text-emerald-600" : ""}`}>{done ? "✓" : n + 1}</span>
      <span className="min-w-40">{title}</span>
      {children}
    </li>
  );
}
