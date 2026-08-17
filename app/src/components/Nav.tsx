"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { DEPLOYMENT } from "@/lib/chain";
import { isDefaultEndpoint } from "@/lib/endpoint";

import { Settings as SettingsIcon } from "./Icon";
import { SettingsDialog } from "./Settings";
import { ConnectButton, useWallet } from "./Wallet";

const TABS = [
  { href: "/", label: "Stake" },
  { href: "/statistics", label: "Statistics" },
  { href: "/governance", label: "Governance" },
];

/** Testnets say so. Nobody should discover which chain they are on from a failed transaction. */
function NetworkPill() {
  const isMainnet = DEPLOYMENT.chainId === "secret-4";
  if (isMainnet) return null;
  return (
    <span className="net" title={`Connected to ${DEPLOYMENT.chainId}`}>
      <span className="dot" />
      <span>{DEPLOYMENT.chainId}</span>
    </span>
  );
}

export function Nav() {
  const pathname = usePathname();
  const { address } = useWallet();
  const [settings, setSettings] = useState(false);

  // Once connected, settings live inside the account panel; two gears in one bar is one
  // gear too many. Disconnected they stay here, because choosing a node is exactly what
  // somebody needs when nothing works — including, sometimes, connecting.
  const showGear = !address;

  return (
    <>
      <nav className="nav">
        <div className="nav-inner">
          <Link href="/" className="brand">
            <img src="/brand/steak.svg" alt="" width={26} height={26} />
            Steak<sup>scrt</sup>
          </Link>

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

          <div className="nav-end">
            <NetworkPill />
            {showGear && (
              <button
                className="icon-btn"
                onClick={() => setSettings(true)}
                aria-label="Settings"
                title={isDefaultEndpoint() ? "Settings" : "Settings — custom node in use"}
                style={
                  isDefaultEndpoint()
                    ? undefined
                    : { borderColor: "var(--accent)", color: "var(--accent)" }
                }
              >
                <SettingsIcon size={17} />
              </button>
            )}
            <ConnectButton />
          </div>
        </div>
      </nav>

      {settings && showGear && <SettingsDialog onClose={() => setSettings(false)} />}
    </>
  );
}
