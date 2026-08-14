"use client";

import { useEffect, useMemo, useState } from "react";

import { Status, readable, type Feedback } from "@/components/Status";
import { useWallet } from "@/components/Wallet";
import {
  fromMicro,
  getPermit,
  rateToNumber,
  toMicro,
  untilFrom,
  whenFrom,
} from "@/lib/chain";
import {
  claimMatured,
  deposit,
  fetchConfig,
  fetchPendingClaims,
  fetchScrtBalance,
  fetchState,
  fetchTokenBalance,
  fetchWindows,
  requestUnbond,
  type Config,
  type PendingClaims,
  type ProtocolState,
  type UnbondWindow,
} from "@/lib/protocol";

type Mode = "stake" | "unstake";

export default function StakingPage() {
  const { connection, address } = useWallet();
  const [mode, setMode] = useState<Mode>("stake");
  const [amount, setAmount] = useState("");
  const [feedback, setFeedback] = useState<Feedback>({ kind: "idle" });

  const [config, setConfig] = useState<Config | null>(null);
  const [state, setState] = useState<ProtocolState | null>(null);
  const [openWindow, setOpenWindow] = useState<UnbondWindow | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [claims, setClaims] = useState<PendingClaims | null>(null);

  const refresh = async () => {
    try {
      const [c, s, w] = await Promise.all([fetchConfig(), fetchState(), fetchWindows("open")]);
      setConfig(c);
      setState(s);
      setOpenWindow(w[0] ?? null);
    } catch (e) {
      setFeedback({ kind: "err", message: readable(e) });
    }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, []);

  // SCRT is a public bank balance. dSCRT is private state on the token contract, so it
  // needs the same permit the rest of the app uses — which is why it only appears once
  // the user has signed one.
  useEffect(() => {
    setBalance(null);
    if (!connection || !address) return;

    void (async () => {
      try {
        if (mode === "stake") {
          setBalance(await fetchScrtBalance(connection.client, address));
        } else {
          const permit = await getPermit(address);
          setBalance(await fetchTokenBalance(connection.client, permit));
        }
      } catch {
        setBalance(null);
      }
    })();
  }, [connection, address, mode]);

  const rate = state ? rateToNumber(state.exchange_rate) : 1;
  const parsed = Number(amount);
  const converted =
    Number.isFinite(parsed) && parsed > 0 ? (mode === "stake" ? parsed / rate : parsed * rate) : 0;

  /**
   * When a withdrawal requested now would actually pay out.
   *
   * Stated on the screen rather than in a tooltip. Someone pressing "unstake" expecting a
   * swap, and finding their money gone for three weeks, has been misled by the interface
   * rather than by the chain.
   */
  const maturity = useMemo(() => {
    if (!config || !openWindow) return null;
    return {
      windowId: openWindow.id,
      closes: openWindow.closes_at,
      matures: openWindow.closes_at + config.params.unbonding_period_secs,
    };
  }, [config, openWindow]);

  const loadClaims = async () => {
    if (!connection || !address) return;
    setFeedback({ kind: "busy", message: "Sign the permit in your wallet…" });
    try {
      const permit = await getPermit(address);
      setClaims(await fetchPendingClaims(connection.client, permit));
      setFeedback({ kind: "idle" });
    } catch (e) {
      setFeedback({ kind: "err", message: readable(e) });
    }
  };

  const submit = async () => {
    if (!connection) return;
    try {
      const micro = toMicro(amount);
      setFeedback({ kind: "busy", message: "Waiting for your wallet…" });

      if (mode === "stake") {
        await deposit(connection, micro);
        setFeedback({ kind: "ok", message: `Staked ${amount} SCRT.` });
      } else {
        await requestUnbond(connection, micro);
        setFeedback({
          kind: "ok",
          message: maturity
            ? `Requested. Joins window ${maturity.windowId}, claimable from ${whenFrom(maturity.matures)}.`
            : "Withdrawal requested.",
        });
      }
      setAmount("");
      void refresh();
      if (claims) void loadClaims();
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
      await loadClaims();
    } catch (e) {
      setFeedback({ kind: "err", message: readable(e) });
    }
  };

  const busy = feedback.kind === "busy";
  const stale = state?.is_stale ?? false;

  return (
    <div className="grid-2">
      <div>
        <div className="panel" style={{ padding: 0, background: "transparent" }}>
          <div className="segmented" style={{ display: "flex", width: "100%" }}>
            <button
              style={{ flex: 1 }}
              aria-pressed={mode === "stake"}
              onClick={() => setMode("stake")}
            >
              Stake
            </button>
            <button
              style={{ flex: 1 }}
              aria-pressed={mode === "unstake"}
              onClick={() => setMode("unstake")}
            >
              Unstake
            </button>
          </div>
        </div>

        <div className="panel" style={{ marginTop: 16 }}>
          <p className="label">{mode === "stake" ? "You stake" : "You return"}</p>

          <div className="amount">
            <input
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            />
            <span className="denom">
              <span className="denom-mark">{mode === "stake" ? "S" : "d"}</span>
              {mode === "stake" ? "SCRT" : "dSCRT"}
            </span>
          </div>

          {balance && (
            <p className="stat-note" style={{ marginTop: 10 }}>
              Balance {fromMicro(balance)} {mode === "stake" ? "SCRT" : "dSCRT"}
              {mode === "stake" && " · Max leaves 0.5 for gas"}
            </p>
          )}

          <div className="chips">
            {([25, 50, 75, 100] as const).map((pct) => (
              <button
                key={pct}
                className="chip"
                disabled={!balance || balance === "0"}
                onClick={() => {
                  if (!balance) return;
                  // Leave a little SCRT behind on Max so the transaction can still pay its
                  // own gas; spending the lot is a footgun, not a feature.
                  const reserve = mode === "stake" && pct === 100 ? 500_000n : 0n;
                  const usable = BigInt(balance) > reserve ? BigInt(balance) - reserve : 0n;
                  setAmount((Number((usable * BigInt(pct)) / 100n) / 1e6).toFixed(6));
                }}
              >
                {pct === 100 ? "Max" : `${pct}%`}
              </button>
            ))}
          </div>

          <hr className="rule" />

          <div className="row">
            <span className="k">You receive</span>
            <span className="v numeral">
              {converted.toFixed(6)} {mode === "stake" ? "dSCRT" : "SCRT"}
            </span>
          </div>
          <div className="row">
            <span className="k">Exchange rate</span>
            <span className="v numeral">1 dSCRT = {rate.toFixed(5)} SCRT</span>
          </div>
          <div className="row">
            <span className="k">Performance fee</span>
            <span className="v numeral">
              {config ? `${config.params.performance_fee_bps / 100}%` : "—"}
            </span>
          </div>

          {stale && (
            <div className="status status--err">
              Cached totals are stale, so deposits and withdrawals are refused until someone
              runs a sync. Nobody&apos;s funds are at risk — the contract is refusing to
              price against figures it no longer trusts.
            </div>
          )}

          <button
            className="btn"
            style={{ marginTop: 18 }}
            onClick={submit}
            disabled={!connection || busy || stale || !amount}
          >
            {!connection
              ? "Connect wallet"
              : busy
                ? "Confirm in wallet…"
                : mode === "stake"
                  ? "Stake"
                  : "Request withdrawal"}
          </button>

          <Status feedback={feedback} />
        </div>
      </div>

      <div>
        {mode === "unstake" && (
          <div className="panel">
            <h2 className="h2">When you get paid</h2>
            <span className="stat-value numeral">
              {config
                ? `${Math.round(config.params.unbonding_period_secs / 86_400)}–${Math.round(
                    (config.params.unbonding_period_secs + config.params.unbond_window_secs) /
                      86_400,
                  )}`
                : "—"}
              <span className="stat-unit">days</span>
            </span>
            {maturity && (
              <div style={{ marginTop: 14 }}>
                <div className="row">
                  <span className="k">Joins window</span>
                  <span className="v numeral">#{maturity.windowId}</span>
                </div>
                <div className="row">
                  <span className="k">Window closes</span>
                  <span className="v">{untilFrom(maturity.closes)}</span>
                </div>
                <div className="row">
                  <span className="k">Claimable from</span>
                  <span className="v">{whenFrom(maturity.matures)}</span>
                </div>
              </div>
            )}
            <p className="note">
              Withdrawals are batched. Cosmos allows seven concurrent unbonding entries per
              validator and this protocol is a single delegator, so requests pool into
              windows and one undelegation per validator goes out when a window closes.
            </p>
          </div>
        )}

        <div className="panel">
          <h2 className="h2">Your withdrawals</h2>

          {!connection ? (
            <p className="note" style={{ marginTop: 0 }}>
              Connect a wallet to see your position. Claims are private contract state, read
              with a permit you sign rather than with anything stored here.
            </p>
          ) : !claims ? (
            <>
              <p className="note" style={{ marginTop: 0, marginBottom: 14 }}>
                One signature covers the whole app. It is a signature rather than a
                transaction, so it costs nothing.
              </p>
              <button className="btn btn--ghost btn--sm" onClick={loadClaims} disabled={busy}>
                Sign permit
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
                    <th>Ready</th>
                  </tr>
                </thead>
                <tbody>
                  {claims.claims.map((c) => (
                    <tr key={c.window_id}>
                      <td className="numeral">#{c.window_id}</td>
                      <td className="numeral">{fromMicro(c.scrt_owed)}</td>
                      <td>
                        {c.claimed ? (
                          <span className="pill">paid</span>
                        ) : c.state === "matured" ? (
                          <span className="pill pill--live">now</span>
                        ) : (
                          <span className="pill">
                            {c.matures_at ? untilFrom(c.matures_at) : "queued"}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <button
                className="btn"
                style={{ marginTop: 16 }}
                onClick={claim}
                disabled={claims.total_claimable_now === "0" || busy}
              >
                {claims.total_claimable_now === "0"
                  ? "Nothing to claim yet"
                  : `Claim ${fromMicro(claims.total_claimable_now)} SCRT`}
              </button>
              <p className="note">
                Amounts are what each window will actually pay. If a validator was slashed
                while a window was unbonding, the shortfall is shared across everyone in it.
              </p>
            </>
          )}
        </div>

        <div className="panel">
          <h2 className="h2">What is and is not private</h2>
          <p className="note" style={{ marginTop: 0 }}>
            <strong style={{ color: "var(--ink)" }}>Private:</strong> your dSCRT balance and
            transfers, and the link between a deposit and whoever ends up holding it.
          </p>
          <p className="note">
            <strong style={{ color: "var(--ink)" }}>Public:</strong> deposits and
            withdrawals, the protocol&apos;s delegations, the exchange rate, and every
            window&apos;s size. Secret encrypts contract state, not the bank or staking
            modules.
          </p>
        </div>
      </div>
    </div>
  );
}
