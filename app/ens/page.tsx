import { AddressLink } from "@/app/ens/_components/ui";
import { ENSV2_SEPOLIA } from "@/app/ens/_lib/ens/deployments";

import { Playground } from "@/app/ens/_components/playground/Playground";

export default function Home() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">ENSv2 Playground</h1>
        <p className="max-w-3xl text-zinc-600 dark:text-zinc-400">
          Try ENSv2 on Sepolia: register a name, set records, create subnames, manage who can do what, and set your
          primary name. Work top to bottom.
        </p>
      </header>

      <Playground />

      <details className="rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
        <summary className="cursor-pointer font-medium">ENSv2 contract addresses (Sepolia)</summary>
        <table className="mt-3 w-full text-left">
          <tbody>
            {Object.entries(ENSV2_SEPOLIA).map(([name, d]) => (
              <tr key={name} className="border-t border-zinc-100 dark:border-zinc-900">
                <td className="py-1 pr-4">{name}</td>
                <td className="py-1 text-xs">
                  <AddressLink address={d.address} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
