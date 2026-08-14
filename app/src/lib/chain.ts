/**
 * Wallet connection, contract queries, and the app-wide permit.
 *
 * Everything here runs in the browser. There is no server: reads are contract queries and
 * writes are signed in the user's wallet, which is what lets the whole app be a static
 * export that anyone can host.
 */

import { SecretNetworkClient, type Permit } from "secretjs";

export interface Deployment {
  chainId: string;
  lcdUrl: string;
  core: { address: string; codeHash: string };
  token: { address: string; codeHash: string };
}

/**
 * Read from the build environment so the same bundle can be pointed at devnet, pulsar or
 * mainnet without a code change.
 */
export const DEPLOYMENT: Deployment = {
  chainId: process.env.NEXT_PUBLIC_CHAIN_ID ?? "secretdev-1",
  lcdUrl: process.env.NEXT_PUBLIC_LCD_URL ?? "http://localhost:1317",
  core: {
    address: process.env.NEXT_PUBLIC_CORE_ADDRESS ?? "",
    codeHash: process.env.NEXT_PUBLIC_CORE_CODE_HASH ?? "",
  },
  token: {
    address: process.env.NEXT_PUBLIC_TOKEN_ADDRESS ?? "",
    codeHash: process.env.NEXT_PUBLIC_TOKEN_CODE_HASH ?? "",
  },
};

/**
 * Whether the build actually knows which deployment it is pointing at.
 *
 * With the variables missing, the addresses are empty strings and every query goes to
 * `/compute/v1beta1/query/` — which serves the app's own HTML back, so the first thing a
 * user sees is `Unexpected token '<'`. That is a deployment mistake wearing the costume of
 * a chain error, and it cost a round of debugging on a live Vercel build, so the app says
 * plainly what is missing instead.
 */
export const CONFIGURED = Boolean(
  DEPLOYMENT.lcdUrl &&
    DEPLOYMENT.core.address &&
    DEPLOYMENT.core.codeHash &&
    DEPLOYMENT.token.address &&
    DEPLOYMENT.token.codeHash,
);

export const DENOM = "uscrt";
export const DECIMALS = 6;

// ---- wallet ----

interface KeplrWindow {
  keplr?: {
    enable(chainId: string): Promise<void>;
    getOfflineSignerOnlyAmino(chainId: string): unknown;
    getEnigmaUtils(chainId: string): unknown;
    signAmino(chainId: string, signer: string, doc: unknown, opts?: unknown): Promise<{ signature: { pub_key: { value: string }; signature: string } }>;
  };
  getOfflineSignerOnlyAmino?: (chainId: string) => unknown;
}

function keplr() {
  const w = window as unknown as KeplrWindow;
  if (!w.keplr) {
    throw new Error("Keplr was not found. Install the extension and reload.");
  }
  return w.keplr;
}

export interface Connection {
  address: string;
  client: SecretNetworkClient;
}

export async function connect(): Promise<Connection> {
  const k = keplr();
  await k.enable(DEPLOYMENT.chainId);

  const signer = k.getOfflineSignerOnlyAmino(DEPLOYMENT.chainId) as {
    getAccounts(): Promise<{ address: string }[]>;
  };
  const [account] = await signer.getAccounts();
  if (!account) throw new Error("Keplr returned no account.");

  const client = new SecretNetworkClient({
    chainId: DEPLOYMENT.chainId,
    url: DEPLOYMENT.lcdUrl,
    wallet: signer as never,
    walletAddress: account.address,
    encryptionUtils: k.getEnigmaUtils(DEPLOYMENT.chainId) as never,
  });

  return { address: account.address, client };
}

/** A read-only client, so the public screens work before anyone connects a wallet. */
export function readOnlyClient(): SecretNetworkClient {
  return new SecretNetworkClient({
    chainId: DEPLOYMENT.chainId,
    url: DEPLOYMENT.lcdUrl,
  });
}

// ---- the app-wide permit ----

const PERMIT_NAME = "secret-lst-app";
const PERMIT_STORAGE_KEY = "secret-lst.permit";

/**
 * Sign one permit and reuse it for every authenticated query.
 *
 * A permit is a wallet signature, not a transaction: it costs nothing, stores no secret in
 * the contract, and names the contracts it is valid for so it cannot be replayed against
 * anything else. Signing once per session and caching it is the difference between the app
 * asking for a signature on every screen and asking once.
 *
 * Cached in localStorage keyed by address. It is a capability to read the user's own
 * position, not a spending authority, and it lives only in their own browser.
 */
export async function getPermit(address: string): Promise<Permit> {
  const cached = localStorage.getItem(`${PERMIT_STORAGE_KEY}.${address}`);
  if (cached) {
    try {
      return JSON.parse(cached) as Permit;
    } catch {
      // Corrupt entry; fall through and sign a fresh one.
    }
  }

  const k = keplr();
  const permitTx = {
    chain_id: DEPLOYMENT.chainId,
    account_number: "0",
    sequence: "0",
    fee: { amount: [{ denom: DENOM, amount: "0" }], gas: "1" },
    msgs: [
      {
        type: "query_permit",
        value: {
          permit_name: PERMIT_NAME,
          // Both contracts, because one permit is supposed to cover the whole app: the
          // core answers the user's claims, the token answers their dSCRT balance. Naming
          // only one would put the signature prompt back on every second screen.
          allowed_tokens: [DEPLOYMENT.core.address, DEPLOYMENT.token.address],
          permissions: ["balance", "owner"],
        },
      },
    ],
    memo: "",
  };

  const { signature } = await k.signAmino(DEPLOYMENT.chainId, address, permitTx, {
    preferNoSetFee: true,
    preferNoSetMemo: true,
  });

  const permit = {
    params: {
      permit_name: PERMIT_NAME,
      allowed_tokens: [DEPLOYMENT.core.address, DEPLOYMENT.token.address],
      chain_id: DEPLOYMENT.chainId,
      permissions: ["balance", "owner"],
    },
    signature,
  } as unknown as Permit;

  localStorage.setItem(`${PERMIT_STORAGE_KEY}.${address}`, JSON.stringify(permit));
  return permit;
}

export function forgetPermit(address: string) {
  localStorage.removeItem(`${PERMIT_STORAGE_KEY}.${address}`);
}

/**
 * Base64-encode a string in the browser.
 *
 * Deliberately not `Buffer`: it is a Node API, and Next does not polyfill it. Using it
 * here typechecked cleanly, passed every unit test, and then threw
 * `Buffer is not defined` for any user who tried to withdraw — the one code path that had
 * no browser coverage.
 */
export function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ---- formatting ----

export function fromMicro(raw: string | number | bigint, dp = 4): string {
  const value = Number(raw) / 10 ** DECIMALS;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

export function toMicro(input: string): string {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) throw new Error("Enter an amount.");
  return BigInt(Math.round(value * 10 ** DECIMALS)).toString();
}

/** SCRT per dSCRT. The contract reports it scaled by 10^18. */
export function rateToNumber(scaled: string): number {
  return Number(BigInt(scaled) / 10n ** 10n) / 1e8;
}

export function shortAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 10)}…${address.slice(-6)}` : address;
}

export function whenFrom(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function untilFrom(seconds: number): string {
  const left = seconds - Math.floor(Date.now() / 1000);
  if (left <= 0) return "now";
  const days = Math.floor(left / 86_400);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(left / 3_600);
  if (hours >= 1) return `${hours} h`;
  return `${Math.max(1, Math.floor(left / 60))} min`;
}
