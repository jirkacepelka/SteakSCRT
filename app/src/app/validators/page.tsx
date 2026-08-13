"use client";

import { useEffect, useState } from "react";

import { fromMicro, shortAddress } from "@/lib/chain";
import {
  fetchConfig,
  fetchValidators,
  type Config,
  type ValidatorEntry,
} from "@/lib/protocol";

export default function ValidatorsPage() {
  const [validators, setValidators] = useState<ValidatorEntry[]>([]);
  const [config, setConfig] = useState<Config | null>(null);

  useEffect(() => {
    void (async () => {
      const [v, c] = await Promise.all([fetchValidators(), fetchConfig()]);
      setValidators(v);
      setConfig(c);
    })().catch(() => undefined);
  }, []);

  const total = validators.reduce((sum, v) => sum + Number(v.bonded), 0);

  return (
    <div className="grid">
      <div className="card">
        <p className="card-title">Where the stake sits</p>
        <table className="plain">
          <thead>
            <tr>
              <th>Validator</th>
              <th>Target</th>
              <th>Actual</th>
              <th>Bonded</th>
            </tr>
          </thead>
          <tbody>
            {validators.map((v) => {
              const actual = total > 0 ? (Number(v.bonded) / total) * 100 : 0;
              return (
                <tr key={v.address}>
                  <td>
                    <span title={v.address}>{shortAddress(v.address)}</span>
                    {v.status !== "active" && (
                      <>
                        {" "}
                        <span className="pill">{v.status}</span>
                      </>
                    )}
                  </td>
                  <td className="numeral">{(v.weight_bps / 100).toFixed(2)}%</td>
                  <td className="numeral">{actual.toFixed(2)}%</td>
                  <td className="numeral muted">{fromMicro(v.bonded, 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="note">
          Published rather than buried. A liquid staking protocol decides where a lot of a
          chain&apos;s stake goes, and its users should be able to see that without reading
          the chain.
        </p>
      </div>

      <div className="card card--yield">
        <p className="card-title">Concentration ceiling</p>
        <p className="big numeral">
          {config ? `${config.limits.max_validator_weight_bps / 100}%` : "—"}
        </p>
        <p className="note">
          The most any single validator may hold, compiled into the contract rather than
          configured. Raising it needs a governance-approved code version, so it cannot be
          quietly changed by whoever runs the protocol day to day.
        </p>
        <p className="note">
          For comparison, the incumbent SCRT liquid staking derivative routes 64% of its
          stake to a single operator.
        </p>
      </div>
    </div>
  );
}
