/**
 * Chain governance, read straight from the LCD.
 *
 * The design shows a list of proposals rather than a form, which is the right emphasis:
 * what a holder wants to know first is whether anything is being decided about their money
 * right now.
 *
 * The list is filtered to proposals that would actually touch this protocol. A chain-wide
 * feed would bury the one proposal that matters under parameter changes and community-pool
 * spends, and this app has no business editorialising about those.
 */

import { DEPLOYMENT } from "./chain";
import { lcdUrl } from "./endpoint";

/** The one proposal type that can reach a Secret contract. */
const CONTRACT_GOV_MSG = "/secret.compute.v1beta1.MsgContractGovernanceProposal";

export interface ContractChange {
  address: string;
  newCodeId: string;
  /** Whether this is one of ours, or a bystander in the same proposal. */
  ours: boolean;
}

export interface Proposal {
  id: string;
  title: string;
  summary: string;
  status: string;
  /** Unix seconds, or null while the proposal is still gathering its deposit. */
  votingEnd: number | null;
  changes: ContractChange[];
  raw: unknown;
}

interface RawProposal {
  id?: string;
  proposal_id?: string;
  title?: string;
  summary?: string;
  status?: string;
  voting_end_time?: string | null;
  messages?: { "@type"?: string; contracts?: { address?: string; new_code_id?: string }[] }[];
}

const OURS = new Set([DEPLOYMENT.core.address, DEPLOYMENT.token.address].filter(Boolean));

function toSeconds(time: string | null | undefined): number | null {
  if (!time) return null;
  const ms = new Date(time).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

function shape(raw: RawProposal): Proposal {
  const changes: ContractChange[] = (raw.messages ?? [])
    .filter((m) => m["@type"] === CONTRACT_GOV_MSG)
    .flatMap((m) => m.contracts ?? [])
    .map((c) => ({
      address: c.address ?? "",
      newCodeId: c.new_code_id ?? "",
      ours: OURS.has(c.address ?? ""),
    }));

  return {
    id: raw.id ?? raw.proposal_id ?? "",
    title: raw.title || `Proposal ${raw.id ?? raw.proposal_id ?? ""}`,
    summary: raw.summary ?? "",
    status: raw.status ?? "",
    votingEnd: toSeconds(raw.voting_end_time),
    changes,
    raw,
  };
}

/**
 * Every live proposal that would migrate one of this protocol's contracts.
 *
 * Newest first, and only the ones that name a contract we deployed — including proposals
 * that bundle ours with somebody else's, which is exactly the case a holder must not miss.
 */
export async function fetchProposals(): Promise<Proposal[]> {
  const res = await fetch(
    `${lcdUrl()}/cosmos/gov/v1/proposals?pagination.limit=200&pagination.reverse=true`,
  );
  if (!res.ok) throw new Error(`Governance is not readable from this node (${res.status}).`);

  const body = (await res.json()) as { proposals?: RawProposal[] };
  return (body.proposals ?? [])
    .map(shape)
    .filter((p) => p.changes.some((c) => c.ours));
}

/** What a proposal must put up before it can be voted on, in uscrt. */
export async function fetchMinDeposit(): Promise<string | null> {
  try {
    const res = await fetch(`${lcdUrl()}/cosmos/gov/v1/params/deposit`);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      params?: { min_deposit?: { denom: string; amount: string }[] };
      deposit_params?: { min_deposit?: { denom: string; amount: string }[] };
    };
    const list = body.params?.min_deposit ?? body.deposit_params?.min_deposit ?? [];
    return list.find((c) => c.denom === "uscrt")?.amount ?? null;
  } catch {
    return null;
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case "PROPOSAL_STATUS_DEPOSIT_PERIOD":
      return "Gathering deposit";
    case "PROPOSAL_STATUS_VOTING_PERIOD":
      return "Voting";
    case "PROPOSAL_STATUS_PASSED":
      return "Passed";
    case "PROPOSAL_STATUS_REJECTED":
      return "Rejected";
    case "PROPOSAL_STATUS_FAILED":
      return "Failed";
    default:
      return status.replace("PROPOSAL_STATUS_", "").toLowerCase() || "unknown";
  }
}
