"use client";

import { useEffect, useMemo, useState } from "react";

import { Status, readable, type Feedback } from "@/components/Status";
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

type Audience = "onchain" | "governor";

export default function GovernancePage() {
  const { connection, address } = useWallet();
  const [audience, setAudience] = useState<Audience>("onchain");
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
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="segmented segmented--narrow">
        <button aria-pressed={audience === "onchain"} onClick={() => setAudience("onchain")}>
          Onchain
        </button>
        <button aria-pressed={audience === "governor"} onClick={() => setAudience("governor")}>
          Governor
        </button>
      </div>

      {audience === "onchain" ? (
        <NetworkProposals config={config} />
      ) : (
        <ManagerConsole
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

/* ------------------------------------------------------------------ network */

function NetworkProposals({ config }: { config: Config | null }) {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setProposals(await fetchProposals());
      } catch (e) {
        setError(readable(e));
      }
    })();
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
      <div className="row">
        <h1 className="h1">Governance</h1>
        <button className="btn btn--white" onClick={() => setComposing(true)}>
          + Make proposal
        </button>
      </div>

      <input
        className="search"
        placeholder="Search protocol voting"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {error ? (
        <div className="panel">
          <p className="h2">Governance is not readable</p>
          <p className="note">{error}</p>
        </div>
      ) : proposals === null ? (
        <div className="panel">
          <p className="note">Loading proposals…</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="panel">
          <p className="h2">{query ? "Nothing matches" : "No proposals about this protocol"}</p>
          <p className="note">
            {query
              ? "No proposal matches that search."
              : `This list shows only proposals that would migrate ${shortAddress(
                  DEPLOYMENT.core.address,
                )} or ${shortAddress(
                  DEPLOYMENT.token.address,
                )}. Chain-wide votes are the network's business and are not repeated here.`}
          </p>
        </div>
      ) : (
        visible.map((p) => <ProposalCard key={p.id} proposal={p} />)
      )}

      {composing && <ProposalComposer config={config} onClose={() => setComposing(false)} />}
    </>
  );
}

