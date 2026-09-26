"use client";

import { erc20Abi, formatUnits, parseAbi, parseUnits } from "viem";
import { useConnection, useReadContract, useWriteContract } from "wagmi";

import { PAYMENT_TOKENS } from "@/app/ens/_lib/ens/contracts";
import { useTx } from "@/app/ens/_lib/hooks/useTx";
import { CHAIN_ID } from "@/app/ens/_lib/wagmi";

import { TxButton, TxStatus } from "./Tx";

const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);

/** Balance + permissionless mint for the Sepolia MockUSDC / MockDAI test tokens. */
export function Faucet({ token = "MockUSDC", amount = "100" }: { token?: "MockUSDC" | "MockDAI"; amount?: string }) {
  const t = PAYMENT_TOKENS[token];
  const { address } = useConnection();
  const { mutateAsync } = useWriteContract();
  const tx = useTx();
  const balance = useReadContract({
    address: t.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!address },
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>
          {token} balance:{" "}
          <span className="font-mono">
            {balance.data === undefined ? "—" : `${formatUnits(balance.data, t.decimals)} ${t.symbol}`}
          </span>
        </span>
        <TxButton
          tx={tx}
          variant="secondary"
          onClick={async () => {
            if (!address) return;
            const r = await tx.run(() =>
              mutateAsync({
                address: t.address,
                abi: mintAbi,
                functionName: "mint",
                args: [address, parseUnits(amount, t.decimals)],
                chainId: CHAIN_ID,
              }),
            );
            if (r) balance.refetch();
          }}
        >
          Mint {amount} {t.symbol}
        </TxButton>
      </div>
      <TxStatus tx={tx} showEvents={false} />
    </div>
  );
}
