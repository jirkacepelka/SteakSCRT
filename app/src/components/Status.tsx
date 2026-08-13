"use client";

export type Feedback =
  | { kind: "idle" }
  | { kind: "busy"; message: string }
  | { kind: "ok"; message: string }
  | { kind: "err"; message: string };

export function Status({ feedback }: { feedback: Feedback }) {
  if (feedback.kind === "idle") return null;

  const className =
    feedback.kind === "ok"
      ? "status status--ok"
      : feedback.kind === "err"
        ? "status status--err"
        : "status status--busy";

  return <div className={className}>{feedback.message}</div>;
}

/** Chain errors arrive as long raw logs; show the part a human can act on. */
export function readable(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const known = [
    ["requires governance approval for migration", "This upgrade has not been approved by a governance vote."],
    ["cached totals are stale", "The protocol's cached totals are stale. Someone needs to run a sync before deposits and withdrawals work again."],
    ["deposits are paused", "Deposits are paused."],
    ["unauthorized", "This wallet is not permitted to do that."],
    ["is not on the allowlist", "That validator is not on the network's allowlist."],
    ["per-validator ceiling", "That weight exceeds the per-validator ceiling."],
  ] as const;

  for (const [needle, friendly] of known) {
    if (text.toLowerCase().includes(needle.toLowerCase())) return friendly;
  }
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
