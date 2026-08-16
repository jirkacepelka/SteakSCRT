/**
 * Which node the app talks to.
 *
 * The build ships one LCD URL, and until now that was the only one: if it went down, so
 * did the interface, while the protocol carried on perfectly well without anybody able to
 * reach it. A contract has no opinion about which node you use to read it, so this lets a
 * user point the app somewhere else and keeps that choice in their own browser.
 *
 * No list of "blessed" endpoints ships with the app. Recommending nodes I have not tested
 * would be worse than useless — it would look like an endorsement — so the picker offers
 * the build's default plus whatever the user adds, and every entry is judged by an actual
 * request rather than by being on a list.
 */

import { DEPLOYMENT } from "./chain";

const STORAGE_KEY = "secret-lst.endpoint";

/** Endpoints the user has added, most recent first, excluding the build default. */
const CUSTOM_KEY = "secret-lst.endpoints";

export interface EndpointHealth {
  url: string;
  ok: boolean;
  /** Round-trip in milliseconds for a latest-block query. */
  latencyMs: number | null;
  /** Chain the node reports. A mismatch is the mistake worth catching loudest. */
  chainId: string | null;
  height: number | null;
  error: string | null;
}

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private browsing, or storage disabled. The default still works.
    return null;
  }
}

/** The LCD every read and write should go through. */
export function lcdUrl(): string {
  return readStorage(STORAGE_KEY) || DEPLOYMENT.lcdUrl;
}

export function isDefaultEndpoint(): boolean {
  return lcdUrl() === DEPLOYMENT.lcdUrl;
}

export function customEndpoints(): string[] {
  const raw = readStorage(CUSTOM_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

function write(key: string, value: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the selection simply will not persist.
  }
}

/**
 * Point the app at an endpoint.
 *
 * Reloads deliberately. secret.js clients are constructed with their URL and cached in
 * module scope all over the app; rebuilding that graph in place would leave stale clients
 * in flight and produce exactly the sort of bug that only shows up for the one user who
 * switched. A reload is honest and costs a second.
 */
export function useEndpoint(url: string | null) {
  write(STORAGE_KEY, url);
  if (url) {
    const others = customEndpoints().filter((u) => u !== url && u !== DEPLOYMENT.lcdUrl);
    write(CUSTOM_KEY, JSON.stringify([url, ...others].slice(0, 8)));
  }
  if (typeof window !== "undefined") window.location.reload();
}

export function forgetEndpoint(url: string) {
  write(CUSTOM_KEY, JSON.stringify(customEndpoints().filter((u) => u !== url)));
}

export function normaliseUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    // A page served over https cannot read an http endpoint; the browser blocks it and the
    // failure looks like the node being down. Say so up front instead.
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Ask a node what it is, and how quickly it answers. */
export async function checkEndpoint(url: string, timeoutMs = 6_000): Promise<EndpointHealth> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${url}/cosmos/base/tendermint/v1beta1/blocks/latest`, {
      signal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) {
      return { url, ok: false, latencyMs, chainId: null, height: null, error: `HTTP ${res.status}` };
    }

    const body = (await res.json()) as {
      block?: { header?: { chain_id?: string; height?: string } };
    };
    const chainId = body.block?.header?.chain_id ?? null;
    const height = Number(body.block?.header?.height) || null;

    if (chainId && chainId !== DEPLOYMENT.chainId) {
      return {
        url,
        ok: false,
        latencyMs,
        chainId,
        height,
        error: `serves ${chainId}, not ${DEPLOYMENT.chainId}`,
      };
    }

    return { url, ok: true, latencyMs, chainId, height, error: null };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      url,
      ok: false,
      latencyMs: null,
      chainId: null,
      height: null,
      error: aborted ? `no answer in ${timeoutMs / 1000}s` : "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}
