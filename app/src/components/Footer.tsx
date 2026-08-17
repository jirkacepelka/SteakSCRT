import Link from "next/link";

import { External } from "./Icon";

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span>
          Non-custodial. Deposits, withdrawals and claims are contract calls signed in your
          own wallet.
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--s-5)" }}>
          <Link href="/keeper">Run upkeep</Link>
          <a
            href="https://github.com/jirkacepelka/SteakSCRT"
            target="_blank"
            rel="noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            Source <External size={12} />
          </a>
        </span>
      </div>
    </footer>
  );
}
