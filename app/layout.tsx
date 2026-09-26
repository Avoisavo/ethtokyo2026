import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--f-body" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--f-mono" });

export const metadata: Metadata = {
  title: "Petri",
  description: "Evolve an AI agent's harness. Other keys re-run every score. Failures are kept.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <header className="topbar">
          <div className="topbar-in">
            <Link href="/" className="brand"><span className="brand-mark" aria-hidden="true" />Petri</Link>
            <nav className="topnav" aria-label="Main">
              <Link href="/">Trees</Link>
<<<<<<< HEAD
              <Link href="/world">World ID</Link>
=======
              <Link href="/ens">ENS</Link>
>>>>>>> 5f547c8e44a41f2b0ab630974c19d9c2f267852e
              <a href="https://github.com/Avoisavo/ethonline2026/tree/petri">GitHub</a>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
