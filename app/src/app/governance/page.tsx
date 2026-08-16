"use client";

import { useEffect, useMemo, useState } from "react";

import { Alert, Check, ChevronDown, Copy, Info, Spinner } from "@/components/Icon";
import { readable, useToast } from "@/components/Toast";
import { Unconfigured } from "@/components/Unconfigured";
import { useWallet } from "@/components/Wallet";
import { CONFIGURED, DEPLOYMENT, fromMicro, shortAddress, toMicro, untilFrom } from "@/lib/chain";
import { fetchMinDeposit, fetchProposals, statusLabel, type Proposal } from "@/lib/gov";
import {
  fetchConfig,
  fetchValidators,
  rebalance,
  setPaused,
  setPerformanceFee,
  setWeights,
  type Config,
  type ValidatorEntry,
} from "@/lib/protocol";

type Tab = "onchain" | "governor";

export default function GovernancePage() {
  const { connection, address } = useWallet();
  const [tab, setTab] = useState<Tab>("onchain");
  const [config, setConfig] = useState<Config | null>(null);
  const [validators, setValidators] = useState<ValidatorEntry[]>([]);

  const refresh = async () => {
    const [c, v] = await Promise.all([fetchConfig(), fetchValidators()]);
    setConfig(c);
    setValidators(v);
  };

  useEffect(() => {
    if (!CONFIGURED) return;
    void refresh().catch(() => undefined);
  }, []);

  if (!CONFIGURED) return <Unconfigured />;

  const isManager = Boolean(config && address && config.manager === address);

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
          <h1 className="h1">Governance</h1>
          <p className="prose" style={{ marginTop: 6, maxWidth: "60ch" }}>
            The network decides what code this protocol runs. A manager tunes the fee and
            the split between validators, within ceilings the code puts beyond their reach.
          </p>
        </div>
        <div className="segmented">
          <button aria-pressed={tab === "onchain"} onClick={() => setTab("onchain")}>
            Proposals
          </button>
          <button aria-pressed={tab === "governor"} onClick={() => setTab("governor")}>
            Manager
          </button>
        </div>
      </header>

      {tab === "onchain" ? (
        <Proposals config={config} />
      ) : (
        <Manager
          config={config}
          validators={validators}
          isManager={isManager}
          connection={connection}
          onDone={refresh}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- proposals */

function Proposals({ config }: { config: Config | null }) {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    void fetchProposals()
      .then(setProposals)
      .catch((e) => setError(readable(e)));
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!proposals) return [];
    if (!needle) return proposals;
    return proposals.filter(
      (p) =>
        p.title.toLowerCase().includes(needle) ||
        p.summary.toLowerCase().includes(needle) ||
        p.id.includes(needle),
    );
  }, [proposals, query]);

  return (
    <>
      <div style={{ display: "flex", gap: "var(--s-3)", flexWrap: "wrap" }}>
        <input
          className="input"
          style={{ maxWidth: 280 }}
          placeholder="Search proposals"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn btn--sm" onClick={() => setComposing(true)}>
          Draft a proposal
        </button>
      </div>

      {error ? (
        <div className="notice notice--bad">
          <Alert size={15} />
          <span>{error}</span>
        </div>
      ) : proposals === null ? (
        <div className="panel empty">
          <Spinner />
          <p className="hint">Reading governance…</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="panel empty">
          <h2 className="h2">{query ? "Nothing matches" : "No proposals about this protocol"}</h2>
          <p className="prose" style={{ maxWidth: "52ch" }}>
            {query
              ? "No proposal matches that search."
              : `Only proposals that would migrate ${shortAddress(
                  DEPLOYMENT.core.address,
                )} or ${shortAddress(
                  DEPLOYMENT.token.address,
                )} appear here. Chain-wide votes are the network's business and are not repeated.`}
          </p>
        </div>
      ) : (
        <div className="stack" style={{ gap: "var(--s-3)" }}>
          {visible.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
        </div>
      )}

      {composing && <Composer config={config} onClose={() => setComposing(false)} />}
    </>
  );
}

function ProposalCard({ proposal }: { proposal: Proposal }) {
  const [open, setOpen] = useState(false);

  const live = proposal.votingEnd !== null && proposal.votingEnd * 1000 > Date.now();
  const timing = live ? `Ends in ${untilFrom(proposal.votingEnd!)}` : statusLabel(proposal.status);

  return (
    <div className="card card--flat" style={{ padding: "var(--s-5)" }}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <h2 className="h2">{proposal.title}</h2>
          <p className="hint" style={{ marginTop: 4 }}>
            Proposal #{proposal.id}
          </p>
        </div>
        <span className={`pill ${live ? "pill--accent" : ""}`}>{timing}</span>
      </div>

      <button
        className="btn btn--ghost btn--sm"
        style={{ marginTop: "var(--s-4)" }}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "Hide detail" : "What it would do"}
        <ChevronDown
          size={14}
          className={open ? "spin-none" : undefined}
        />
      </button>

      {open && (
        <div className="well" style={{ marginTop: "var(--s-4)" }}>
          <dl className="stack" style={{ gap: "var(--s-3)", margin: 0 }}>
            <div className="row">
              <dt>Status</dt>
              <dd>{statusLabel(proposal.status)}</dd>
            </div>
            {proposal.changes.map((c) => (
              <div className="row" key={`${c.address}-${c.newCodeId}`}>
                <dt>
                  {c.ours ? "Migrates" : "Also migrates"} {shortAddress(c.address)}
                </dt>
                <dd className="num">code id {c.newCodeId}</dd>
              </div>
            ))}
          </dl>
          {proposal.summary && (
            <p className="prose" style={{ marginTop: "var(--s-4)" }}>
              {proposal.summary}
            </p>
          )}
          <p className="hint" style={{ marginTop: "var(--s-4)" }}>
            Rendered from the proposal itself rather than linked to an explorer, so what you
            read is what the chain would execute. Before voting, check the code id was built
            from a tagged commit — the point of approving a version is that voters could
            have reproduced it.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Draft the one proposal type that can reach this protocol.
 *
 * Chain governance cannot call a Secret contract: the compute module authenticates every
 * message against the signature of the transaction carrying it, and a proposal executes
 * with no transaction. Approving a code version works because that message carries only an
 * address and a code id, with nothing encrypted needing a signature.
 *
 * A proposal also cannot carry a binary, so the field is a code id from a prior
 * `compute store`. The app builds the file and hands over the command rather than signing:
 * submitting locks a large deposit, and a wallet route for a message type this app cannot
 * test against a real vote is not worth that risk to the user.
 */
function Composer({ config, onClose }: { config: Config | null; onClose: () => void }) {
  const [target, setTarget] = useState<"core" | "token">("core");
  const [title, setTitle] = useState("Upgrade the staking contract");
  const [codeId, setCodeId] = useState("");
  const [summary, setSummary] = useState("");
  const [deposit, setDeposit] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void fetchMinDeposit().then(setDeposit);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const contract = target === "core" ? DEPLOYMENT.core.address : DEPLOYMENT.token.address;

  const json = useMemo(
    () =>
      JSON.stringify(
        {
          messages: [
            {
              "@type": "/secret.compute.v1beta1.MsgContractGovernanceProposal",
              authority: "<gov module account>",
              title,
              description: summary || title,
              contracts: [{ address: contract, new_code_id: codeId || "<code id>" }],
              admin_updates: [],
            },
          ],
          metadata: "",
          deposit: `${deposit ?? "1000000000"}uscrt`,
          title,
          summary: summary || title,
        },
        null,
        2,
      ),
    [title, summary, contract, codeId, deposit],
  );

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Draft a proposal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <h2 className="h2">Draft a proposal</h2>
          <span className="pill">{deposit ? `${fromMicro(deposit, 0)} SCRT deposit` : "—"}</span>
        </div>

        <div className="dialog-body">
          <div className="field">
            <label htmlFor="title">Title</label>
            <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          <div className="field">
            <label htmlFor="target">Contract</label>
            <select
              id="target"
              value={target}
              onChange={(e) => setTarget(e.target.value as "core" | "token")}
            >
              <option value="core">Staking contract</option>
              <option value="token">dSCRT token</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="codeid">New code id</label>
            <input
              id="codeid"
              inputMode="numeric"
              placeholder="e.g. 42"
              value={codeId}
              onChange={(e) => setCodeId(e.target.value.replace(/\D/g, ""))}
            />
            <span className="hint">
              A proposal cannot carry code. Upload the reviewed binary first with{" "}
              <code>secretd tx compute store</code> and put the id it returns here. Voters
              should be able to rebuild that exact binary from a tagged commit.
            </span>
          </div>

          <div className="field">
            <label htmlFor="summary">Summary</label>
            <textarea
              id="summary"
              placeholder="What changes, and why the network should accept it."
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>

          <pre className="payload">{json}</pre>

          <div style={{ display: "flex", gap: "var(--s-2)" }}>
            <button
              className="btn btn--block"
              disabled={!codeId}
              onClick={() => {
                void navigator.clipboard.writeText(json);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? "Copied" : "Copy proposal"}
            </button>
            <button className="btn btn--ghost" onClick={onClose}>
              Close
            </button>
          </div>

          <p className="hint">
            Save as <code>proposal.json</code> and submit it yourself with{" "}
            <code>secretd tx gov submit-proposal</code>. The app builds the file but does not
            sign it.
          </p>

          {config && (
            <p className="hint">
              A passing vote is also how everything outside the manager&apos;s remit changes:
              parameters, the validator allowlist, the treasury, and who the manager is.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- manager */

/**
 * The manager's console.
 *
 * Everything here is bounded by ceilings compiled into the contract, so the screen enforces
 * the same bounds up front rather than letting the chain reject the transaction. A manager
 * should be able to see that they cannot overreach, not discover it from a failure.
 */
function Manager({
  config,
  validators,
  isManager,
  connection,
  onDone,
}: {
  config: Config | null;
  validators: ValidatorEntry[];
  isManager: boolean;
  connection: ReturnType<typeof useWallet>["connection"];
  onDone: () => Promise<void>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [fee, setFee] = useState("");
  const [weights, setWeightsState] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState({ src: "", dst: "", amount: "" });

  useEffect(() => {
    if (!config) return;
    setFee(String(config.params.performance_fee_bps / 100));
    setWeightsState(
      Object.fromEntries(
        config.validator_allowlist.map((address) => {
          const entry = validators.find((v) => v.address === address);
          return [address, String((entry?.weight_bps ?? 0) / 100)];
        }),
      ),
    );
  }, [config, validators]);

  const weightSum = useMemo(
    () => Object.values(weights).reduce((total, pct) => total + (Number(pct) || 0) * 100, 0),
    [weights],
  );

  const ceiling = config?.limits.max_validator_weight_bps ?? 0;
  const over = Object.entries(weights).filter(([, pct]) => (Number(pct) || 0) * 100 > ceiling);
  const weightsValid = Math.round(weightSum) === 10_000 && over.length === 0;

  const run = async (message: string, action: () => Promise<unknown>) => {
    if (!connection) return;
    const id = toast.show("pending", "Confirm in your wallet…");
    setBusy(true);
    try {
      await action();
      toast.resolve(id, "ok", message);
      await onDone();
    } catch (e) {
      toast.resolve(id, "error", readable(e));
    } finally {
      setBusy(false);
    }
  };

  if (!config) {
    return (
      <div className="panel empty">
        <Spinner />
      </div>
    );
  }

  const locked = !connection || !isManager;

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      <div className={`notice ${isManager ? "notice--good" : ""}`}>
        {isManager ? <Check size={15} /> : <Info size={15} />}
        <span>
          {!connection
            ? "Connect the manager wallet to make changes. Everything below is read-only until then."
            : isManager
              ? "This wallet is the manager. Nothing on this screen can move a user's funds."
              : `Read-only — the manager is ${shortAddress(config.manager)}. Changing who that is takes a governance-approved code version.`}
        </span>
      </div>

      <div className="grid grid-2">
        <div className="panel">
          <h2 className="h2" style={{ marginBottom: "var(--s-4)" }}>
            Validator weights
          </h2>

          <table className="plain">
            <thead>
              <tr>
                <th>Validator</th>
                <th>Bonded</th>
                <th style={{ width: 96 }}>Target</th>
              </tr>
            </thead>
            <tbody>
              {config.validator_allowlist.map((address) => {
                const entry = validators.find((v) => v.address === address);
                const pct = weights[address] ?? "0";
                const tooHigh = (Number(pct) || 0) * 100 > ceiling;
                return (
                  <tr key={address}>
                    <td>
                      <span className="num" title={address}>
                        {shortAddress(address)}
                      </span>
                      {entry?.status === "draining" && (
                        <span className="pill" style={{ marginLeft: 6 }}>
                          draining
                        </span>
                      )}
                    </td>
                    <td className="num faint">{entry ? fromMicro(entry.bonded, 0) : "0"}</td>
                    <td>
                      <input
                        className="input"
                        inputMode="decimal"
                        aria-label={`Target weight for ${address}`}
                        value={pct}
                        disabled={locked}
                        style={{
                          padding: "6px 8px",
                          textAlign: "right",
                          borderColor: tooHigh ? "var(--bad)" : undefined,
                          color: tooHigh ? "var(--bad)" : undefined,
                        }}
                        onChange={(e) =>
                          setWeightsState((w) => ({
                            ...w,
                            [address]: e.target.value.replace(/[^\d.]/g, ""),
                          }))
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="row" style={{ marginTop: "var(--s-4)" }}>
            <span className="k">Total</span>
            <span
              className="v num"
              style={{ color: Math.round(weightSum) === 10_000 ? undefined : "var(--bad)" }}
            >
              {(weightSum / 100).toFixed(2)}% / 100%
            </span>
          </div>

          {over.length > 0 && (
            <div className="notice notice--bad" style={{ marginTop: "var(--s-3)" }}>
              <Alert size={15} />
              <span>
                {over.length} validator{over.length === 1 ? "" : "s"} above the{" "}
                {ceiling / 100}% ceiling. That ceiling is compiled into the contract: raising
                it needs a governance-approved code version, not a setting.
              </span>
            </div>
          )}

          <button
            className="btn btn--block"
            style={{ marginTop: "var(--s-4)" }}
            disabled={locked || !weightsValid || busy}
            onClick={() =>
              run("Weights updated.", () =>
                setWeights(
                  connection!,
                  Object.entries(weights).map(([address, pct]) => ({
                    address,
                    weight_bps: Math.round((Number(pct) || 0) * 100),
                  })),
                ),
              )
            }
          >
            Set weights
          </button>
        </div>

        <div className="stack" style={{ gap: "var(--s-4)" }}>
          <div className="panel">
            <h2 className="h2">Performance fee</h2>
            <p className="hint" style={{ margin: "6px 0 var(--s-4)" }}>
              Taken from staking rewards, never from principal. The network capped this at{" "}
              {config.limits.max_performance_fee_bps / 100}%.
            </p>
            <div style={{ display: "flex", gap: "var(--s-2)" }}>
              <input
                className="input"
                inputMode="decimal"
                aria-label="Performance fee percentage"
                value={fee}
                disabled={locked}
                onChange={(e) => setFee(e.target.value.replace(/[^\d.]/g, ""))}
              />
              <button
                className="btn btn--quiet btn--sm"
                disabled={
                  locked ||
                  busy ||
                  (Number(fee) || 0) * 100 > config.limits.max_performance_fee_bps
                }
                onClick={() =>
                  run("Fee updated.", () =>
                    setPerformanceFee(connection!, Math.round((Number(fee) || 0) * 100)),
                  )
                }
              >
                Set
              </button>
            </div>
          </div>

          <div className="panel">
            <h2 className="h2">Rebalance</h2>
            <p className="hint" style={{ margin: "6px 0 var(--s-4)" }}>
              Moves stake already delegated. New deposits drift toward the targets on their
              own, so this is for a set that has gone out of shape.
            </p>
            <div className="stack" style={{ gap: "var(--s-3)" }}>
              <div className="field">
                <label htmlFor="src">From</label>
                <select
                  id="src"
                  value={plan.src}
                  disabled={locked}
                  onChange={(e) => setPlan((p) => ({ ...p, src: e.target.value }))}
                >
                  <option value="">Select a validator</option>
                  {validators
                    .filter((v) => v.bonded !== "0")
                    .map((v) => (
                      <option key={v.address} value={v.address}>
                        {shortAddress(v.address)} — {fromMicro(v.bonded, 0)} SCRT
                      </option>
                    ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="dst">To</label>
                <select
                  id="dst"
                  value={plan.dst}
                  disabled={locked}
                  onChange={(e) => setPlan((p) => ({ ...p, dst: e.target.value }))}
                >
                  <option value="">Select a validator</option>
                  {config.validator_allowlist.map((address) => (
                    <option key={address} value={address}>
                      {shortAddress(address)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="amt">Amount (SCRT)</label>
                <input
                  id="amt"
                  inputMode="decimal"
                  value={plan.amount}
                  disabled={locked}
                  onChange={(e) =>
                    setPlan((p) => ({ ...p, amount: e.target.value.replace(/[^\d.]/g, "") }))
                  }
                />
              </div>
              <button
                className="btn btn--quiet"
                disabled={locked || busy || !plan.src || !plan.dst || !plan.amount}
                onClick={() =>
                  run("Rebalancing submitted.", () =>
                    rebalance(connection!, [
                      {
                        src_validator: plan.src,
                        dst_validator: plan.dst,
                        amount: toMicro(plan.amount),
                      },
                    ]),
                  )
                }
              >
                Redelegate
              </button>
            </div>
          </div>

          <div className="panel">
            <div className="row">
              <div>
                <h2 className="h2">Deposits</h2>
                <p className="hint" style={{ marginTop: 4, maxWidth: "40ch" }}>
                  Pausing blocks new deposits only. Claims are never pausable, so this
                  cannot trap anyone&apos;s funds.
                </p>
              </div>
              <span className={`pill ${config.paused ? "pill--warn" : "pill--good"}`}>
                {config.paused ? "paused" : "open"}
              </span>
            </div>
            <button
              className={`btn btn--block ${config.paused ? "" : "btn--ghost"}`}
              style={{ marginTop: "var(--s-4)" }}
              disabled={locked || busy}
              onClick={() =>
                run(config.paused ? "Deposits resumed." : "Deposits paused.", () =>
                  setPaused(connection!, !config.paused),
                )
              }
            >
              {config.paused ? "Resume deposits" : "Pause deposits"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
