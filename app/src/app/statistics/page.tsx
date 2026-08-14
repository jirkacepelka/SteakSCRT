"use client";

import { useEffect, useMemo, useState } from "react";

import { BarList, LineChart } from "@/components/Chart";
import { Unconfigured } from "@/components/Unconfigured";
import { CONFIGURED, fromMicro, rateToNumber, shortAddress, whenFrom } from "@/lib/chain";
import { fetchHistory, type History, type Range } from "@/lib/history";
import {
  fetchConfig,
  fetchState,
  fetchValidators,
  fetchWindows,
  type Config,
  type ProtocolState,
  type UnbondWindow,
  type ValidatorEntry,
} from "@/lib/protocol";

const RANGES: Range[] = ["24h", "7d", "30d"];

export default function StatisticsPage() {
  const [state, setState] = useState<ProtocolState | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [validators, setValidators] = useState<ValidatorEntry[]>([]);
  const [windows, setWindows] = useState<UnbondWindow[]>([]);

  const [range, setRange] = useState<Range>("7d");
  const [history, setHistory] = useState<History | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);

  useEffect(() => {
    if (!CONFIGURED) return;
    void (async () => {
      const [s, c, v, w] = await Promise.all([
        fetchState(),
        fetchConfig(),
        fetchValidators(),
        fetchWindows(),
      ]);
      setState(s);
      setConfig(c);
      setValidators(v);
      setWindows(w);
    })().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!CONFIGURED) return;
    let cancelled = false;
    setLoadingHistory(true);
    void fetchHistory(range)
      .then((h) => {
        if (!cancelled) setHistory(h);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const tvlPoints = useMemo(
    () =>
      (history?.samples ?? []).map((s) => ({
        x: s.time,
        // TVL is what the protocol actually holds: delegated, plus rewards not yet
        // compounded, plus anything sitting undeployed.
        y:
          (Number(s.state.total_bonded) +
            Number(s.state.pending_rewards) +
            Number(s.state.liquid_unallocated)) /
          1e6,
      })),
    [history],
  );

  const ratePoints = useMemo(
    () =>
      (history?.samples ?? []).map((s) => ({
        x: s.time,
        y: rateToNumber(s.state.exchange_rate),
      })),
    [history],
  );

  const totalBonded = validators.reduce((sum, v) => sum + Number(v.bonded), 0);
  const active = validators.filter((v) => v.status !== "removed");

  /**
   * Annualised from the observed rate rather than from the chain's nominal staking APR.
   *
   * The nominal figure ignores this protocol's fee and its idle cash. What holders
   * actually earn is how fast the exchange rate moved, so that is what gets shown — and
   * only once there is enough of a window to mean anything.
   */
  const observedApy = useMemo(() => {
    const samples = history?.samples ?? [];
    if (samples.length < 2) return null;

    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    const days = (last.time - first.time) / 86_400;
    if (days < 0.5) return null;

    const from = rateToNumber(first.state.exchange_rate);
    const to = rateToNumber(last.state.exchange_rate);
    if (from <= 0 || to <= from) return null;

    return (Math.pow(to / from, 365 / days) - 1) * 100;
  }, [history]);

  const queued = windows
    .filter((w) => w.state === "open" || w.state === "unbonding")
    .reduce((sum, w) => sum + Number(w.scrt_owed), 0);

  const tvl = state
    ? Number(state.total_bonded) +
      Number(state.pending_rewards) +
      Number(state.liquid_unallocated)
    : 0;

  if (!CONFIGURED) return <Unconfigured />;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
          marginBottom: 20,
        }}
      >
        <h1 className="h1">Statistics</h1>
        <div className="segmented segmented--auto">
          {RANGES.map((r) => (
            <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Headline numbers first: most visits are one glance at TVL and the rate. */}
      <div className="grid-4">
        <div className="stat">
          <p className="label">Total value locked</p>
          <span className="stat-value numeral">
            {state ? fromMicro(tvl, 0) : "—"}
            <span className="stat-unit">SCRT</span>
          </span>
          <p className="stat-note">Delegated, plus rewards and undeployed cash</p>
        </div>

        <div className="stat">
          <p className="label">Exchange rate</p>
          <span className="stat-value numeral">
            {state ? rateToNumber(state.exchange_rate).toFixed(6) : "—"}
          </span>
          <p className="stat-note">SCRT per dSCRT — never falls except on a slashing</p>
        </div>

        <div className="stat">
          <p className="label">Observed APY</p>
          <span className="stat-value numeral">
            {observedApy !== null ? `${observedApy.toFixed(2)}%` : "—"}
          </span>
          <p className="stat-note">
            {observedApy !== null
              ? `From the rate over ${range}, net of fee`
              : "Needs a longer window"}
          </p>
        </div>

        <div className="stat">
          <p className="label">dSCRT supply</p>
          <span className="stat-value numeral">
            {state ? fromMicro(state.total_supply, 0) : "—"}
          </span>
          <p className="stat-note">Non-rebasing — this moves only on mint and burn</p>
        </div>
      </div>

      <div style={{ height: 16 }} />

      <div className="grid-2">
        <div className="panel">
          <h2 className="h2">Total value locked</h2>
          <LineChart
            points={tvlPoints}
            formatY={(v) => `${Math.round(v).toLocaleString()}`}
            formatX={(v) =>
              new Date(v * 1000).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
            }
          />
          <p className="note">
            SCRT denominated, so it moves with deposits and rewards rather than with the
            price. {loadingHistory && "Loading…"}
          </p>
        </div>

        <div className="panel">
          <h2 className="h2">Exchange rate</h2>
          <LineChart
            points={ratePoints}
            formatY={(v) => v.toFixed(5)}
            formatX={(v) =>
              new Date(v * 1000).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
            }
          />
          <p className="note">
            One dSCRT in SCRT. Rising is the yield; a fall would mean a validator was
            slashed.
          </p>
        </div>
      </div>

      <div style={{ height: 16 }} />

      <div className="grid-2">
        <div className="panel">
          <h2 className="h2">Where the stake sits</h2>
          <BarList
            data={active.map((v) => ({
              label: shortAddress(v.address),
              value: Number(v.bonded),
              display: `${((Number(v.bonded) / (totalBonded || 1)) * 100).toFixed(1)}%`,
              note:
                v.status === "draining"
                  ? "draining"
                  : `target ${(v.weight_bps / 100).toFixed(0)}%`,
            }))}
          />
          <p className="note">
            No validator may exceed{" "}
            {config ? `${config.limits.max_validator_weight_bps / 100}%` : "—"}, a ceiling
            compiled into the contract rather than configured. The incumbent SCRT
            derivative routes 64% to one operator.
          </p>
        </div>

        <div>
          <div className="panel">
            <h2 className="h2">Withdrawal queue</h2>
            <div className="row">
              <span className="k">Queued for withdrawal</span>
              <span className="v numeral">{fromMicro(queued, 2)} SCRT</span>
            </div>
            <div className="row">
              <span className="k">Windows in flight</span>
              <span className="v numeral">
                {windows.filter((w) => w.state === "unbonding").length}
              </span>
            </div>
            <div className="row">
              <span className="k">Ready to claim</span>
              <span className="v numeral">
                {windows.filter((w) => w.state === "matured").length}
              </span>
            </div>
            <div className="row">
              <span className="k">Entry slots used</span>
              <span className="v numeral">
                {validators.reduce((n, v) => n + v.active_unbond_entries, 0)} /{" "}
                {config
                  ? active.length * config.params.max_unbond_entries_per_validator
                  : "—"}
              </span>
            </div>
            <p className="note">
              Cosmos allows seven concurrent unbonding entries per validator and this
              protocol is a single delegator, which is why withdrawals are batched at all.
            </p>
          </div>

          <div className="panel">
            <h2 className="h2">Protocol</h2>
            <div className="row">
              <span className="k">Performance fee</span>
              <span className="v numeral">
                {config ? `${config.params.performance_fee_bps / 100}%` : "—"}
              </span>
            </div>
            <div className="row">
              <span className="k">Rewards awaiting compound</span>
              <span className="v numeral">
                {state ? fromMicro(state.pending_rewards, 4) : "—"} SCRT
              </span>
            </div>
            <div className="row">
              <span className="k">Undeployed</span>
              <span className="v numeral">
                {state ? fromMicro(state.liquid_unallocated, 4) : "—"} SCRT
              </span>
            </div>
            <div className="row">
              <span className="k">Last synced</span>
              <span className="v">{state ? whenFrom(state.last_sync_time) : "—"}</span>
            </div>
            <div className="row">
              <span className="k">Deposits</span>
              <span className="v">
                {config?.paused ? (
                  <span className="pill">paused</span>
                ) : (
                  <span className="pill pill--live">open</span>
                )}
              </span>
            </div>
          </div>
        </div>
      </div>

      {history && history.missing > 0 && (
        <p className="note">
          {history.missing} of {history.missing + history.samples.length} sampled blocks
          returned nothing — either they predate the deployment, or the public node has
          pruned that far back. The chart shows what the chain still holds rather than
          filling the gap in.
        </p>
      )}
    </div>
  );
}
