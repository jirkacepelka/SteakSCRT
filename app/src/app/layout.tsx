import type { Metadata } from "next";
import { Geist, Inter } from "next/font/google";

import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { WalletProvider } from "@/components/Wallet";

import "./globals.css";

/*
 * Both families the design uses, self-hosted by next/font at build time.
 *
 * They were previously named in CSS but never loaded, so every screen silently fell back
 * to the system sans — which is most of why the built app did not look like the file.
 * Geist carries the chrome (nav, headings, buttons); Inter carries what is inside a card.
 */
const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Steakˢᶜʳᵗ — liquid staking for Secret Network",
  description:
    "Stake SCRT, keep it liquid. Non-rebasing derivative, batched withdrawals, governed by the network.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${inter.variable}`}>
      <body>
        <WalletProvider>
          <div className="shell">
            <Nav />
            <main>{children}</main>
            <Footer />
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
