import type { Metadata } from "next";
import { Geist, Inter } from "next/font/google";

import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { ThemeProvider } from "@/components/Theme";
import { ToastProvider } from "@/components/Toast";
import { WalletProvider } from "@/components/Wallet";

import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Steakˢᶜʳᵗ — liquid staking for Secret Network",
  description:
    "Stake SCRT and keep it liquid. A non-rebasing derivative, batched withdrawals, and a validator set governed by the network.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${inter.variable}`} suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <ToastProvider>
            <WalletProvider>
              <div className="shell">
                <Nav />
                <main className="shell-body">{children}</main>
                <Footer />
              </div>
            </WalletProvider>
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
