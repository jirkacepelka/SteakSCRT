"use client";

import { useEffect, useMemo, useState } from "react";

import { BarList, LineChart } from "@/components/Chart";
import { Info, Spinner } from "@/components/Icon";
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
  const [loading, setLoading] = useState(true);

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
    setLoading(true);
    void fetchHistory(range)
      .then((h) => !cancelled && setHistory(h))
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range]);

  const tvlPoints = useMemo(
    () =>
      (history?.samples ?? []).map((s) => ({
        x: s.time,
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

  /**
   * Annualised from the observed rate rather than from the chain's nominal staking APR.
   *
   * The nominal figure ignores this protocol's fee and its idle cash. What holders
   * actually earn is how fast the exchange rate moved, so that is what gets shown — and
   * only once there is enough of a window for it to mean anything.
   */
  const apy = useMemo(() => {
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

  if (!CONFIGURED) return <Unconfigured />;

  const tvl = state
    ? Number(state.total_bonded) +
      Number(state.pending_rewards) +
      Number(state.liquid_unallocated)
    : 0;

  const bondedTotal = validators.reduce((sum, v) => sum + Number(v.bonded), 0);
  const active = validators.filter((v) => v.status !== "removed");
  const queued = windows
    .filter((w) => w.state === "open" || w.state === "unbonding")
    .reduce((sum, w) => sum + Number(w.scrt_owed), 0);
  const slotsUsed = validators.reduce((n, v) => n + v.active_unbond_entries, 0);
  const slotCeiling = active.length * (config?.params.max_unbond_entries_per_validator ?? 6);

  return (
    <div className="stack" style={{ gap: "var(--s-6)" }}>
      <header
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: "var(--s-4)",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 className="h1">Statistics</h1>
          <p className="prose" style={{ marginTop: 6 }}>
            Read from the chain, including the history — there is no indexer behind this.
          </p>
        </div>
        <div className="segmented">
          {RANGES.map((r) => (
            <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
      </header>

      <section className="grid grid-4">
        <Stat
          label="Total value locked"
          value={state ? fromMicro(tvl, 0) : null}
          unit="SCRT"
          note="Delegated, plus rewards and undeployed cash"
        />
        <Stat
          label="Exchange rate"
          value={state ? rateToNumber(state.exchange_rate).toFixed(6) : null}
          note="SCRT per dSCRT — only falls on a slashing"
        />
        <Stat
          label="Observed APY"
          value={apy !== null ? `${apy.toFixed(2)}%` : "—"}
          note={apy !== null ? `From the rate over ${range}, net of fee` : "Needs a longer window"}
        />
        <Stat
          label="dSCRT supply"
          value={state ? fromMicro(state.total_supply, 0) : null}
          note="Non-rebasing — moves only on mint and burn"
        />
      </section>

      <section className="grid grid-2">
        <div className="panel">
          <div className="row" style={{ marginBottom: "var(--s-4)" }}>
            <h2 className="h2">Total value locked</h2>
            {loading && <Spinner size={14} />}
          </div>
          <LineChart
            points={tvlPoints}
            zeroBased
            formatY={(v) => compact(v)}
            formatX={stamp}
          />
          <p className="hint" style={{ marginTop: "var(--s-3)" }}>
            SCRT-denominated, so it moves with deposits and rewards rather than with the
            price.
          </p>
        </div>

        <div className="panel">
          <div className="row" style={{ marginBottom: "var(--s-4)" }}>
            <h2 className="h2">Exchange rate</h2>
            {loading && <Spinner size={14} />}
          </div>
          <LineChart points={ratePoints} formatY={(v) => v.toFixed(5)} formatX={stamp} />
          <p className="hint" style={{ marginTop: "var(--s-3)" }}>
            One dSCRT in SCRT. Rising is the yield; a fall would mean a validator was
            slashed.
          </p>
        </div>
      </section>

      {history && history.missing > 0 && (
        <div className="notice">
          <Info size={15} />
          <span>
            {history.missing} of {history.samples.length + history.missing} sampled blocks
            returned nothing — either older than this protocol, or pruned by the node.
          </span>
        </div>
      )}

      <section className="grid grid-2">
        <div className="panel">
          <h2 className="h2" style={{ marginBottom: "var(--s-4)" }}>
            Where the stake sits
          </h2>
          {active.length === 0 ? (
            <p className="hint">Loading the validator set…</p>
          ) : (
            <BarList
              data={active.map((v) => ({
                label: shortAddress(v.address),
                value: bondedTotal > 0 ? Number(v.bonded) / bondedTotal : 0,
                display: `${bondedTotal > 0 ? ((Number(v.bonded) / bondedTotal) * 100).toFixed(1) : "0.0"}%`,
                note: `target ${(v.weight_bps / 100).toFixed(0)}%`,
              }))}
              max={1}
            />
          )}
          <p className="hint" style={{ marginTop: "var(--s-4)" }}>
            No validator may exceed{" "}
            {config ? config.limits.max_validator_weight_bps / 100 : 25}%, a ceiling
            compiled into the contract rather than configured. The incumbent SCRT derivative
            routes 64% to one operator.
          </p>
        </div>

        <div className="stack" style={{ gap: "var(--s-4)" }}>
          <div className="panel">
            <h2 className="h2" style={{ marginBottom: "var(--s-4)" }}>
              Withdrawal queue
            </h2>
            <dl className="stack" style={{ gap: "var(--s-3)", margin: 0 }}>
              <Row label="Queued for withdrawal" value={`${fromMicro(queued, 2)} SCRT`} />
              <Row
                label="Windows in flight"
                value={String(windows.filter((w) => w.state === "unbonding").length)}
              />
              <Row
                label="Ready to claim"
                value={String(windows.filter((w) => w.state === "matured").length)}
              />
              <Row label="Entry slots used" value={`${slotsUsed} / ${slotCeiling}`} />
            </dl>
            <p className="hint" style={{ marginTop: "var(--s-4)" }}>
              Cosmos allows seven concurrent unbonding entries per validator and this
              protocol is a single delegator, which is why withdrawals are batched at all.
            </p>
          </div>

          <div className="panel">
            <h2 className="h2" style={{ marginBottom: "var(--s-4)" }}>
              Protocol
            </h2>
            <dl className="stack" style={{ gap: "var(--s-3)", margin: 0 }}>
              <Row
                label="Performance fee"
                value={config ? `${config.params.performance_fee_bps / 100}%` : "—"}
              />
              <Row
                label="Rewards awaiting compound"
                value={state ? `${fromMicro(state.pending_rewards)} SCRT` : "—"}
              />
              <Row
                label="Undeployed"
                value={state ? `${fromMicro(state.liquid_unallocated)} SCRT` : "—"}
              />
              <Row label="Last upkeep" value={state ? whenFrom(state.last_sync_time) : "—"} />
              <Row
                label="Deposits"
                value={
                  config?.paused ? (
                    <span className="pill pill--warn">paused</span>
                  ) : (
                    <span className="pill pill--good">open</span>
                  )
                }
              />
            </dl>
            {state?.is_unattended && (
              <div className="notice" style={{ marginTop: "var(--s-4)" }}>
                <Info size={15} />
                <span>
                  Nobody has run upkeep lately, so rewards are sitting uncompounded. This
                  costs yield — deposits, withdrawals and claims are unaffected.
                </span>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  note,
}: {
  label: string;
  value: string | null;
  unit?: string;
  note: string;
}) {
  return (
    <div className="card card--flat stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value num">
        {value ?? <span className="skel" style={{ width: 90, height: 24 }} />}
        {value && unit && <span className="stat-unit">{unit}</span>}
      </span>
      <span className="stat-note">{note}</span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="row">
      <dt>{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

const stamp = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Axis labels have no room for thousands separators at four figures and up. */
function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toFixed(0);
}
