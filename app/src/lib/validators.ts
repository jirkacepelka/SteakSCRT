/**
 * Who the validators actually are.
 *
 * The contract knows them as operator addresses, which is correct for it and useless for a
 * reader: `secretvaloper1fj9…mx2z` says nothing about whether you would want your stake
 * there. The staking module holds the name, so the interface asks it.
 *
 * A missing name is not an error. A validator can be unregistered, jailed out of the set,
 * or simply unreachable on a flaky node, and the address remains the truth in every one of
 * those cases — so it is what gets shown when there is nothing better.
 */

import { DEPLOYMENT } from "./chain";
import { lcdUrl } from "./endpoint";

export interface ValidatorInfo {
  address: string;
  /** The operator's own name for themselves, or the address if they have not given one. */
  moniker: string;
  jailed: boolean;
  /** Commission, as a fraction. */
  commission: number | null;
}

const cache = new Map<string, ValidatorInfo>();

async function fetchOne(address: string): Promise<ValidatorInfo> {
  const fallback: ValidatorInfo = { address, moniker: "", jailed: false, commission: null };
  try {
    const res = await fetch(`${lcdUrl()}/cosmos/staking/v1beta1/validators/${address}`);
    if (!res.ok) return fallback;

    const body = (await res.json()) as {
      validator?: {
        description?: { moniker?: string };
        jailed?: boolean;
        commission?: { commission_rates?: { rate?: string } };
      };
    };
    const v = body.validator;
    const rate = Number(v?.commission?.commission_rates?.rate);

    return {
      address,
      moniker: v?.description?.moniker?.trim() ?? "",
      jailed: Boolean(v?.jailed),
      commission: Number.isFinite(rate) ? rate : null,
    };
  } catch {
    return fallback;
  }
}

/** Names for a set of operators, asked for once each. */
export async function fetchValidatorInfo(
  addresses: string[],
): Promise<Map<string, ValidatorInfo>> {
  const missing = addresses.filter((a) => !cache.has(a));
  const fetched = await Promise.all(missing.map(fetchOne));
  for (const info of fetched) cache.set(info.address, info);

  return new Map(addresses.map((a) => [a, cache.get(a) ?? { address: a, moniker: "", jailed: false, commission: null }]));
}

/**
 * Where to read about a validator.
 *
 * Ping.pub keeps a testnet instance at a separate host, so the network decides which one.
 */
export function explorerUrl(address: string): string {
  const host =
    DEPLOYMENT.chainId === "secret-4" ? "https://ping.pub" : "https://testnet.ping.pub";
  return `${host}/secret/staking/${address}`;
}

/**
 * A stable colour per validator, so the same operator looks the same on every visit.
 *
 * Decoration, never information: the name beside it is what identifies the row, and the
 * bars stay one hue precisely so that colour is not carrying meaning it cannot carry
 * reliably.
 */
export function markColour(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 45% 55%)`;
}
