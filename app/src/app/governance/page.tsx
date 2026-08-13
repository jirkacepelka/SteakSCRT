"use client";

import { useEffect, useMemo, useState } from "react";

import { Status, readable, type Feedback } from "@/components/Status";
import { useWallet } from "@/components/Wallet";
import { DEPLOYMENT, fromMicro, shortAddress, toMicro } from "@/lib/chain";
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

type Audience = "network" | "manager";

export default function GovernancePage() {
  const { connection, address } = useWallet();
  const [audience, setAudience] = useState<Audience>("network");
  const [config, setConfig] = useState<Config | null>(null);
  const [validators, setValidators] = useState<ValidatorEntry[]>([]);

  const refresh = async () => {
    const [c, v] = await Promise.all([fetchConfig(), fetchValidators()]);
    setConfig(c);
    setValidators(v);
  };

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, []);

  const isManager = Boolean(config && address && config.manager === address);

  return (
    <div>
      <div className="toggle">
        <button
          aria-pressed={audience === "network"}
          onClick={() => setAudience("network")}
        >
          Network proposal
        </button>
        <button
          aria-pressed={audience === "manager"}
          onClick={() => setAudience("manager")}
        >
          Manager
        </button>
      </div>

      {audience === "network" ? (
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

/**
 * Build the one proposal type that is relevant to this protocol.
 *
 * Chain governance cannot call a Secret contract — the compute module authenticates every
 * message against the signature of its carrying transaction, and a proposal executed in
 * EndBlocker has none. What it *can* do is approve a code upgrade, because
 * `MsgContractGovernanceProposal` carries only an address and a code id, with no encrypted
 * payload needing a signature.
 *
 * So this screen offers exactly that, and does not pretend the other options exist.
 */
function NetworkProposals({ config }: { config: Config | null }) {
  const [target, setTarget] = useState<"core" | "token">("core");
  const [codeId, setCodeId] = useState("");
  const [title, setTitle] = useState("Upgrade dSCRT lst-core");
  const [description, setDescription] = useState(
    "Migrate the liquid staking contract to a reviewed code version.",
  );
  const [copied, setCopied] = useState(false);

  const contract = target === "core" ? DEPLOYMENT.core.address : DEPLOYMENT.token.address;

  const proposal = useMemo(
    () => ({
      messages: [
        {
          "@type": "/secret.compute.v1beta1.MsgContractGovernanceProposal",
          // Filled in by the chain's own gov module account; secretd substitutes the
          // authority when the proposal is submitted.
          authority: "<gov module account>",
          title,
          description,
          contracts: [
            {
              address: contract,
              new_code_id: codeId || "<code id>",
            },
          ],
          admin_updates: [],
        },
      ],
      metadata: "",
      deposit: "1000000000uscrt",
      title,
      summary: description,
    }),
    [contract, codeId, title, description],
  );

  const json = JSON.stringify(proposal, null, 2);

  return (
    <div className="grid">
      <div className="card">
        <p className="card-title">Propose a code upgrade</p>

        <label className="field">
          <span>Contract</span>
          <select value={target} onChange={(e) => setTarget(e.target.value as "core" | "token")}>
            <option value="core">lst-core — the staking engine</option>
            <option value="token">dSCRT — the derivative token</option>
          </select>
        </label>

        <label className="field">
          <span>New code id</span>
          <input
            inputMode="numeric"
            placeholder="e.g. 42"
            value={codeId}
            onChange={(e) => setCodeId(e.target.value.replace(/\D/g, ""))}
          />
        </label>

        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>

        <label className="field">
          <span>Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={{ minHeight: 90 }}
          />
        </label>

        <p className="note">
          Upload the reviewed wasm first — <code>secretd tx compute store</code> — and use
          the code id it returns. Voters should be able to reproduce that binary from a
          tagged commit with <code>npm run build</code>.
        </p>
      </div>

      <div>
        <div className="card card--dark">
          <p className="card-title">Proposal JSON</p>
          <pre className="payload">{json}</pre>
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard.writeText(json);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? "Copied" : "Copy JSON"}
          </button>
          <p className="note">
            Save as <code>proposal.json</code> and submit:
            <br />
            <code>secretd tx gov submit-proposal proposal.json --from you</code>
          </p>
        </div>

        <div className="card card--queue">
          <p className="card-title">Why only upgrades</p>
          <p className="note">
            Chain governance cannot call this contract. Secret&apos;s compute module
            authenticates every message against the signature of the transaction carrying
            it, and a proposal executes in EndBlocker where there is no such transaction —
            measured, not assumed.
          </p>
          <p className="note">
            Approving a code version works because that message carries only an address and
            a code id, with nothing encrypted to bind to a signature. So everything outside
            the manager&apos;s remit — parameters, the validator allowlist, the treasury,
            and who the manager is — changes by shipping a version the network voted for.
          </p>
          <p className="note">
            The migration itself is submitted by the admin relay afterwards, and it can only
            execute the upgrade the vote approved: an unapproved one is refused with{" "}
            <em>requires governance approval for migration</em>.
          </p>
        </div>

        {config && (
          <div className="card">
            <p className="card-title">What a vote would be changing</p>
            <div className="row">
              <span className="k">Manager</span>
              <span className="v">{shortAddress(config.manager)}</span>
            </div>
            <div className="row">
              <span className="k">Treasury</span>
              <span className="v">{shortAddress(config.treasury)}</span>
            </div>
            <div className="row">
              <span className="k">Fee ceiling</span>
              <span className="v numeral">
                {config.limits.max_performance_fee_bps / 100}%
              </span>
            </div>
            <div className="row">
              <span className="k">Per-validator ceiling</span>
              <span className="v numeral">
                {config.limits.max_validator_weight_bps / 100}%
              </span>
            </div>
            <div className="row">
              <span className="k">Allowlisted validators</span>
              <span className="v numeral">{config.validator_allowlist.length}</span>
            </div>
          </div>
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
    () =>
      Object.values(weights).reduce((total, pct) => total + (Number(pct) || 0) * 100, 0),
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

  if (!config) return <div className="card">Loading…</div>;

  const locked = !connection || !isManager;

  return (
    <div className="grid">
      <div>
        <div className="card">
          <p className="card-title">Validator distribution</p>

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
                    <td className="numeral muted">
                      {entry ? fromMicro(entry.bonded, 0) : "0"}
                    </td>
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
                          borderRadius: 12,
                          border: `1px solid ${over ? "var(--danger)" : "var(--card-hairline)"}`,
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
              style={{ color: Math.round(weightSum) === 10_000 ? undefined : "var(--danger)" }}
            >
              {(weightSum / 100).toFixed(2)}% / 100.00%
            </span>
          </div>

          {overCeiling.length > 0 && (
            <p className="note" style={{ color: "var(--danger)" }}>
              {overCeiling.length} validator{overCeiling.length === 1 ? "" : "s"} above the{" "}
              {weightCeiling / 100}% ceiling. The ceiling is compiled into the contract:
              raising it needs a governance-approved code version, not a setting.
            </p>
          )}

          <button
            className="btn"
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

        <div className="card">
          <p className="card-title">Rebalance</p>
          <p className="note" style={{ marginTop: 0, marginBottom: 16 }}>
            Moves stake that is already delegated. New deposits drift toward the target
            weights on their own, so this is for correcting a set that has already gone out
            of shape.
          </p>

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
            className="btn btn--ghost"
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

      <div>
        <div className="card card--yield">
          <p className="card-title">Performance fee</p>
          <div className="amount" style={{ borderBottomColor: "rgba(0,0,0,0.08)" }}>
            <input
              inputMode="decimal"
              value={fee}
              disabled={locked}
              onChange={(e) => setFee(e.target.value.replace(/[^\d.]/g, ""))}
            />
            <span className="denom">%</span>
          </div>
          <p className="note">
            Taken from staking rewards, never from principal. The network capped this at{" "}
            {config.limits.max_performance_fee_bps / 100}%.
          </p>
          <button
            className="btn"
            disabled={
              locked || (Number(fee) || 0) * 100 > config.limits.max_performance_fee_bps
            }
            onClick={() =>
              run("Fee updated.", () =>
                setPerformanceFee(connection!, Math.round((Number(fee) || 0) * 100)),
              )
            }
          >
            Set fee
          </button>
        </div>

        <div className={config.paused ? "card card--warn" : "card"}>
          <p className="card-title">Deposits</p>
          <p className="big">{config.paused ? "Paused" : "Open"}</p>
          <p className="note">
            Pausing blocks new deposits only. Claims on matured windows are never pausable,
            so this cannot trap anyone&apos;s funds.
          </p>
          <button
            className="btn btn--ghost"
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

        <div className="card card--dark">
          <p className="card-title">Who you are signing as</p>
          <div className="row">
            <span className="k">Manager on chain</span>
            <span className="v">{shortAddress(config.manager)}</span>
          </div>
          {!connection ? (
            <p className="note">Connect a wallet to act as the manager.</p>
          ) : isManager ? (
            <p className="note">
              This wallet is the manager. Everything on this screen is bounded by ceilings
              in the contract — there is no action here that can move a user&apos;s funds.
            </p>
          ) : (
            <p className="note">
              This wallet is not the manager, so the controls are read-only. Changing who
              the manager is takes a governance-approved code version.
            </p>
          )}
        </div>

        <Status feedback={feedback} />
      </div>
    </div>
  );
}
