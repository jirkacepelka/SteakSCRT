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
  is_unattended: boolean;
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
 * 1 500 000 at that price billed every deposit, withdrawal and claim 0.15 SCRT. Measured
 * against a four-validator devnet, they use:
 *
 *   deposit                   113 864
 *   unbond (Send + hook)      155 108
 *   claim                      44 640
 *
 * so a claim was paying thirty-three times over. On a small position that gas dwarfed the
 * protocol's own economics: 0.15 SCRT is roughly an 8% cut of a year's rewards on an
 * eight-SCRT deposit.
 *
 * Deposits and withdrawals scale with the validator set, because both re-read every
 * delegation before pricing — about 7 500 gas each. A flat limit therefore has to choose
 * between being wrong on a large set and overcharging on a small one, so it is computed
 * from the set instead. `scripts/gas-probe.mjs` measures these against a live devnet and
 * fails if the margin drops below 1.8x; re-run it whenever the pricing path changes.
 *
 * Too low is worse than too high — the transaction fails and the fee is charged anyway —
 * hence the 2.5x margin. Wallets may substitute their own fee when they sign, which this
 * app cannot force either way, but the declared limit is what such a wallet prices.
 */
const GAS_PRICE = 0.025;

/** Ceiling the contract compiles in, and the fallback when the set is not loaded yet. */
const MAX_VALIDATORS = 20;

/**
 * Fixed cost of the action, before any delegation is read.
 *
 * Both are sized for the expensive case, not the common one: a deposit or withdrawal also
 * closes an overdue window when it finds one, which adds an undelegation plan and a
 * staking message. Measured at four validators, an ordinary deposit costs 113 942 gas and
 * one that closes a window costs 152 829 — so sizing from the ordinary figure left the
 * transaction that matters at 1.9x margin instead of the intended 2.5x.
 */
const GAS_BASE = { deposit: 125_000, unbond: 125_000 } as const;
const GAS_PER_VALIDATOR = 7_500;
const GAS_MARGIN = 2.5;

function scaled(action: keyof typeof GAS_BASE, validators?: number): number {
  const n = validators && validators > 0 ? validators : MAX_VALIDATORS;
  return Math.ceil((GAS_BASE[action] + GAS_PER_VALIDATOR * n) * GAS_MARGIN);
}

export const GAS = {
  /** Neither of these reads the validator set, so both are flat. */
  claim: 300_000,
  /** Manager actions scale with the set but are rare and not user-facing. */
  manage: 700_000,
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

export function deposit(conn: Connection, microAmount: string, validators?: number) {
  return execCore(conn, { deposit: {} }, scaled("deposit", validators), [
    { denom: DENOM, amount: microAmount },
  ]);
}

/**
 * Request a withdrawal.
 *
 * Driven through the token rather than the core contract: the user sends dSCRT to
 * `lst-core` with an `Unbond` hook, which is the only way the core can be sure the tokens
 * really moved before it books a claim against them.
 */
export async function requestUnbond(
  conn: Connection,
  microShares: string,
  validators?: number,
) {
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
    { gasLimit: scaled("unbond", validators), gasPriceInFeeDenom: GAS_PRICE },
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
