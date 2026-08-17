"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Alert, Check, Clock, Info, Spinner } from "@/components/Icon";
import { readable, useToast } from "@/components/Toast";
import { Unconfigured } from "@/components/Unconfigured";
import { useWallet } from "@/components/Wallet";
import { CONFIGURED, fromMicro, whenFrom } from "@/lib/chain";
import {
  fetchConfig,
  fetchState,
  fetchWindows,
  gasCost,
  runUpkeep,
  upkeepGas,
  type Config,
  type ProtocolState,
  type UnbondWindow,
} from "@/lib/protocol";
import { assess, liveRewards, type UpkeepItem } from "@/lib/upkeep";

/**
 * Run the protocol's upkeep from a browser.
 *
 * Every task the keeper performs is a permissionless message: the contract checks whether
 * the work is due, never who is asking. That has always been true and was always the point
 * — it is what makes the keeper replaceable rather than trusted — but until now taking
 * advantage of it meant running a server. This is the same thing with a button.
 *
 * Deliberately not in the navigation. It is for someone who already knows what a keeper is
 * and has a reason to care; putting it beside Stake would invite people to pay gas for
 * work they have no stake in, which is a poor trade for them.
 *
 * The honest framing, which the page states rather than hides: this costs you gas and pays
 * you nothing. If you hold dSCRT, compounding raises what your shares are worth, and that
 * is the whole of the incentive.
 */
