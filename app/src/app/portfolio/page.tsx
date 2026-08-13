"use client";

import { useState } from "react";

import { Status, readable, type Feedback } from "@/components/Status";
import { useWallet } from "@/components/Wallet";
import { fromMicro, getPermit, untilFrom } from "@/lib/chain";
import { claimMatured, fetchPendingClaims, type PendingClaims } from "@/lib/protocol";

export default function PortfolioPage() {
  const { connection, address } = useWallet();
  const [claims, setClaims] = useState<PendingClaims | null>(null);
  const [feedback, setFeedback] = useState<Feedback>({ kind: "idle" });

  const load = async () => {
    if (!connection || !address) return;
    setFeedback({ kind: "busy", message: "Sign the permit in your wallet…" });
    try {
      // One signature covers every authenticated query in the app, and it is cached, so
      // this is asked once per session rather than once per screen.
      const permit = await getPermit(address);
      setClaims(await fetchPendingClaims(connection.client, permit));
      setFeedback({ kind: "idle" });
    } catch (e) {
      setFeedback({ kind: "err", message: readable(e) });
    }
  };

  const claim = async () => {
    if (!connection) return;
    setFeedback({ kind: "busy", message: "Waiting for your wallet…" });
    try {
      await claimMatured(connection);
      setFeedback({ kind: "ok", message: "Claimed." });
      await load();
    } catch (e) {
      setFeedback({ kind: "err", message: readable(e) });
    }
  };

  return (
    <div className="grid">
      <div className="card">
        <p className="card-title">Your withdrawals</p>

        {!connection ? (
          <p className="note" style={{ marginTop: 0 }}>
            Connect a wallet to see your position. Balances and claims are private contract
            state — the app reads them with a permit you sign, not with anything stored
            here.
          </p>
        ) : !claims ? (
          <>
            <p className="note" style={{ marginTop: 0 }}>
              Your claims are private. Signing a permit lets this app read them; it is a
              signature rather than a transaction, so it costs nothing.
            </p>
            <button className="btn" onClick={load} disabled={feedback.kind === "busy"}>
              Sign permit and load
            </button>
          </>
        ) : claims.claims.length === 0 ? (
          <p className="note" style={{ marginTop: 0 }}>
            No withdrawal requests yet.
          </p>
        ) : (
          <>
            <table className="plain">
              <thead>
                <tr>
                  <th>Window</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Claimable</th>
                </tr>
              </thead>
              <tbody>
                {claims.claims.map((c) => (
                  <tr key={c.window_id}>
                    <td className="numeral">#{c.window_id}</td>
                    <td className="numeral">{fromMicro(c.scrt_owed)} SCRT</td>
                    <td>
                      {c.claimed ? (
                        <span className="pill">paid</span>
                      ) : c.state === "matured" ? (
                        <span className="pill pill--live">ready</span>
                      ) : (
                        <span className="pill pill--wait">{c.state}</span>
                      )}
                    </td>
                    <td className="muted">
                      {c.claimed
                        ? "—"
                        : c.state === "matured"
                          ? "now"
                          : c.matures_at
                            ? untilFrom(c.matures_at)
                            : "when the window closes"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <button
              className="btn"
              onClick={claim}
              disabled={claims.total_claimable_now === "0" || feedback.kind === "busy"}
            >
              {claims.total_claimable_now === "0"
                ? "Nothing to claim yet"
                : `Claim ${fromMicro(claims.total_claimable_now)} SCRT`}
            </button>
          </>
        )}

        <Status feedback={feedback} />
      </div>

      <div className="card card--queue">
        <p className="card-title">Owed to you</p>
        <p className="big numeral">
          {claims ? fromMicro(claims.total_owed) : "—"}{" "}
          <span style={{ fontSize: 17 }}>SCRT</span>
        </p>
        <div style={{ marginTop: 18 }}>
          <div className="row">
            <span className="k">Ready to claim</span>
            <span className="v numeral">
              {claims ? fromMicro(claims.total_claimable_now) : "—"}
            </span>
          </div>
        </div>
        <p className="note">
          Amounts shown are what each window will actually pay. If a validator was slashed
          while a window was unbonding, that window returns less than it promised and the
          shortfall is shared across everyone in it — so the figure here is the real one,
          not the original quote.
        </p>
      </div>
    </div>
  );
}
