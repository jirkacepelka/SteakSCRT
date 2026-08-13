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

    // Freshness gates deposits and withdrawals, so this is the interval that decides
    // whether users can transact at all. It must stay comfortably under the contract's
    // `sync_stale_after_secs`.
    syncIntervalMs: duration("SYNC_INTERVAL", 30 * 60_000),
    // Rewards accrue every block; compounding more often than a few hours costs more gas
    // than it earns.
    compoundIntervalMs: duration("COMPOUND_INTERVAL", 6 * 3_600_000),
    // Windows close on a multi-day cadence. Checking often is cheap because the contract
    // refuses early closes, so a no-op costs one failed simulation.
    windowIntervalMs: duration("WINDOW_INTERVAL", 15 * 60_000),

    pageLimit: Number(process.env.PAGE_LIMIT ?? 3),
    gasLimit: Number(process.env.GAS_LIMIT ?? 1_500_000),
    gasPrice: process.env.GAS_PRICE ?? "0.1uscrt",

    once: argv.includes("--once"),
    checkOnly: argv.includes("--check-only"),
  };
}