function ProposalCard({ proposal }: { proposal: Proposal }) {
  const [open, setOpen] = useState(false);

  const timing =
    proposal.votingEnd === null
      ? statusLabel(proposal.status)
      : proposal.votingEnd * 1000 > Date.now()
        ? `Ends in ${untilFrom(proposal.votingEnd)}`
        : statusLabel(proposal.status);

  return (
    <div className="panel--solid" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="row">
        <span className="h3">{proposal.title}</span>
        <span style={{ fontSize: 18, color: "var(--ink-quiet)", whiteSpace: "nowrap" }}>
          {timing}
        </span>
      </div>

      <div>
        <button className="btn btn--pill" onClick={() => setOpen((v) => !v)}>
          {open ? "Close ←" : "Explore →"}
        </button>
      </div>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="row">
            <span className="k">Proposal</span>
            <span className="v numeral">#{proposal.id}</span>
          </div>
          <div className="row">
            <span className="k">Status</span>
            <span className="v">{statusLabel(proposal.status)}</span>
          </div>
          {proposal.changes.map((c) => (
            <div className="row" key={`${c.address}-${c.newCodeId}`}>
              <span className="k">
                {c.ours ? "Migrates" : "Also migrates"} {shortAddress(c.address)}
              </span>
              <span className="v numeral">code id {c.newCodeId}</span>
            </div>
          ))}
          {proposal.summary && <p className="note">{proposal.summary}</p>}
          <p className="note">
            The detail is rendered from the proposal itself rather than linked to an
            explorer, so what you read here is what the chain would execute. Before voting,
            check that the code id was built from a tagged commit: the whole point of
            approving a version is that voters could have reproduced it.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Compose the one proposal type that can reach this protocol.
 *
 * Chain governance cannot call a Secret contract — the compute module authenticates every
 * message against the signature of the transaction carrying it, and a proposal executes in
 * EndBlocker where there is none. What it *can* do is approve a code version, because
 * `MsgContractGovernanceProposal` carries only an address and a code id, with nothing
 * encrypted to bind to a signature.
 *
 * The design left the payload field open with a note asking what belongs there. The answer
 * is a code id, not source: a proposal cannot carry a binary, so the reviewed wasm is
 * uploaded first with `secretd tx compute store` and the vote approves the number that
 * returns.
 */
function ProposalComposer({ config, onClose }: { config: Config | null; onClose: () => void }) {
  const [target, setTarget] = useState<"core" | "token">("core");
  const [title, setTitle] = useState("Upgrade protocol");
  const [codeId, setCodeId] = useState("");
  const [description, setDescription] = useState("");
  const [deposit, setDeposit] = useState<string | null>(null);
  const [built, setBuilt] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void fetchMinDeposit().then(setDeposit);
  }, []);

  const contract = target === "core" ? DEPLOYMENT.core.address : DEPLOYMENT.token.address;

  const json = useMemo(
    () =>
      JSON.stringify(
        {
          messages: [
            {
              "@type": "/secret.compute.v1beta1.MsgContractGovernanceProposal",
              // secretd substitutes the gov module account when the proposal is submitted.
              authority: "<gov module account>",
              title,
              description: description || title,
              contracts: [{ address: contract, new_code_id: codeId || "<code id>" }],
              admin_updates: [],
            },
          ],
          metadata: "",
          deposit: `${deposit ?? "1000000000"}uscrt`,
          title,
          summary: description || title,
        },
        null,
        2,
      ),
    [title, description, contract, codeId, deposit],
  );

  return (
    <div className="scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="h3">Make proposal</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {!built ? (
          <>
            <div style={{ display: "flex", gap: 10 }}>
              <label className="field" style={{ flex: 1 }}>
                <span>Proposal name</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>

              <label className="field" style={{ flex: 1 }}>
                <span>Effect</span>
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value as "core" | "token")}
                >
                  <option value="core">Upgrade lst-core</option>
                  <option value="token">Upgrade dSCRT token</option>
                </select>
              </label>
            </div>

            <label className="field">
              <span>New code id — the reviewed wasm, uploaded before the vote</span>
              <input
                inputMode="numeric"
                placeholder="e.g. 42"
                value={codeId}
                onChange={(e) => setCodeId(e.target.value.replace(/\D/g, ""))}
              />
            </label>

            <p className="note">
              A proposal cannot carry code. Upload the binary first with{" "}
              <code>secretd tx compute store</code> and put the code id it returns here —
              voters approve a version, and should be able to rebuild that exact binary from
              a tagged commit with <code>npm run build</code>.
            </p>

            <label className="field">
              <span>Description</span>
              <textarea
                placeholder="What changes, and why the network should accept it."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>

            <div className="row">
              <span className="k">Governance deposit</span>
              <span className="v numeral">
                {deposit ? `${fromMicro(deposit, 0)} SCRT` : "—"}
              </span>
            </div>

            <button className="btn btn--md" disabled={!codeId} onClick={() => setBuilt(true)}>
              Propose
            </button>
          </>
        ) : (
          <>
            <pre className="payload">{json}</pre>

            <button
              className="btn btn--md"
              onClick={() => {
                void navigator.clipboard.writeText(json);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? "Copied" : "Copy proposal"}
            </button>

            <p className="note">
              Save as <code>proposal.json</code> and submit it yourself:
              <br />
              <code>secretd tx gov submit-proposal proposal.json --from you</code>
            </p>
            <p className="note">
              The app builds the file but does not sign it. Submitting locks up a{" "}
              {deposit ? fromMicro(deposit, 0) : "—"} SCRT deposit, and a wallet route for a
              message type this app cannot test against a real vote is not worth that risk
              to you.
            </p>

            <button className="btn btn--md btn--ghost" onClick={() => setBuilt(false)}>
              Back
            </button>
          </>
        )}

        {config && (
          <p className="note">
            A passing vote is also how everything outside the manager&apos;s remit changes —
            parameters, the validator allowlist, the treasury, and who the manager is. The
            migration is relayed afterwards and can only execute the version that was
            approved.
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ manager */

/**
 * The manager's console.
 *
 * Everything reachable from here is bounded by ceilings compiled into the contract, so the
 * screen enforces the same bounds up front rather than letting the chain reject the
 * transaction. A manager should be able to see that they cannot overreach, not discover it
 * from a failed transaction.
 */
function ManagerConsole({
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
  const [feedback, setFeedback] = useState<Feedback>({ kind: "idle" });
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

  const weightCeiling = config?.limits.max_validator_weight_bps ?? 0;
  const overCeiling = Object.entries(weights).filter(
    ([, pct]) => (Number(pct) || 0) * 100 > weightCeiling,
  );
  const weightsValid = Math.round(weightSum) === 10_000 && overCeiling.length === 0;

  const run = async (label: string, action: () => Promise<unknown>) => {
    if (!connection) return;
    setFeedback({ kind: "busy", message: "Waiting for your wallet…" });
    try {
      await action();
      setFeedback({ kind: "ok", message: label });
      await onDone();
    } catch (e) {
      setFeedback({ kind: "err", message: readable(e) });
    }
  };

  if (!config) return <div className="panel">Loading…</div>;

  const locked = !connection || !isManager;

  return (
    <div className="grid-2">
      <div>
        <div className="panel">
          <p className="h2">Validator distribution</p>

          <table className="plain">
            <thead>
              <tr>
                <th>Validator</th>
                <th>Bonded</th>
                <th style={{ width: 110 }}>Weight %</th>
              </tr>
            </thead>
            <tbody>
              {config.validator_allowlist.map((address) => {
                const entry = validators.find((v) => v.address === address);
                const pct = weights[address] ?? "0";
                const over = (Number(pct) || 0) * 100 > weightCeiling;
                return (
                  <tr key={address}>
                    <td>
                      <span title={address}>{shortAddress(address)}</span>
                      {entry?.status === "draining" && (
                        <>
                          {" "}
                          <span className="pill">draining</span>
                        </>
                      )}
                    </td>
                    <td className="numeral muted">{entry ? fromMicro(entry.bonded, 0) : "0"}</td>
                    <td>
                      <input
                        inputMode="decimal"
                        value={pct}
                        disabled={locked}
                        onChange={(e) =>
                          setWeightsState((w) => ({
                            ...w,
                            [address]: e.target.value.replace(/[^\d.]/g, ""),
                          }))
                        }
                        style={{
                          width: "100%",
                          padding: "7px 10px",
                          borderRadius: "var(--r-md)",
                          border: 0,
                          background: "var(--surface-2)",
                          color: over ? "var(--bad)" : "var(--ink)",
                          font: "inherit",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="row" style={{ marginTop: 12 }}>
            <span className="k">Total</span>
            <span
              className="v numeral"
              style={{ color: Math.round(weightSum) === 10_000 ? undefined : "var(--bad)" }}
            >
              {(weightSum / 100).toFixed(2)}% / 100.00%
            </span>
          </div>

          {overCeiling.length > 0 && (
            <p className="note" style={{ color: "var(--bad)", marginTop: 10 }}>
              {overCeiling.length} validator{overCeiling.length === 1 ? "" : "s"} above the{" "}
              {weightCeiling / 100}% ceiling. The ceiling is compiled into the contract:
              raising it needs a governance-approved code version, not a setting.
            </p>
          )}

          <button
            className="btn btn--md"
            style={{ marginTop: 16 }}
            disabled={locked || !weightsValid}
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

        <div className="panel">
          <p className="h2">Rebalance</p>
          <p className="note" style={{ marginBottom: 16 }}>
            Moves stake that is already delegated. New deposits drift toward the target
            weights on their own, so this is for correcting a set that has already gone out
            of shape.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <label className="field">
              <span>From</span>
              <select
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
            </label>

            <label className="field">
              <span>To</span>
              <select
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
            </label>

            <label className="field">
              <span>Amount (SCRT)</span>
              <input
                inputMode="decimal"
                value={plan.amount}
                disabled={locked}
                onChange={(e) =>
                  setPlan((p) => ({ ...p, amount: e.target.value.replace(/[^\d.]/g, "") }))
                }
              />
            </label>

            <button
              className="btn btn--md btn--ghost"
              disabled={locked || !plan.src || !plan.dst || !plan.amount}
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
      </div>

      <div>
        <div className="panel">
          <p className="h2">Performance fee</p>
          <div className="amount">
            <input
              inputMode="decimal"
              value={fee}
              disabled={locked}
              onChange={(e) => setFee(e.target.value.replace(/[^\d.]/g, ""))}
            />
            <span className="denom">%</span>
          </div>
          <p className="note" style={{ margin: "14px 0" }}>
            Taken from staking rewards, never from principal. The network capped this at{" "}
            {config.limits.max_performance_fee_bps / 100}%.
          </p>
          <button
            className="btn btn--md"
            disabled={locked || (Number(fee) || 0) * 100 > config.limits.max_performance_fee_bps}
            onClick={() =>
              run("Fee updated.", () =>
                setPerformanceFee(connection!, Math.round((Number(fee) || 0) * 100)),
              )
            }
          >
            Set fee
          </button>
        </div>

        <div className="panel">
          <p className="h2">Deposits</p>
          <p className="stat-value numeral">{config.paused ? "Paused" : "Open"}</p>
          <p className="note" style={{ margin: "14px 0" }}>
            Pausing blocks new deposits only. Claims on matured windows are never pausable,
            so this cannot trap anyone&apos;s funds.
          </p>
          <button
            className="btn btn--md btn--ghost"
            disabled={locked}
            onClick={() =>
              run(config.paused ? "Deposits resumed." : "Deposits paused.", () =>
                setPaused(connection!, !config.paused),
              )
            }
          >
            {config.paused ? "Resume deposits" : "Pause deposits"}
          </button>
        </div>

        <div className="panel">
          <p className="h2">Who you are signing as</p>
          <div className="row">
            <span className="k">Manager on chain</span>
            <span className="v">{shortAddress(config.manager)}</span>
          </div>
          <p className="note" style={{ marginTop: 12 }}>
            {!connection
              ? "Connect a wallet to act as the manager."
              : isManager
                ? "This wallet is the manager. Everything on this screen is bounded by ceilings in the contract — there is no action here that can move a user's funds."
                : "This wallet is not the manager, so the controls are read-only. Changing who the manager is takes a governance-approved code version."}
          </p>
        </div>

        {feedback.kind !== "idle" && <Status feedback={feedback} />}
      </div>
    </div>
  );
}