export default function KeeperPage() {
  const { connection, connectWallet, connecting } = useWallet();
  const toast = useToast();

  const [state, setState] = useState<ProtocolState | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [windows, setWindows] = useState<UnbondWindow[]>([]);
  const [rewards, setRewards] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [s, c, w, r] = await Promise.all([
        fetchState(),
        fetchConfig(),
        fetchWindows(),
        liveRewards(),
      ]);
      setState(s);
      setConfig(c);
      setWindows(w);
      setRewards(r);
      setFailed(null);
    } catch (e) {
      // Saying "nothing is due" here would be a lie — the page does not know. The one
      // thing it must never do is talk somebody out of running upkeep that is overdue.
      setFailed(readable(e));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!CONFIGURED) return;
    void refresh();
    // A window can fall due while the page is open, so re-judge on a clock as well as on a
    // reload.
    const timer = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const items = useMemo(
    () => assess(state, config, windows, rewards),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, config, windows, rewards, tick],
  );

  const due = items.filter((i) => i.due);
  const validators = config?.validator_allowlist.length;
  const limit = upkeepGas(validators, Math.max(1, due.length));
  const fee = gasCost(limit);

  const run = async () => {
    if (!connection) return void connectWallet();

    const id = toast.show("pending", "Confirm in your wallet…");
    setBusy(true);
    try {
      await runUpkeep(
        connection,
        due.map((i) => i.task),
        validators,
      );
      toast.resolve(id, "ok", `Ran ${due.length} task${due.length === 1 ? "" : "s"}. Thank you.`);
      await refresh();
    } catch (e) {
      toast.resolve(id, "error", readable(e));
    } finally {
      setBusy(false);
    }
  };

  if (!CONFIGURED) return <Unconfigured />;

  return (
    <div className="centred">
      <div style={{ width: "min(640px, 100%)" }}>
        <header style={{ marginBottom: "var(--s-6)" }}>
          <p className="eyebrow">Anyone can run this</p>
          <h1 className="h1" style={{ marginTop: 6 }}>
            Upkeep
          </h1>
          <p className="prose" style={{ marginTop: "var(--s-3)", maxWidth: "58ch" }}>
            This protocol needs a few jobs done on a schedule — harvesting rewards, closing
            the withdrawal window, booking what has finished unbonding. The contract checks
            whether each is <em>due</em>, never who is asking, so you can do them yourself.
          </p>
        </header>

        {loading ? (
          <div className="panel empty">
            <Spinner />
            <p className="hint">Reading the protocol…</p>
          </div>
        ) : failed ? (
          <div className="card" style={{ padding: "var(--s-5)" }}>
            <div className="notice notice--bad">
              <Alert size={16} />
              <span>{failed}</span>
            </div>
            <p className="prose" style={{ marginTop: "var(--s-4)" }}>
              Nothing could be read from the contract, so this page cannot say whether any
              upkeep is due. It is not saying there is none.
            </p>
            <button
              className="btn btn--block"
              style={{ marginTop: "var(--s-4)" }}
              onClick={() => {
                setLoading(true);
                void refresh();
              }}
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            <div className="card" style={{ padding: "var(--s-5)" }}>
              <div className="row" style={{ marginBottom: "var(--s-4)" }}>
                <h2 className="h2">
                  {due.length === 0
                    ? "Nothing is due"
                    : `${due.length} job${due.length === 1 ? "" : "s"} ready`}
                </h2>
                {state && (
                  <span className={`pill ${state.is_unattended ? "pill--warn" : "pill--good"}`}>
                    <span className="dot" />
                    {state.is_unattended ? "unattended" : "attended"}
                  </span>
                )}
              </div>

              <div className="stack" style={{ gap: "var(--s-2)" }}>
                {items.map((item) => (
                  <Item key={item.task} item={item} />
                ))}
              </div>

              {due.length > 0 && (
                <>
                  <div className="row" style={{ marginTop: "var(--s-5)" }}>
                    <span className="k">Transaction fee</span>
                    <span className="v num">
                      ≈ {fromMicro(fee, 4)} SCRT
                      <span className="faint" style={{ fontWeight: 400 }}>
                        {" "}
                        · {limit.toLocaleString()} gas
                      </span>
                    </span>
                  </div>
                  {due.length > 1 && (
                    <p className="hint" style={{ marginTop: 6 }}>
                      All {due.length} go in one transaction, so they share a single base
                      cost instead of paying it {due.length} times.
                    </p>
                  )}
                </>
              )}

              <button
                className="btn btn--block btn--lg"
                style={{ marginTop: "var(--s-4)" }}
                onClick={run}
                disabled={connection ? busy || due.length === 0 : connecting}
              >
                {busy && <Spinner size={16} />}
                {!connection
                  ? "Connect wallet"
                  : busy
                    ? "Confirming…"
                    : due.length === 0
                      ? "Nothing to do"
                      : `Run upkeep`}
              </button>
            </div>

            <div className="panel" style={{ marginTop: "var(--s-4)" }}>
              <h2 className="h2" style={{ marginBottom: "var(--s-3)" }}>
                What this costs you
              </h2>
              <p className="prose">
                Gas, and nothing comes back. There is no bounty and no reward for running
                upkeep — if there were, it would come out of the same pool it is meant to
                protect.
              </p>
              <p className="prose" style={{ marginTop: "var(--s-3)" }}>
                <strong>The reason to do it anyway:</strong> if you hold dSCRT, compounding
                is what makes your shares worth more. Rewards sitting unharvested earn
                nothing. You are paying a fraction of a SCRT to move the rate for everyone,
                including yourself.
              </p>
              <p className="prose" style={{ marginTop: "var(--s-3)" }}>
                None of it can touch anyone&apos;s funds. These messages have no privileged
                access — the contract accepts them from any address precisely because they
                cannot do harm.
              </p>
              {state && (
                <div className="row" style={{ marginTop: "var(--s-4)" }}>
                  <span className="k">Last upkeep</span>
                  <span className="v">{whenFrom(state.last_sync_time)}</span>
                </div>
              )}
            </div>

            <div className="notice" style={{ marginTop: "var(--s-4)" }}>
              <Info size={15} />
              <span>
                Doing this continuously is what the keeper bot in the repository is for.
                Nobody needs to run it for you to reach your own money — deposits,
                withdrawals and claims all take care of themselves.
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Item({ item }: { item: UpkeepItem }) {
  return (
    <div
      className="well"
      style={{
        display: "flex",
        gap: "var(--s-3)",
        alignItems: "flex-start",
        borderColor: item.due ? "var(--accent)" : undefined,
      }}
    >
      <span
        style={{
          color: item.due ? "var(--accent)" : "var(--ink-3)",
          display: "flex",
          marginTop: 2,
        }}
      >
        {item.due ? <Alert size={16} /> : <Check size={16} />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row" style={{ minHeight: 0 }}>
          <span className="h3">{item.title}</span>
          {item.due ? (
            <span className="pill pill--accent">due</span>
          ) : (
            <span className="faint" style={{ fontSize: 12 }}>
              <Clock size={11} /> not yet
            </span>
          )}
        </div>
        <p className="hint" style={{ marginTop: 4 }}>
          {item.detail}
        </p>
        {item.due && (
          <p className="hint" style={{ marginTop: 4, color: "var(--ink-2)" }}>
            {item.effect}
          </p>
        )}
      </div>
    </div>
  );
}
