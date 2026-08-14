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
        <BrandMark />
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

      <div className="nav-spacer" />
      <ConnectButton />
    </nav>
  );
}

/** Three stacked bars, echoing the layered stake the protocol holds. */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 30 30" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="24" height="6" rx="3" fill="var(--accent)" />
      <rect x="3" y="13" width="18" height="6" rx="3" fill="var(--accent)" opacity="0.7" />
      <rect x="3" y="21" width="12" height="6" rx="3" fill="var(--accent)" opacity="0.4" />
    </svg>
  );
}
