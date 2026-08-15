/**
 * Typed access to the protocol's contracts.
 *
 * The shapes mirror `packages/lst-types`. Anything the contract can answer is here; the
 * screens do no message building of their own.
 */

import type { SecretNetworkClient } from "secretjs";

import { DEPLOYMENT, DENOM, readOnlyClient, toBase64, type Connection } from "./chain";

export interface ProtocolState {
  total_bonded: string;
  pending_rewards: string;
  liquid_unallocated: string;
  scrt_owed_to_windows: string;
  total_supply: string;
  last_sync_time: number;
  is_stale: boolean;
  exchange_rate: string;
}

export interface ManagerLimits {
  max_performance_fee_bps: number;
  max_validator_weight_bps: number;
}

export interface Config {
  manager: string;
  limits: ManagerLimits;
  validator_allowlist: string[];
  bootstrapped: boolean;
  treasury: string;
  token: { address: string; code_hash: string } | null;
  bonded_denom: string;
  params: {
    unbond_window_secs: number;
    unbonding_period_secs: number;
    performance_fee_bps: number;
    withdrawal_fee_bps: number;
    min_deposit: string;
    sync_stale_after_secs: number;
    max_unbond_entries_per_validator: number;
  };
  paused: boolean;
}

export interface ValidatorEntry {
  address: string;
  weight_bps: number;
  status: "active" | "draining" | "removed";
  bonded: string;
  pending_rewards: string;
  active_unbond_entries: number;
}

export type WindowState = "open" | "unbonding" | "matured" | "settled";

export interface UnbondWindow {
  id: number;
  opened_at: number;
  closes_at: number;
  matures_at: number;
  shares_burned: string;
  scrt_owed: string;
  scrt_realised: string | null;
  scrt_claimed: string;
  validators_used: string[];
  state: WindowState;
}

export interface UserClaim {
  window_id: number;
  shares_burned: string;
  scrt_owed: string;
  matures_at: number;
  state: WindowState;
  claimed: boolean;
}

async function queryCore<T>(client: SecretNetworkClient, query: object): Promise<T> {
  return (await client.query.compute.queryContract({
    contract_address: DEPLOYMENT.core.address,
    code_hash: DEPLOYMENT.core.codeHash,
    query,
  })) as T;
}

// ---- public reads ----

export async function fetchConfig(client = readOnlyClient()): Promise<Config> {
  const answer = await queryCore<{ config: Config }>(client, { config: {} });
  return answer.config;
}

export async function fetchState(client = readOnlyClient()): Promise<ProtocolState> {
  const answer = await queryCore<{ state: ProtocolState }>(client, { state: {} });
  return answer.state;
}

export async function fetchValidators(client = readOnlyClient()): Promise<ValidatorEntry[]> {
  const answer = await queryCore<{ validators: { validators: ValidatorEntry[] } }>(
    client,
    { validators: {} },
  );
  return answer.validators.validators;
}

export async function fetchWindows(
  state?: WindowState,
  client = readOnlyClient(),
): Promise<UnbondWindow[]> {
  const answer = await queryCore<{ windows: { windows: UnbondWindow[] } }>(client, {
    windows: { state: state ?? null, start_after: null, limit: 50 },
  });
  return answer.windows.windows;
}

// ---- authenticated read ----

export interface PendingClaims {
  claims: UserClaim[];
  total_owed: string;
  total_claimable_now: string;
}

export async function fetchPendingClaims(
  client: SecretNetworkClient,
  permit: unknown,
): Promise<PendingClaims> {
  const answer = await queryCore<{ pending_claims: PendingClaims }>(client, {
    with_permit: { permit, query: { pending_claims: {} } },
  });
  return answer.pending_claims;
}

/** The user's spendable SCRT. Public information — a bank balance, not contract state. */
export async function fetchScrtBalance(
  client: SecretNetworkClient,
  address: string,
): Promise<string> {
  const { balance } = await client.query.bank.balance({ address, denom: DENOM });
  return balance?.amount ?? "0";
}

/**
 * The user's dSCRT balance.
 *
 * Private state on the token contract, so it needs the same permit the core queries use.
 */
