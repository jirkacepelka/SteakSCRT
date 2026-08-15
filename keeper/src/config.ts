/**
 * Keeper configuration, read from the environment.
 *
 * The keeper is deliberately unprivileged. Every task it performs is a permissionless
 * message that anyone could send, so its key needs gas and nothing else: losing it costs
 * the operator some SCRT and stalls upkeep until a replacement runs, but it cannot move
 * user funds, change the fee, or touch the validator set. Nothing here should ever be
 * given the manager's key.
 */

export interface KeeperConfig {
  chainId: string;
  lcdUrl: string;
  mnemonic: string;
  contract: string;
  contractCodeHash: string;

  /** How often to refresh cached totals. */
  syncIntervalMs: number;
  /** How often to harvest and restake rewards. */
  compoundIntervalMs: number;
  /** How often to check whether a window can close or a matured one can be collected. */
  windowIntervalMs: number;

  /** Validators handled per paginated call. */
  pageLimit: number;
  /** Gas limit per upkeep transaction. */
  gasLimit: number;
  gasPrice: string;

  /** Exit after a single pass instead of looping. Useful under an external scheduler. */
  once: boolean;
  /** Run the invariant checks and report, without sending anything. */
  checkOnly: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. See keeper/.env.example.`);
  }
  return value;
}

function duration(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (!raw) return fallbackMs;

  const match = /^(\d+)(s|m|h)$/.exec(raw.trim());
  if (!match) {
    throw new Error(`${name} must look like "30s", "10m" or "6h", got "${raw}".`);
  }

  const scales: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };
  const scale = scales[match[2] as string];
  if (scale === undefined) {
    throw new Error(`${name} has an unsupported unit "${match[2]}".`);
  }
  return Number(match[1]) * scale;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): KeeperConfig {
  return {
    chainId: process.env.CHAIN_ID ?? "secret-4",
    lcdUrl: process.env.LCD_URL ?? "https://lcd.mainnet.secretsaturn.net",
    mnemonic: required("KEEPER_MNEMONIC"),
    contract: required("LST_CORE_ADDRESS"),
    contractCodeHash: required("LST_CORE_CODE_HASH"),

    // No longer what stands between a user and transacting — deposits and withdrawals
    // refresh the cache themselves — but it still keeps the published rate and the
    // validator figures current on a protocol nobody happens to be using, and it is what
    // `sync_stale_after_secs` measures the keeper against.
    syncIntervalMs: duration("SYNC_INTERVAL", 30 * 60_000),
    // Rewards accrue every block; compounding more often than a few hours costs more gas
    // than it earns.
    compoundIntervalMs: duration("COMPOUND_INTERVAL", 6 * 3_600_000),
    // Windows close on a multi-day cadence. Checking often is cheap because the contract
    // refuses early closes, so a no-op costs one failed simulation.
    windowIntervalMs: duration("WINDOW_INTERVAL", 15 * 60_000),

    /*
     * Sized from measurement, not from caution. Against a four-validator devnet:
     *
     *   sync,  1 validator    44 910 gas
     *   sync,  4 validators   66 689 gas
     *   compound, 4           99 601 gas
     *
     * so a validator costs roughly 7 000 gas and the fixed cost of being a transaction
     * at all is around 38 000. Two consequences, both of which the old defaults got
     * backwards.
     *
     * Paging is a false economy at this size. The same four validators cost 66 689 gas in
     * one call and 107 496 in two, because the second transaction pays the base cost
     * again. Paging exists so a huge set cannot exceed the block gas limit; at 7 000 gas
     * each, fifty validators still fit in one call, so the page should cover the whole
     * allowlist and only shrink if a set ever grows past that.
     *
     * The gas limit is charged in full. Cosmos takes the fee you declare, not the gas you
     * burn, so declaring 1 500 000 for a 67 000-gas transaction was paying 22x over the
     * odds on every single one. 400 000 keeps a wide margin over the largest measured
     * call and still costs a fraction.
     */
    pageLimit: Number(process.env.PAGE_LIMIT ?? 25),
    gasLimit: Number(process.env.GAS_LIMIT ?? 400_000),
    // The chain's minimum is 0.0125 uscrt. Twice that absorbs a min-price change without
    // an emergency redeploy; the old 0.1 was eight times the floor for no reason.
    gasPrice: process.env.GAS_PRICE ?? "0.025uscrt",

    once: argv.includes("--once"),
    checkOnly: argv.includes("--check-only"),
  };
}
