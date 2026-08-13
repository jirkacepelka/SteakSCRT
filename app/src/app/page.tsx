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
  deposit,
  fetchConfig,
  fetchScrtBalance,
  fetchState,
  fetchTokenBalance,
  fetchWindows,
  requestUnbond,
  type Config,
  type ProtocolState,
  type UnbondWindow,
} from "@/lib/protocol";

type Mode = "stake" | "unstake";

export default function StakePage() {
  const { connection, address } = useWallet();
  const [mode, setMode] = useState<Mode>("stake");
  const [amount, setAmount] = useState("");
  const [feedback, setFeedback] = useState<Feedback>({ kind: "idle" });

  const [config, setConfig] = useState<Config | null>(null);
  const [state, setState] = useState<ProtocolState | null>(null);
  const [openWindow, setOpenWindow] = useState<UnbondWindow | null>(null);
  /** Micro-denominated balance of whichever asset the current mode spends. */
  const [balance, setBalance] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [c, s, w] = await Promise.all([
        fetchConfig(),
        fetchState(),
        fetchWindows("open"),
      ]);
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

  // SCRT is a public bank balance and needs no permission. dSCRT is private state on the
  // token contract, so reading it needs the same permit the rest of the app uses — which
  // is why the balance only appears once the user has signed one.
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
        // A refused signature is a choice, not an error worth shouting about; the
        // shortcuts simply stay unavailable.
        setBalance(null);
      }
    })();
  }, [connection, address, mode]);

  const rate = state ? rateToNumber(state.exchange_rate) : 1;
  const parsed = Number(amount);
  const converted = Number.isFinite(parsed) && parsed > 0
    ? mode === "stake"
      ? parsed / rate
      : parsed * rate
    : 0;

  /**
   * When a withdrawal requested now would actually pay out.
   *
   * Shown on the unstake screen rather than buried in a tooltip. A user who presses
   * "unstake" expecting an instant swap and finds their money gone for three weeks has
   * been misled by the interface, not by the chain.
   */
  const maturity = useMemo(() => {
    if (!config || !openWindow) return null;
    const closes = openWindow.closes_at;
    return {
      closes,
      matures: closes + config.params.unbonding_period_secs,
      windowId: openWindow.id,
    };
  }, [config, openWindow]);

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
            ? `Withdrawal requested. It joins window ${maturity.windowId}, claimable from about ${whenFrom(maturity.matures)}.`
            : "Withdrawal requested.",
        });
      }
      setAmount("");
      void refresh();
    } catch (e) {
      setFeedback({ kind: "err", message: readable(e) });
    }
  };

  const busy = feedback.kind === "busy";
  const stale = state?.is_stale ?? false;

  return (
    <div className="grid">
      <div>
        <div className="card">
          <div className="toggle">
            <button aria-pressed={mode === "stake"} onClick={() => setMode("stake")}>
              Stake
            </button>
            <button aria-pressed={mode === "unstake"} onClick={() => setMode("unstake")}>
              Unstake
            </button>
          </div>

          <p className="card-title">
            {mode === "stake" ? "You stake" : "You return"}
          </p>

          <div className="amount">
            <input
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            />
            <span className="denom">{mode === "stake" ? "SCRT" : "dSCRT"}</span>
          </div>

          <div className="chips">
            {([25, 50, 75, 100] as const).map((pct) => (
              <button
                key={pct}
                className="chip"
                disabled={!balance || balance === "0"}
                onClick={() => {
                  if (!balance) return;
                  // Leave a little SCRT behind on "Max" so the transaction can still pay
                  // its own gas; spending the lot is a footgun, not a feature.
                  const reserve = mode === "stake" && pct === 100 ? 500_000n : 0n;
                  const usable = BigInt(balance) > reserve ? BigInt(balance) - reserve : 0n;
                  const chosen = (usable * BigInt(pct)) / 100n;
                  setAmount((Number(chosen) / 1e6).toFixed(6));
                }}
              >
                {pct === 100 ? "Max" : `${pct}%`}
              </button>
            ))}
          </div>

          {balance && (
            <p className="note" style={{ marginTop: 10 }}>
              Balance {fromMicro(balance)} {mode === "stake" ? "SCRT" : "dSCRT"}
              {mode === "stake" && " — Max leaves 0.5 SCRT for gas"}
            </p>
          )}

          <div style={{ marginTop: 26 }}>
            <div className="row">
              <span className="k">You receive</span>
              <span className="v numeral">
                {converted.toFixed(6)} {mode === "stake" ? "dSCRT" : "SCRT"}
              </span>
            </div>
            <div className="row">
              <span className="k">Exchange rate</span>
              <span className="v numeral">1 dSCRT = {rate.toFixed(6)} SCRT</span>
            </div>
            <div className="row">
              <span className="k">Performance fee</span>
              <span className="v">
                {config ? `${config.params.performance_fee_bps / 100}% of rewards` : "—"}
              </span>
            </div>
          </div>

          {stale && (
            <div className="status status--err">
              The protocol&apos;s cached totals are stale, so deposits and withdrawals are
              refused until someone runs a sync. Nobody&apos;s funds are at risk — the
              contract is refusing to price against figures it no longer trusts.
            </div>
          )}

          <button
            className="btn"
            onClick={submit}
            disabled={!connection || busy || stale || !amount}
          >
            {!connection
              ? "Connect wallet"
              : busy
                ? "Confirm in wallet…"
                : mode === "stake"
                  ? "Stake SCRT"
                  : "Request withdrawal"}
          </button>

          <Status feedback={feedback} />
        </div>
      </div>

      <div>
        {mode === "unstake" ? (
          <div className="card card--queue">
            <p className="card-title">When you get paid</p>
            <p className="big numeral">
              {config ? `${Math.round(config.params.unbonding_period_secs / 86_400)}–${Math.round((config.params.unbonding_period_secs + config.params.unbond_window_secs) / 86_400)} days` : "—"}
            </p>
            {maturity && (
              <div style={{ marginTop: 18 }}>
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
              Withdrawals are batched. Cosmos allows only seven concurrent unbonding entries
              per validator and this protocol is a single delegator, so requests are pooled
              into windows and one undelegation per validator is issued when a window
              closes. Your SCRT is locked for the chain&apos;s unbonding period after that,
              and earns nothing while it unbonds.
            </p>
          </div>
        ) : (
          <div className="card card--yield">
            <p className="card-title">Staked with the protocol</p>
            <p className="big numeral">
              {state ? fromMicro(state.total_bonded, 0) : "—"} <span style={{ fontSize: 17 }}>SCRT</span>
            </p>
            <div style={{ marginTop: 18 }}>
              <div className="row">
                <span className="k">dSCRT in circulation</span>
                <span className="v numeral">
                  {state ? fromMicro(state.total_supply, 0) : "—"}
                </span>
              </div>
              <div className="row">
                <span className="k">Rewards awaiting compound</span>
                <span className="v numeral">
                  {state ? fromMicro(state.pending_rewards) : "—"}
                </span>
              </div>
              <div className="row">
                <span className="k">Last synced</span>
                <span className="v">
                  {state ? whenFrom(state.last_sync_time) : "—"}
                </span>
              </div>
            </div>
            <p className="note">
              dSCRT does not rebase. Your balance stays put and its value against SCRT rises
              as rewards compound.
            </p>
          </div>
        )}

        <div className="card card--dark">
          <p className="card-title">What is and is not private</p>
          <p className="note">
            <strong style={{ color: "var(--on-shell)" }}>Private:</strong> your dSCRT balance
            and transfers, and the link between a deposit and whoever ends up holding it.
            <br />
            <br />
            <strong style={{ color: "var(--on-shell)" }}>Public:</strong> deposits and
            withdrawals themselves, the protocol&apos;s delegations, the exchange rate, and
            every window&apos;s size. Secret encrypts contract state, not the bank or
            staking modules — anyone claiming a Secret LST makes staking anonymous is
            overselling it.
          </p>
        </div>
      </div>
    </div>
  );
}