export async function fetchTokenBalance(
  client: SecretNetworkClient,
  permit: unknown,
): Promise<string> {
  const answer = (await client.query.compute.queryContract({
    contract_address: DEPLOYMENT.token.address,
    code_hash: DEPLOYMENT.token.codeHash,
    query: { with_permit: { permit, query: { balance: {} } } },
  })) as { balance: { amount: string } };
  return answer.balance.amount;
}

// ---- writes ----

/*
 * What a user pays.
 *
 * A Cosmos transaction is charged the fee it declares, not the gas it burns, and secret.js
 * defaults to 0.1 uscrt per gas — eight times the chain's own minimum. Declaring a flat
 * 1 500 000 at that price billed every deposit, withdrawal and claim 0.15 SCRT, which
 * against the gas these actually use, measured on a devnet:
 *
 *   deposit                    86 858
 *   unbond (Send + hook)      120 909
 *   claim                      44 646
 *
 * meant a claim was paying thirty-three times over. On a small deposit that gas dwarfed
 * the protocol's own fee: 0.15 SCRT is about what an 8% cut of a year's rewards comes to
 * on an eight-SCRT position.
 *
 * The limits below keep roughly a 2.5x margin over measurement, which covers a heavier
 * validator set or a claim spanning several windows. A limit that is too low is worse
 * than one that is too high — the transaction fails and the fee is charged anyway — so
 * the margin is deliberate, and it is still an order of magnitude better than a flat
 * ceiling.
 *
 * Wallets may substitute their own fee when they sign. That is not something this app can
 * force either way, but the declared limit is what such a wallet prices, so getting it
 * right helps in both cases.
 */
const GAS_PRICE = 0.025;

export const GAS = {
  deposit: 250_000,
  unbond: 300_000,
  claim: 300_000,
  /** Manager actions scale with the validator set, so they keep more room. */
  manage: 500_000,
} as const;

async function execCore(
  conn: Connection,
  msg: object,
  gasLimit: number,
  funds: { denom: string; amount: string }[] = [],
) {
  const tx = await conn.client.tx.compute.executeContract(
    {
      sender: conn.address,
      contract_address: DEPLOYMENT.core.address,
      code_hash: DEPLOYMENT.core.codeHash,
      msg,
      sent_funds: funds,
    },
    { gasLimit, gasPriceInFeeDenom: GAS_PRICE },
  );
  if (tx.code !== 0) throw new Error(tx.rawLog);
  return tx;
}

export function deposit(conn: Connection, microAmount: string) {
  return execCore(conn, { deposit: {} }, GAS.deposit, [{ denom: DENOM, amount: microAmount }]);
}

/**
 * Request a withdrawal.
 *
 * Driven through the token rather than the core contract: the user sends dSCRT to
 * `lst-core` with an `Unbond` hook, which is the only way the core can be sure the tokens
 * really moved before it books a claim against them.
 */
export async function requestUnbond(conn: Connection, microShares: string) {
  const hook = toBase64(JSON.stringify({ unbond: {} }));

  const tx = await conn.client.tx.compute.executeContract(
    {
      sender: conn.address,
      contract_address: DEPLOYMENT.token.address,
      code_hash: DEPLOYMENT.token.codeHash,
      msg: {
        send: {
          recipient: DEPLOYMENT.core.address,
          recipient_code_hash: DEPLOYMENT.core.codeHash,
          amount: microShares,
          msg: hook,
        },
      },
    },
    { gasLimit: GAS.unbond, gasPriceInFeeDenom: GAS_PRICE },
  );
  if (tx.code !== 0) throw new Error(tx.rawLog);
  return tx;
}

export function claimMatured(conn: Connection, windowIds?: number[]) {
  return execCore(conn, { claim_matured: { window_ids: windowIds ?? null } }, GAS.claim);
}

// ---- manager actions ----

export function setPerformanceFee(conn: Connection, bps: number) {
  return execCore(conn, { manager: { set_performance_fee: { bps } } }, GAS.manage);
}

export function setWeights(conn: Connection, weights: { address: string; weight_bps: number }[]) {
  return execCore(conn, { manager: { set_weights: { weights } } }, GAS.manage);
}

export function rebalance(
  conn: Connection,
  plan: { src_validator: string; dst_validator: string; amount: string }[],
) {
  return execCore(conn, { manager: { rebalance: { plan } } }, GAS.manage);
}

export function setPaused(conn: Connection, paused: boolean) {
  return execCore(conn, { set_paused: { paused } }, GAS.manage);
}
