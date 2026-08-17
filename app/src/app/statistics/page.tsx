"use client";

import { useEffect, useMemo, useState } from "react";

import { BarList, LineChart } from "@/components/Chart";
import { Check, Copy, External, Info, Spinner } from "@/components/Icon";
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
import {
  explorerUrl,
  fetchValidatorInfo,
  markColour,
  type ValidatorInfo,
} from "@/lib/validators";

const RANGES: Range[] = ["24h", "7d", "30d"];
type Metric = "tvl" | "rate";

export default function StatisticsPage() {
  const [state, setState] = useState<ProtocolState | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [validators, setValidators] = useState<ValidatorEntry[]>([]);
  const [names, setNames] = useState<Map<string, ValidatorInfo>>(new Map());
  const [windows, setWindows] = useState<UnbondWindow[]>([]);

  const [range, setRange] = useState<Range>("7d");
  const [metric, setMetric] = useState<Metric>("tvl");
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
      setNames(await fetchValidatorInfo(v.map((entry) => entry.address)));
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

  const points = useMemo(() => {
    const samples = history?.samples ?? [];
    return samples.map((s) => ({
      x: s.time,
      y:
        metric === "tvl"
          ? (Number(s.state.total_bonded) +
              Number(s.state.pending_rewards) +
              Number(s.state.liquid_unallocated)) /
            1e6
          : rateToNumber(s.state.exchange_rate),
    }));
  }, [history, metric]);

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
    <div className="stack" style={{ gap: "var(--s-8)" }}>
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

      <section className="grid grid-4" style={{ gap: 0 }}>
        <Stat label="Total value locked" value={state ? fromMicro(tvl, 0) : null} unit="SCRT" />
        <Stat
          label="Exchange rate"
          value={state ? rateToNumber(state.exchange_rate).toFixed(6) : null}
        />
        <Stat label="Observed APY" value={apy !== null ? `${apy.toFixed(2)}%` : "—"} />
        <Stat label="dSCRT supply" value={state ? fromMicro(state.total_supply, 0) : null} />
      </section>

      <section className="bare">
        <div
          className="row"
          style={{ marginBottom: "var(--s-5)", alignItems: "center" }}
        >
          <div className="segmented">
            <button aria-pressed={metric === "tvl"} onClick={() => setMetric("tvl")}>
              Total value locked
            </button>
            <button aria-pressed={metric === "rate"} onClick={() => setMetric("rate")}>
              Exchange rate
            </button>
          </div>
          {loading && <Spinner size={14} />}
        </div>

        <LineChart
          key={metric}
          points={points}
          height={280}
          zeroBased={metric === "tvl"}
          formatY={(v) => (metric === "tvl" ? compact(v) : v.toFixed(5))}
          formatX={stamp}
        />

        <p className="hint" style={{ marginTop: "var(--s-4)" }}>
          {metric === "tvl"
            ? "SCRT-denominated, so it moves with deposits and rewards rather than with the price."
            : "One dSCRT in SCRT. Rising is the yield; a fall would mean a validator was slashed."}
        </p>
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

      <section className="bare">
        <h2 className="h2" style={{ marginBottom: "var(--s-5)" }}>
          Where the stake sits
        </h2>
        {active.length === 0 ? (
          <p className="hint">Loading the validator set…</p>
        ) : (
          <BarList
            max={1}
            data={active.map((v) => {
              const share = bondedTotal > 0 ? Number(v.bonded) / bondedTotal : 0;
              return {
                label: v.address,
                value: share,
                display: `${(share * 100).toFixed(1)}%`,
                render: <Validator entry={v} info={names.get(v.address)} />,
              };
            })}
          />
        )}
        <p className="hint" style={{ marginTop: "var(--s-5)" }}>
          No validator may exceed {config ? config.limits.max_validator_weight_bps / 100 : 25}%,
          a ceiling compiled into the contract rather than configured. The incumbent SCRT
          derivative routes 64% to one operator.
        </p>
      </section>

      <section className="grid grid-2" style={{ gap: "var(--s-8)" }}>
        <div className="bare">
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
            Cosmos allows seven concurrent unbonding entries per validator and this protocol
            is a single delegator, which is why withdrawals are batched at all.
          </p>
        </div>

        <div className="bare">
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
                Nobody has run upkeep lately, so rewards are sitting uncompounded. This costs
                yield — deposits, withdrawals and claims are unaffected. Anyone can{" "}
                <a className="link" href="/keeper">
                  run it themselves
                </a>
                .
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/** A validator, as a person rather than as a key. */
function Validator({ entry, info }: { entry: ValidatorEntry; info?: ValidatorInfo }) {
  const [copied, setCopied] = useState(false);
  const name = info?.moniker || shortAddress(entry.address);
  const initial = (info?.moniker || "?").trim().charAt(0).toUpperCase();

  return (
    <span className="val">
      <span className="val-mark" style={{ background: markColour(entry.address) }}>
        {initial}
      </span>
      <span className="val-name" title={entry.address}>
        {name}
      </span>

      <span className="val-tools">
        <button
          className="val-tool"
          title="Copy address"
          aria-label={`Copy address of ${name}`}
          onClick={() => {
            void navigator.clipboard.writeText(entry.address);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <a
          className="val-tool"
          href={explorerUrl(entry.address)}
          target="_blank"
          rel="noreferrer"
          title="View on the explorer"
          aria-label={`View ${name} on the explorer`}
        >
          <External size={13} />
        </a>
      </span>

      {entry.status === "draining" && <span className="pill">draining</span>}
      {info?.jailed && <span className="pill pill--bad">jailed</span>}
    </span>
  );
}

function Stat({ label, value, unit }: { label: string; value: string | null; unit?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value num">
        {value ?? <span className="skel" style={{ width: 90, height: 24 }} />}
        {value && unit && <span className="stat-unit">{unit}</span>}
      </span>
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
