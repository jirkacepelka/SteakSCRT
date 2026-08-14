/**
 * Historical protocol state, read from the chain.
 *
 * The contract stores no history — only what is true now. Rather than invent a series or
 * stand up an indexer, this replays the same query against past block heights: an LCD will
 * serve contract state at any height it still retains, so the chart is the chain's own
 * record rather than a reconstruction.
 *
 * Two consequences worth knowing:
 *
 *   The series cannot start before the contract existed. Queries below the deployment
 *   height answer "not found: contract", which is a real answer rather than an error, so
 *   those points are dropped and the chart simply begins when the protocol did.
 *
 *   A pruned node limits how far back it can see. Points it refuses are dropped the same
 *   way, and the chart says how many it got.
 */

import { fromBase64, fromUtf8, toBase64 } from "@cosmjs/encoding";
import { SecretNetworkClient } from "secretjs";

import { DEPLOYMENT, readOnlyClient } from "./chain";
import type { ProtocolState } from "./protocol";

export interface Sample {
  height: number;
  /** Unix seconds, interpolated from measured block time. */
  time: number;
  state: ProtocolState;
}

export type Range = "24h" | "7d" | "30d";

const RANGE_SECONDS: Record<Range, number> = {
  "24h": 24 * 3_600,
  "7d": 7 * 86_400,
  "30d": 30 * 86_400,
};

/** How many points to plot. Each one is a request, so this is a cost as well as a shape. */
const POINTS = 24;

/**
 * The block the core contract was created in.
 *
 * Without this a freshly deployed protocol charts nothing: a seven-day window spaces its
 * points hours apart, every one of them lands before the contract existed, and the only
 * survivor is the final point — which is not a line. Clamping the window to the
 * deployment means a protocol an hour old still draws its hour.
 */
async function createdHeight(): Promise<number | null> {
  try {
    const res = await fetch(
      `${DEPLOYMENT.lcdUrl}/compute/v1beta1/info/${DEPLOYMENT.core.address}`,
    );
    if (!res.ok) return null;
    const body = await res.json();
    const height = Number(body?.contract_info?.created?.block_height);
    return Number.isFinite(height) && height > 0 ? height : null;
  } catch {
    return null;
  }
}

async function latestHeight(): Promise<{ height: number; time: number }> {
  const res = await fetch(`${DEPLOYMENT.lcdUrl}/cosmos/base/tendermint/v1beta1/blocks/latest`);
  const body = await res.json();
  return {
    height: Number(body.block.header.height),
    time: Math.floor(new Date(body.block.header.time).getTime() / 1000),
  };
}

/**
 * Seconds per block, measured rather than assumed.
 *
 * Chains do not hold their nominal block time, and a wrong constant would put every
 * point on the wrong date — the sort of error nobody notices because the chart still
 * looks plausible.
 */
async function blockSeconds(latest: { height: number; time: number }): Promise<number> {
  const back = Math.min(2_000, latest.height - 1);
  if (back <= 0) return 6;

  const res = await fetch(
    `${DEPLOYMENT.lcdUrl}/cosmos/base/tendermint/v1beta1/blocks/${latest.height - back}`,
  );
  if (!res.ok) return 6;

  const body = await res.json();
  const then = Math.floor(new Date(body.block.header.time).getTime() / 1000);
  const seconds = (latest.time - then) / back;
  return seconds > 0.5 && seconds < 60 ? seconds : 6;
}

/**
 * The encryption helpers secret.js uses internally.
 *
 * Marked private on the class, but this is the one thing the library has no public route
 * to: `queryContract` cannot set a block-height header, so a historical query has to be
 * assembled by hand. `private` here is a TypeScript visibility annotation, not a runtime
 * barrier, and the shape below is exactly what secret.js itself calls.
 */
interface EncryptionUtils {
  encrypt(codeHash: string, msg: object): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, nonce: Uint8Array): Promise<Uint8Array>;
}

/** Query the core contract at a specific height, or null if it has nothing to say there. */
async function stateAt(
  client: SecretNetworkClient,
  height: number | null,
): Promise<ProtocolState | null> {
  try {
    const utils = (client as unknown as { encryptionUtils: EncryptionUtils })
      .encryptionUtils;
    const encrypted = await utils.encrypt(DEPLOYMENT.core.codeHash, { state: {} });
    const nonce = encrypted.slice(0, 32);

    const url =
      `${DEPLOYMENT.lcdUrl}/compute/v1beta1/query/${DEPLOYMENT.core.address}` +
      `?query=${encodeURIComponent(toBase64(encrypted))}`;

    const res = await fetch(url, {
      headers: height ? { "x-cosmos-block-height": String(height) } : undefined,
    });
    if (!res.ok) return null;

    const body = await res.json();
    const plain = await utils.decrypt(fromBase64(body.data), nonce);
    const answer = JSON.parse(fromUtf8(fromBase64(fromUtf8(plain)))) as {
      state: ProtocolState;
    };
    return answer.state;
  } catch {
    return null;
  }
}

/** Run promises a few at a time, so a chart load does not open two dozen sockets at once. */
async function pooled<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

export interface History {
  samples: Sample[];
  /** Points the chain could not answer — before deployment, or pruned away. */
  missing: number;
}

export async function fetchHistory(range: Range): Promise<History> {
  const client = readOnlyClient();
  const latest = await latestHeight();
  const [seconds, created] = await Promise.all([blockSeconds(latest), createdHeight()]);

  // Never sample before the contract existed: those points are guaranteed misses, and
  // spending the window on them is what leaves a young protocol with an empty chart.
  const earliest = created ?? 1;
  const requested = Math.floor(RANGE_SECONDS[range] / seconds);
  const span = Math.max(1, Math.min(requested, latest.height - earliest));
  const step = Math.max(1, Math.floor(span / (POINTS - 1)));

  const heights = Array.from({ length: POINTS }, (_, i) =>
    Math.min(latest.height, Math.max(earliest, latest.height - span + i * step)),
  );

  const unique = [...new Set(heights)];

  const results = await pooled(unique, 6, async (height) => {
    const isLatest = height >= latest.height;
    const state = await stateAt(client, isLatest ? null : height);
    if (!state) return null;
    return {
      height,
      time: latest.time - Math.round((latest.height - height) * seconds),
      state,
    } satisfies Sample;
  });

  const samples = results.filter((s): s is Sample => s !== null);
  return { samples, missing: unique.length - samples.length };
}
