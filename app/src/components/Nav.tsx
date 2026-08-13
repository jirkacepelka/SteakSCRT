"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ConnectButton } from "./Wallet";

const TABS = [
  { href: "/", label: "Stake" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/validators", label: "Validators" },
  { href: "/governance", label: "Governance" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="nav">
      <div className="brand">
        d<span>SCRT</span>
      </div>
      <div className="tabs">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className="tab"
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
