import type { Metadata } from "next";

import { ConnectButton } from "@/app/ens/_components/ConnectButton";

import "./ens.css";

export const metadata: Metadata = {
  title: "ENSv2 Playground",
  description: "Try ENSv2 on Sepolia: names, records, subnames, access control and primary names",
};

// The ENSv2 Playground, moved in from its own app. Its styles stay inside .ens-app (see ens.css),
// and its bar sits just under the site's top bar (52px plus its border).
export default function EnsLayout({ children }: LayoutProps<"/ens">) {
  return (
    <div className="ens-app">
        <header className="sticky top-[53px] z-[9] flex h-14 items-center justify-between gap-4 border-b border-zinc-200 bg-background/80 px-6 backdrop-blur dark:border-zinc-800">
          <span className="font-semibold">ENSv2 Playground</span>
          <ConnectButton />
        </header>
        <main className="mx-auto w-full max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
