"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ConnectButton } from "./Wallet";

const TABS = [
  { href: "/", label: "Staking" },
  { href: "/statistics", label: "Statistics" },
  { href: "/governance", label: "Governance" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="nav">
      <Link href="/" className="brand">
        {/* The mark exported from the design, used as-is at its designed 30×30. */}
        <img className="brand-mark" src="/brand/steak.svg" alt="" width={30} height={30} />
        Steak<sup>scrt</sup>
      </Link>

      <div className="nav-tabs">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className="nav-tab"
            aria-current={pathname === tab.href ? "page" : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      <div className="nav-actions">
        <ConnectButton />
      </div>
    </nav>
  );
}
