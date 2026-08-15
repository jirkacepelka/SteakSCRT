/**
 * Thin wrapper over secret.js for the handful of calls the keeper makes.
 */

import { SecretNetworkClient, Wallet } from "secretjs";

import type { KeeperConfig } from "./config.ts";

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

export interface ValidatorEntry {
  address: string;
  weight_bps: number;
  status: "active" | "draining" | "removed";
  bonded: string;
  pending_rewards: string;
  active_unbond_entries: number;
}

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
  state: "open" | "unbonding" | "matured" | "settled";
}

/** The ceiling the contract compiles in, and what to assume before the set is known. */
const MAX_VALIDATORS = 20;
const COMPOUND_BASE_GAS = 95_000;
const PER_VALIDATOR_GAS = 9_300;
const GAS_MARGIN = 2.5;

export class Keeper {
  private readonly client: SecretNetworkClient;
  private readonly config: KeeperConfig;

  constructor(config: KeeperConfig) {
    this.config = config;
    const wallet = new Wallet(config.mnemonic);
    this.client = new SecretNetworkClient({
      chainId: config.chainId,
      url: config.lcdUrl,
      wallet,
      walletAddress: wallet.address,
    });
  }

  get address(): string {
    return this.client.address;
  }

  private async query<T>(query: object): Promise<T> {
    return (await this.client.query.compute.queryContract({
      contract_address: this.config.contract,
      code_hash: this.config.contractCodeHash,
      query,
    })) as T;
  }

  async state(): Promise<ProtocolState> {
    const answer = await this.query<{ state: ProtocolState }>({ state: {} });
    return answer.state;
  }

  async validators(): Promise<ValidatorEntry[]> {
    const answer = await this.query<{ validators: { validators: ValidatorEntry[] } }>({
      validators: {},
    });
    // Remembered so the gas limit can be sized from the real set rather than from the
    // contract's ceiling. The invariant sweep reads this at the top of every cycle, so it
    // is current well before any transaction goes out.
    this.validatorCount = answer.validators.validators.length;
    return answer.validators.validators;
  }

  async windows(state?: UnbondWindow["state"]): Promise<UnbondWindow[]> {
    const answer = await this.query<{ windows: { windows: UnbondWindow[] } }>({
      windows: { state: state ?? null, start_after: null, limit: 50 },
    });
    return answer.windows.windows;
  }

  /**
   * Send an upkeep message.
   *
   * Failures are returned rather than thrown. Every task the keeper runs is expected to
   * be a no-op sometimes — a window that has not closed yet, a sweep with nothing to
   * harvest — and a keeper that dies on the first such refusal would stop doing the work
   * it exists for.
   */
  async execute(
    msg: object,
  ): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
    try {
      const tx = await this.client.tx.compute.executeContract(
        {
          sender: this.address,
          contract_address: this.config.contract,
          code_hash: this.config.contractCodeHash,
          msg,
          sent_funds: [],
        },
        {
          gasLimit: this.gasLimit(),
          gasPriceInFeeDenom: Number(this.config.gasPrice.replace(/[^\d.]/g, "")),
        },
      );

      if (tx.code !== 0) {
        return { ok: false, error: tx.rawLog };
      }
      return { ok: true, txHash: tx.transactionHash };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Gas for one upkeep transaction, sized from the validator set.
   *
   * Every task the keeper runs costs a fixed amount plus a per-validator amount, so a flat
   * limit is either too small on a large set or overcharges on a small one — and the fee
   * is the limit, not the gas burned, so overcharging is real money. Measured on a devnet:
   *
   *   sync       45 001 at one validator, 66 241 at four   -> ~7 000 each
   *   compound  104 655 at one validator, 132 586 at four  -> ~9 300 each
   *
   * Compound is the expensive shape, so its numbers size every task. A flat 400 000 held
   * at four validators and would have gone tight at the contract's ceiling of twenty.
   *
   * `GAS_LIMIT` still overrides, for a chain whose costs have moved.
   */
  private gasLimit(): number {
    if (this.config.gasLimit) return this.config.gasLimit;
    const n = this.validatorCount ?? MAX_VALIDATORS;
    return Math.ceil((COMPOUND_BASE_GAS + PER_VALIDATOR_GAS * n) * GAS_MARGIN);
  }

  /** Set once the keeper has seen the set, so the first transaction assumes the worst. */
  validatorCount: number | null = null;

  /** Balance of the keeper's own account, so it can warn before it runs out of gas. */
  async gasBalance(): Promise<bigint> {
    const { balance } = await this.client.query.bank.balance({
      address: this.address,
      denom: "uscrt",
    });
    return BigInt(balance?.amount ?? "0");
  }
}
