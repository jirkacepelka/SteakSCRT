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
        { gasLimit: this.config.gasLimit, gasPriceInFeeDenom: Number(this.config.gasPrice.replace(/[^\d.]/g, "")) },
      );

      if (tx.code !== 0) {
        return { ok: false, error: tx.rawLog };
      }
      return { ok: true, txHash: tx.transactionHash };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Balance of the keeper's own account, so it can warn before it runs out of gas. */
  async gasBalance(): Promise<bigint> {
    const { balance } = await this.client.query.bank.balance({
      address: this.address,
      denom: "uscrt",
    });
    return BigInt(balance?.amount ?? "0");
  }
}
