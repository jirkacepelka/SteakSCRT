/**
 * What the protocol needs doing right now.
 *
 * The same reasoning the keeper applies, in the browser. Kept apart from the screen so it
 * can be read as a statement about the protocol rather than as part of a component, and so
 * the two agree about what "due" means.
 *
 * Everything here is judged from public state. No permit, no wallet, nothing private.
 */

import type { Config, ProtocolState, UnbondWindow, UpkeepTask } from "./protocol";

export interface UpkeepItem {
  task: UpkeepTask;
  title: string;
  /** Why it is or is not due, in the words a person would use. */
  detail: string;
  due: boolean;
  /** What running it achieves — shown when it is due. */
  effect: string;
}

/** Below this, harvesting costs more gas than the rewards are worth collecting. */
const COMPOUND_FLOOR = 1_000_000; // 1 SCRT

export function assess(
  state: ProtocolState | null,
  config: Config | null,
  windows: UnbondWindow[],
  now = Math.floor(Date.now() / 1000),
): UpkeepItem[] {
  if (!state || !config) return [];

  const openWindow = windows.find((w) => w.state === "open");
  const overdue = openWindow ? now >= openWindow.closes_at : false;

  const ripe = windows.filter((w) => w.state === "unbonding" && now >= w.matures_at);

  const rewards = Number(state.pending_rewards);
  const age = now - state.last_sync_time;

  return [
    {
      task: "compound",
      title: "Harvest and restake rewards",
      due: rewards >= COMPOUND_FLOOR,
      detail:
        rewards >= COMPOUND_FLOOR
          ? `${(rewards / 1e6).toFixed(4)} SCRT of rewards are sitting at the validators.`
          : `Only ${(rewards / 1e6).toFixed(4)} SCRT accrued so far — not yet worth the gas.`,
      effect:
        "Withdraws them, takes the protocol's fee, and delegates the rest. This is what makes the exchange rate rise.",
    },
    {
      task: "advance_window",
      title: "Close the withdrawal window",
      due: overdue,
      detail: openWindow
        ? overdue
          ? `Window #${openWindow.id} passed its closing time and is holding ${(Number(openWindow.scrt_owed) / 1e6).toFixed(4)} SCRT of requests.`
          : `Window #${openWindow.id} closes in ${humanise(openWindow.closes_at - now)}.`
        : "No window is open.",
      effect:
        "Starts the unbonding clock for everyone in it. Until this runs, their three weeks have not begun.",
    },
    {
      task: "collect_matured",
      title: "Mark finished windows claimable",
      due: ripe.length > 0,
      detail:
        ripe.length > 0
          ? `${ripe.length} window${ripe.length === 1 ? " has" : "s have"} finished unbonding and the SCRT has arrived.`
          : "Nothing has finished unbonding.",
      effect:
        "Books what came back so holders can claim it. Claims do this for themselves now, so this only helps people who have not asked yet.",
    },
    {
      task: "sync",
      title: "Refresh the cached figures",
      due: state.is_unattended,
      detail: state.is_unattended
        ? `Last refreshed ${humanise(age)} ago, longer than the protocol expects.`
        : `Refreshed ${humanise(age)} ago.`,
      effect:
        "Re-reads every delegation so the published rate and validator figures are current. Deposits and withdrawals already do this for themselves.",
    },
  ];
}

function humanise(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5_400) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${Math.round(s / 3_600)} h`;
  return `${Math.round(s / 86_400)} days`;
}
