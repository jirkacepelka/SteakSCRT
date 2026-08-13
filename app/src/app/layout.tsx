import type { Metadata } from "next";

import { Nav } from "@/components/Nav";
import { WalletProvider } from "@/components/Wallet";

import "./globals.css";

export const metadata: Metadata = {
  title: "dSCRT — liquid staking for Secret Network",
  description:
    "Stake SCRT, keep it liquid. Non-rebasing derivative, batched withdrawals, governed by the network.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          <div className="shell">
            <Nav />
            {children}
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
