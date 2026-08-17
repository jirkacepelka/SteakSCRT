"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChevronDown, Clock, Info, Spinner } from "@/components/Icon";
import { readable, useToast } from "@/components/Toast";
import { TokenIcon } from "@/components/TokenIcon";
import { Unconfigured } from "@/components/Unconfigured";
import { useWallet } from "@/components/Wallet";
import {
  CONFIGURED,
  fromMicro,
  getPermit,
  hasPermit,
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

/** Held back by Max, so a deposit of "everything" can still pay its own fee. */
const GAS_RESERVE = 500_000n;


export default function StakePage() {
  const { connection, address, connectWallet, connecting } = useWallet();
  const toast = useToast();

  const [mode, setMode] = useState<Mode>("stake");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const [config, setConfig] = useState<Config | null>(null);
  const [state, setState] = useState<ProtocolState | null>(null);
  const [openWindow, setOpenWindow] = useState<UnbondWindow | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [claims, setClaims] = useState<PendingClaims | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [c, s, w] = await Promise.all([fetchConfig(), fetchState(), fetchWindows("open")]);
      setConfig(c);
      setState(s);
      setOpenWindow(w[0] ?? null);
    } catch {
      // The screen keeps its last good figures; the toast on the next action will say more.
    }
  }, []);

  useEffect(() => {
    if (!CONFIGURED) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // SCRT is a public bank balance. dSCRT is private contract state, so it needs the permit
  // — which is why it only appears once the user has signed one.
  useEffect(() => {
    setBalance(null);
    if (!connection || !address) return;
    let cancelled = false;

    void (async () => {
      try {
        const next =
          mode === "stake"
            ? await fetchScrtBalance(connection.client, address)
            : await fetchTokenBalance(connection.client, await getPermit(address));
        if (!cancelled) setBalance(next);
      } catch {
        if (!cancelled) setBalance(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connection, address, mode]);

  const rate = state ? rateToNumber(state.exchange_rate) : 1;
  const parsed = Number(amount);
  const valid = Number.isFinite(parsed) && parsed > 0;
  const converted = valid ? (mode === "stake" ? parsed / rate : parsed * rate) : 0;

  const overBalance = useMemo(() => {
    if (!valid || !balance) return false;
    return BigInt(Math.round(parsed * 1e6)) > BigInt(balance);
  }, [valid, parsed, balance]);

  /**
   * When a withdrawal requested now would actually pay out.
   *
   * On the screen rather than behind a tooltip. Someone pressing "unstake" expecting a
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

  /** `quiet` is the automatic attempt — see the same argument on the account panel. */
  const loadClaims = useCallback(
    async (quiet = false) => {
      if (!connection || !address) return;
      try {
        setClaims(await fetchPendingClaims(connection.client, await getPermit(address)));
      } catch (e) {
        if (!quiet) toast.show("error", readable(e));
      }
    },
    [connection, address, toast],
  );

  /*
   * Load the withdrawal list unasked, once a permit exists.
   *
   * The button behind this said "Sign permit", which stopped being true the moment one was
   * cached: it signed nothing and prompted nothing, it just made the user click to see
   * their own queue again after every reload.
   */
  const autoLoaded = useRef<string | null>(null);
  useEffect(() => {
    if (!connection || !address) return;
    if (!hasPermit(address)) return;
    if (autoLoaded.current === address) return;
    autoLoaded.current = address;
    void loadClaims(true);
  }, [connection, address, loadClaims]);

  const submit = async () => {
    if (!connection) return void connectWallet();

    const id = toast.show("pending", "Confirm in your wallet…");
    setBusy(true);
    try {
      const micro = toMicro(amount);
      const validators = config?.validator_allowlist.length;

      if (mode === "stake") {
        await deposit(connection, micro, validators);
        toast.resolve(id, "ok", `Staked ${amount} SCRT.`);
      } else {
        await requestUnbond(connection, micro, validators);
        toast.resolve(
          id,
          "ok",
          maturity
            ? `Requested. Claimable from ${whenFrom(maturity.matures)}.`
            : "Withdrawal requested.",
        );
      }
      setAmount("");
      void refresh();
      if (claims) void loadClaims();
    } catch (e) {
      toast.resolve(id, "error", readable(e));
    } finally {
      setBusy(false);
    }
  };

  const claim = async () => {
    if (!connection) return;
    const id = toast.show("pending", "Confirm in your wallet…");
    setBusy(true);
    try {
      await claimMatured(connection);
      toast.resolve(id, "ok", "Claimed.");
      await loadClaims();
    } catch (e) {
      toast.resolve(id, "error", readable(e));
    } finally {
      setBusy(false);
    }
  };

  if (!CONFIGURED) return <Unconfigured />;

  const paused = config?.paused ?? false;
  const symbol = mode === "stake" ? "SCRT" : "dSCRT";
  const outSymbol = mode === "stake" ? "dSCRT" : "SCRT";
  const disabled = !valid || busy || overBalance || (mode === "stake" && paused);

  const label = !connection
    ? "Connect wallet"
    : busy
      ? "Confirming…"
      : !valid
        ? "Enter an amount"
        : overBalance
          ? `Not enough ${symbol}`
          : mode === "stake"
            ? paused
              ? "Deposits paused"
              : "Stake"
            : "Request withdrawal";

  return (
    <div className="centred">
      <div style={{ width: "min(var(--card), 100%)" }}>
        <div className="card" style={{ padding: "var(--s-4)" }}>
          <div className="segmented segmented--full" style={{ marginBottom: "var(--s-4)" }}>
            <button aria-pressed={mode === "stake"} onClick={() => setMode("stake")}>
              Stake
            </button>
            <button aria-pressed={mode === "unstake"} onClick={() => setMode("unstake")}>
              Unstake
            </button>
          </div>

          <div className="amount">
            <div className="amount-head">
              <span>{mode === "stake" ? "You stake" : "You return"}</span>
              {balance && (
                <span>
                  Balance <span className="num">{fromMicro(balance)}</span>
                </span>
              )}
            </div>

            <div className="amount-row">
              <input
                inputMode="decimal"
                placeholder="0"
                aria-label={`Amount of ${symbol}`}
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, "").slice(0, 20))}
              />
              <span className="token">
                <TokenIcon symbol={symbol} size={24} />
                {symbol}
              </span>
            </div>

            {balance && balance !== "0" && (
              <div className="amount-chips">
                {([25, 50, 100] as const).map((pct) => (
                  <button
                    key={pct}
                    className="mini"
                    onClick={() => {
                      // Max keeps a little SCRT back so the transaction can pay its own
                      // gas. Spending the lot is a footgun, not a feature.
                      const reserve = mode === "stake" && pct === 100 ? GAS_RESERVE : 0n;
                      const usable = BigInt(balance) > reserve ? BigInt(balance) - reserve : 0n;
                      setAmount((Number((usable * BigInt(pct)) / 100n) / 1e6).toFixed(6));
                    }}
                  >
                    {pct === 100 ? "Max" : `${pct}%`}
                  </button>
                ))}
              </div>
            )}

            {overBalance && (
              <span style={{ fontSize: 12.5, color: "var(--bad)" }}>More than you hold</span>
            )}
          </div>

          {mode === "unstake" && maturity && (
            <div className="notice" style={{ marginTop: "var(--s-4)" }}>
              <Clock size={15} />
              <span>
                Withdrawals are batched. This one joins window #{maturity.windowId} and
                becomes claimable on{" "}
                <strong style={{ color: "var(--ink)" }}>{whenFrom(maturity.matures)}</strong>.
              </span>
            </div>
          )}

          {mode === "stake" && paused && (
            <div className="notice notice--warn" style={{ marginTop: "var(--s-4)" }}>
              <Info size={15} />
              <span>Deposits are paused. Withdrawals and claims are unaffected.</span>
            </div>
          )}

          <details className="details" style={{ marginTop: "var(--s-3)" }}>
            <summary>
              <span>You receive</span>
              <span className="result">
                <span className="num">{converted > 0 ? converted.toFixed(6) : "0"}</span>
                <span className="unit">{outSymbol}</span>
                <ChevronDown size={16} />
              </span>
            </summary>
            <div className="details-body">
              <div className="row">
                <span className="k">Exchange rate</span>
                <span className="v num">1 dSCRT = {rate.toFixed(5)} SCRT</span>
              </div>
              <div className="row">
                <span className="k">Performance fee</span>
                <span className="v num">
                  {config ? `${config.params.performance_fee_bps / 100}%` : <Skeleton w={38} />}
                </span>
              </div>
              {/*
                * Only where it changes a decision. Staking has nothing to wait for, so the
                * unbonding figure there is trivia; on the way out it is the single thing
                * most likely to surprise somebody, and it belongs in front of them.
                */}
              {mode === "unstake" && (
                <div className="row">
                  <span className="k">Withdrawal wait</span>
                  <span className="v">
                    {config
                      ? `${Math.round(config.params.unbonding_period_secs / 86_400)}–${Math.round(
                          (config.params.unbonding_period_secs + config.params.unbond_window_secs) /
                            86_400,
                        )} days`
                      : <Skeleton w={60} />}
                  </span>
                </div>
              )}
            </div>
          </details>

          <button
            className="btn btn--block btn--lg"
            style={{ marginTop: "var(--s-2)" }}
            onClick={submit}
            disabled={connection ? disabled : connecting}
          >
            {busy && <Spinner size={16} />}
            {label}
          </button>
        </div>

        {mode === "unstake" && (
          <Withdrawals
            connected={Boolean(connection)}
            signed={Boolean(address) && hasPermit(address as string)}
            claims={claims}
            busy={busy}
            onLoad={() => loadClaims()}
            onClaim={claim}
          />
        )}

        <p className="hint" style={{ marginTop: "var(--s-5)", textAlign: "center" }}>
          Your dSCRT balance and transfers are private. Deposits, withdrawals and the
          exchange rate are public — Secret encrypts contract state, not the bank or staking
          modules.
        </p>
      </div>
    </div>
  );
}

function Skeleton({ w }: { w: number }) {
  return <span className="skel" style={{ width: w, height: 14 }} />;
}

/**
 * The user's own withdrawals, below the card.
 *
 * Only rendered once there is something to say. An empty table under every visit is noise,
 * and this is the one part of the screen that needs a signature to read at all.
 */
function Withdrawals({
  connected,
  signed,
  claims,
  busy,
  onLoad,
  onClaim,
}: {
  connected: boolean;
  /** A permit is already cached, so the button ahead asks for no signature. */
  signed: boolean;
  claims: PendingClaims | null;
  busy: boolean;
  onLoad: () => Promise<void>;
  onClaim: () => Promise<void>;
}) {
  if (!connected) return null;

  if (!claims) {
    return (
      <div className="panel" style={{ marginTop: "var(--s-4)" }}>
        <div className="row">
          <div>
            <h3 className="h3">Your withdrawals</h3>
            <p className="hint" style={{ marginTop: 2 }}>
              {signed
                ? "Private contract state. Nothing loaded — try again."
                : "Private contract state. One signature covers the whole app and costs nothing."}
            </p>
          </div>
          {/*
            * The label has to tell the truth about what the click does. With a permit
            * already cached it signs nothing and prompts nothing, so calling it "Sign
            * permit" would be asking for a signature that will never be requested.
            */}
          <button className="btn btn--quiet btn--sm" onClick={onLoad} disabled={busy}>
            {signed ? "Retry" : "Sign permit"}
          </button>
        </div>
      </div>
    );
  }

  if (claims.claims.length === 0) return null;

  const ready = claims.total_claimable_now !== "0";

  return (
    <div className="panel" style={{ marginTop: "var(--s-4)" }}>
      <div className="row" style={{ marginBottom: "var(--s-3)" }}>
        <h3 className="h3">Your withdrawals</h3>
        {ready && (
          <span className="pill pill--good">
            <span className="dot" />
            {fromMicro(claims.total_claimable_now)} SCRT ready
          </span>
        )}
      </div>

      <table className="plain">
        <thead>
          <tr>
            <th>Window</th>
            <th>Amount</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {claims.claims.map((c) => (
            <tr key={c.window_id}>
              <td className="num faint">#{c.window_id}</td>
              <td className="num">{fromMicro(c.scrt_owed)} SCRT</td>
              <td>
                {c.claimed ? (
                  <span className="pill">paid</span>
                ) : c.state === "matured" ? (
                  <span className="pill pill--good">ready</span>
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

      {ready && (
        <button
          className="btn btn--block"
          style={{ marginTop: "var(--s-4)" }}
          onClick={onClaim}
          disabled={busy}
        >
          {busy && <Spinner size={16} />}
          Claim {fromMicro(claims.total_claimable_now)} SCRT
        </button>
      )}

      <p className="hint" style={{ marginTop: "var(--s-3)" }}>
        Amounts are what each window will actually pay. If a validator was slashed while a
        window was unbonding, the shortfall is shared across everyone in it.
      </p>
    </div>
  );
}
