#!/usr/bin/env node
/**
 * Upkeep loop for the SCRT liquid staking protocol.
 *
 * Three jobs on independent schedules, plus a health check on every pass:
 *
 *   sync            keeps cached totals fresh, which is what lets users transact at all
 *   compound        harvests rewards, takes the protocol's cut, restakes the remainder
 *   window upkeep   closes a window when its time comes, collects matured ones
 *
 * None of it is privileged. Anyone can run this, and if nobody does, the protocol does not
 * lose money — it stops accepting deposits once the cache goes stale, and yield stops
 * compounding. That is the failure mode a keeper exists to avoid, and it is deliberately
 * an inconvenience rather than a loss.
 */

import { Keeper } from "./client.ts";
import { loadConfig, type KeeperConfig } from "./config.ts";
import { runChecks, type Finding, type Memory } from "./invariants.ts";
import { advanceWindow, collectMatured, compound, sync, type TaskOutcome } from "./tasks.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(level: "info" | "warn" | "error", message: string, extra?: object) {
  // One JSON object per line: greppable by a human, ingestible by anything else.
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, message, ...extra })}\n`,
  );
}

function report(findings: Finding[]) {
  for (const f of findings) {
    if (f.severity === "ok") {
      log("info", f.check, { detail: f.detail });
    } else {
      log(f.severity === "alert" ? "error" : "warn", f.check, { detail: f.detail });
    }
  }
}

function logOutcome(outcome: TaskOutcome) {
  log(outcome.did === "work" ? "info" : "info", outcome.task, {
    did: outcome.did,
    detail: outcome.detail,
  });
}

/**
 * Whether a job is due.
 *
 * Deliberately not a cron: the keeper may be restarted at any time, and a schedule that
 * depends on wall-clock alignment would either double up or skip a slot on every restart.
 * Elapsed time since the last successful run is restart-safe.
 */
class Schedule {
  private lastRun = 0;
  private readonly intervalMs: number;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  due(now: number): boolean {
    return now - this.lastRun >= this.intervalMs;
  }

  mark(now: number) {
    this.lastRun = now;
  }
}

async function pass(keeper: Keeper, config: KeeperConfig, memory: Memory, schedules: {
  sync: Schedule;
  compound: Schedule;
  window: Schedule;
}) {
  const now = Date.now();

  // Health first: if the cache is stale the sync schedule is beside the point, and if the
  // exchange rate just fell an operator wants to know before anything else happens.
  const findings = await runChecks(keeper, memory, /* entryCeiling */ 6);
  report(findings);

  if (config.checkOnly) return;

  const stale = findings.some((f) => f.check === "freshness" && f.severity !== "ok");
  if (stale || schedules.sync.due(now)) {
    logOutcome(await sync(keeper, config));
    schedules.sync.mark(now);
  }

  if (schedules.window.due(now)) {
    logOutcome(await advanceWindow(keeper));
    logOutcome(await collectMatured(keeper, config));
    schedules.window.mark(now);
  }

  if (schedules.compound.due(now)) {
    logOutcome(await compound(keeper, config));
    schedules.compound.mark(now);
    // Compounding rewrites the totals, so the next sync can wait a full interval.
    schedules.sync.mark(now);
  }
}

async function main() {
  const config = loadConfig();
  const keeper = new Keeper(config);

  log("info", "keeper starting", {
    address: keeper.address,
    contract: config.contract,
    chain: config.chainId,
    mode: config.checkOnly ? "check-only" : config.once ? "single pass" : "loop",
  });

  const memory: Memory = {};
  const schedules = {
    sync: new Schedule(config.syncIntervalMs),
    compound: new Schedule(config.compoundIntervalMs),
    window: new Schedule(config.windowIntervalMs),
  };

  if (config.once || config.checkOnly) {
    await pass(keeper, config, memory, schedules);
    return;
  }

  // The loop never exits on error. A keeper that dies on a transient RPC failure is worse
  // than one that logs it and tries again in a minute, because the failure it is meant to
  // prevent is precisely "nobody ran the upkeep".
  for (;;) {
    try {
      await pass(keeper, config, memory, schedules);
    } catch (e) {
      log("error", "pass failed", {
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    await sleep(60_000);
  }
}

main().catch((e) => {
  log("error", "fatal", { detail: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
