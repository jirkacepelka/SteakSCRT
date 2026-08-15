"use client";

import { useEffect, useMemo, useState } from "react";

import { Status, readable, type Feedback } from "@/components/Status";
import { Unconfigured } from "@/components/Unconfigured";
import { useWallet } from "@/components/Wallet";
import {
  CONFIGURED,
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
    if (!CONFIGURED) return;
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

      // The gas limit scales with the validator set, because pricing re-reads all of it.
      const validators = config?.validator_allowlist.length;

      if (mode === "stake") {
        await deposit(connection, micro, validators);
        setFeedback({ kind: "ok", message: `Staked ${amount} SCRT.` });
      } else {
        await requestUnbond(connection, micro, validators);
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

  if (!CONFIGURED) return <Unconfigured />;

  const busy = feedback.kind === "busy";
  const symbol = mode === "stake" ? "SCRT" : "dSCRT";

  return (
    <div className="center-block">
      <div className="stack">
        <div className="segmented">
          <button aria-pressed={mode === "stake"} onClick={() => setMode("stake")}>
            Stake
          </button>
          <button aria-pressed={mode === "unstake"} onClick={() => setMode("unstake")}>
            Unstake
          </button>
        </div>

        <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <p className="label">{mode === "stake" ? "You stake" : "You return"}</p>

          <div className="amount">
            <input
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            />
            <span className="denom">
              {/* One mark for both sides: dSCRT is a claim on SCRT, not a separate asset. */}
              <img className="denom-mark" src="/brand/scrt.png" alt="" width={30} height={30} />
              {symbol}
            </span>
          </div>

          <p className="label">
            {balance
              ? `Balance ${fromMicro(balance)} ${symbol}`
              : connection
                ? "—"
                : "Connect to see your balance"}
          </p>
        </div>

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
        {mode === "unstake" && (
          <div className="row">
            <span className="k">Claimable from</span>
            <span className="v">{maturity ? whenFrom(maturity.matures) : "—"}</span>
          </div>
        )}

        <button className="btn" onClick={submit} disabled={!connection || busy || !amount}>
          {!connection
            ? "Connect wallet"
            : busy
              ? "Confirm in wallet…"
              : mode === "stake"
                ? "Stake"
                : "Request withdrawal"}
        </button>

        {feedback.kind !== "idle" && <Status feedback={feedback} />}

        {mode === "unstake" && (
          <Withdrawals
            config={config}
            claims={claims}
            connected={Boolean(connection)}
            busy={busy}
            onLoad={loadClaims}
            onClaim={claim}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The user's own withdrawals, at the foot of the unstake tab.
 *
 * Below the form rather than beside it: it is what you look at after requesting, and the
 * design has no second column to put it in.
 */
function Withdrawals({
  config,
  claims,
  connected,
  busy,
  onLoad,
  onClaim,
}: {
  config: Config | null;
  claims: PendingClaims | null;
  connected: boolean;
  busy: boolean;
  onLoad: () => Promise<void>;
  onClaim: () => Promise<void>;
}) {
  const wait = config
    ? `${Math.round(config.params.unbonding_period_secs / 86_400)}–${Math.round(
        (config.params.unbonding_period_secs + config.params.unbond_window_secs) / 86_400,
      )} days`
    : "—";

  return (
    <div className="panel" style={{ marginTop: 10 }}>
      <div className="row" style={{ marginBottom: 14 }}>
        <span className="h2" style={{ margin: 0 }}>
          Your withdrawals
        </span>
        <span className="v numeral">{wait}</span>
      </div>

      {!connected ? (
        <p className="note">
          Connect a wallet to see your position. Claims are private contract state, read
          with a permit you sign rather than with anything stored here.
        </p>
      ) : !claims ? (
        <>
          <p className="note" style={{ marginBottom: 14 }}>
            One signature covers the whole app. It is a signature rather than a transaction,
            so it costs nothing.
          </p>
          <button className="btn btn--ghost btn--md" onClick={onLoad} disabled={busy}>
            Sign permit
          </button>
        </>
      ) : claims.claims.length === 0 ? (
        <p className="note">No withdrawal requests yet.</p>
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
            className="btn btn--md"
            style={{ marginTop: 16 }}
            onClick={onClaim}
            disabled={claims.total_claimable_now === "0" || busy}
          >
            {claims.total_claimable_now === "0"
              ? "Nothing to claim yet"
              : `Claim ${fromMicro(claims.total_claimable_now)} SCRT`}
          </button>
          <p className="note" style={{ marginTop: 10 }}>
            Amounts are what each window will actually pay. If a validator was slashed while
            a window was unbonding, the shortfall is shared across everyone in it.
          </p>
        </>
      )}
    </div>
  );
}
