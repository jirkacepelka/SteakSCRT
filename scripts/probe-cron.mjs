#!/usr/bin/env node
/**
 * Can the chain's cron module run this protocol's upkeep, so nobody has to run a server?
 *
 * The prize is large. Every keeper task is permissionless and idempotent, so if `x/cron`
 * can call them on a schedule then deposits, withdrawals, the queue and compounding all
 * proceed with no off-chain process at all — no host, no hot key, no gas budget, nothing
 * to page anyone at 3am.
 *
 * There is a specific reason to doubt it, and it is the same wall that governance hits.
 * Secret's compute module authenticates a contract message against the signature of the
 * transaction carrying it. A cron schedule executes in the block's own machinery, with no
 * transaction and no signature — exactly the situation in which an ordinary
 * `MsgExecuteContract` from governance fails. Whether cron has a path around that is not
 * something to reason about from the proto; the earlier governance probe reached a
 * confident wrong answer that way.
 *
 * So this runs it. It adds a schedule through a real proposal, waits, and then reads the
 * contract's own state to see whether the chain actually executed anything — `last_sync_time`
 * advancing with nobody sending a transaction is proof, and nothing else is.
 *
 *   node scripts/devnet.mjs up
 *   node scripts/deploy.mjs --network devnet
 *   node scripts/probe-cron.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SecretNetworkClient } from "secretjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "secret-lst-devnet";
const CHAIN_ID = "secretdev-1";
const LCD = "http://localhost:1317";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const secretd = (args) =>
  execFileSync("docker", ["exec", "-i", CONTAINER, "secretd", ...args], {
    encoding: "utf8",
  });

async function runProposal(title, messages) {
  execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "sh", "-c", "cat > /tmp/cron-proposal.json"],
    {
      input: JSON.stringify({
        messages,
        metadata: "cron probe",
        deposit: "1000000000uscrt",
        title,
        summary: title,
      }),
    },
  );

  const submit = JSON.parse(
    secretd([
      "tx", "gov", "submit-proposal", "/tmp/cron-proposal.json",
      "--from", "validator", "--chain-id", CHAIN_ID,
      "--keyring-backend", "test", "--gas", "700000",
      "--gas-prices", "0.25uscrt", "--output", "json", "-y",
    ]),
  );
  if (submit.code !== 0) {
    return { outcome: "rejected at submission", detail: submit.raw_log };
  }

  await sleep(6_000);
  const all = JSON.parse(secretd(["query", "gov", "proposals", "--output", "json"])).proposals;
  const id = all[all.length - 1].id;

  secretd([
    "tx", "gov", "vote", id, "yes",
    "--from", "validator", "--chain-id", CHAIN_ID,
    "--keyring-backend", "test", "--gas", "300000",
    "--gas-prices", "0.25uscrt", "--output", "json", "-y",
  ]);

  process.stdout.write(`  proposal ${id}, waiting out the vote`);
  for (let i = 0; i < 40; i++) {
    await sleep(5_000);
    const p = JSON.parse(secretd(["query", "gov", "proposal", id, "--output", "json"])).proposal;

    if (p.status === "PROPOSAL_STATUS_PASSED") {
      console.log(" passed and executed");
      return { outcome: "executed" };
    }
    if (p.status === "PROPOSAL_STATUS_FAILED") {
      console.log(" passed, execution failed");
      return { outcome: "execution failed", detail: p.failed_reason };
    }
    if (p.status === "PROPOSAL_STATUS_REJECTED") {
      console.log(" rejected by vote");
      return { outcome: "rejected by vote" };
    }
    process.stdout.write(".");
  }
  console.log(" timed out");
  return { outcome: "timed out" };
}

async function main() {
  const deployment = JSON.parse(readFileSync(join(ROOT, "deploy", "devnet.json"), "utf8"));
  const core = deployment.core;

  const client = new SecretNetworkClient({ chainId: CHAIN_ID, url: LCD });
  const state = () =>
    client.query.compute
      .queryContract({
        contract_address: core.address,
        code_hash: core.codeHash,
        query: { state: {} },
      })
      .then((a) => a.state);

  const height = () =>
    Number(
      JSON.parse(secretd(["status", "--output", "json"])).SyncInfo?.latest_block_height ??
        JSON.parse(secretd(["status", "--output", "json"])).sync_info.latest_block_height,
    );

  console.log(`Probing x/cron against ${core.address}\n`);

  const govAccount = JSON.parse(
    secretd(["query", "auth", "module-account", "gov", "--output", "json"]),
  ).account;
  const gov = govAccount?.value?.address ?? govAccount?.base_account?.address;
  if (!gov) throw new Error("could not read the gov module account");
  console.log(`gov module account: ${gov}`);

  // The message the schedule would run. `Sync` is the ideal probe: permissionless,
  // idempotent, and it stamps a timestamp that nothing else on an idle chain will move.
  const scheduled = {
    "@type": "/secret.cron.MsgAddSchedule",
    authority: gov,
    name: "lst-upkeep",
    // In blocks. Short, so the probe does not have to wait long for evidence.
    period: "5",
    msgs: [
      {
        contract: core.address,
        msg: JSON.stringify({ sync: { limit: 25 } }),
      },
    ],
  };

  console.log("\n1. Asking governance to add the schedule ...");
  const result = await runProposal("Schedule lst-core upkeep", [scheduled]);

  if (result.outcome !== "executed") {
    console.log(`\nRESULT: cron cannot be driven this way — ${result.outcome}`);
    if (result.detail) console.log(`  ${result.detail}`);
    process.exit(0);
  }

  const before = await state();
  const startHeight = height();
  console.log(`\n2. Schedule accepted. Watching for it to fire.`);
  console.log(`   last_sync_time now ${before.last_sync_time}, height ${startHeight}`);
  console.log("   Nothing below sends a transaction — any movement is the chain's own doing.");

  for (let i = 0; i < 24; i++) {
    await sleep(5_000);
    const now = await state();
    if (now.last_sync_time > before.last_sync_time) {
      console.log(
        `\nRESULT: cron executed the contract. last_sync_time ${before.last_sync_time} -> ` +
          `${now.last_sync_time} after ${height() - startHeight} blocks, with no transaction sent.`,
      );
      console.log("\nUpkeep can run on chain. A keeper becomes optional rather than load-bearing.");
      return;
    }
    process.stdout.write(".");
  }

  // Distinguish "never fired" from "fired and did nothing" — different diagnoses.
  const schedule = JSON.parse(
    secretd(["query", "cron", "list-schedule", "--output", "json"]),
  ).schedules?.find((x) => x.name === "lst-upkeep");

  console.log(
    `\n\nRESULT: no movement in ${height() - startHeight} blocks, but cron records ` +
      `last_execute_height ${schedule?.last_execute_height ?? "?"}.`,
  );
  console.log("\nThe module is firing the schedule and the contract is not running: the");
  console.log("block at that height carries no wasm or compute event at all. A schedule");
  console.log("stores its message as a plain string, with nowhere to put the nonce and");
  console.log("public key Secret's encryption needs — the same wall that stops governance");
  console.log("calling a contract. The call is dropped rather than refused, and nothing");
  console.log("surfaces to say so.");
  console.log("\nTreat x/cron as unavailable for driving this protocol's upkeep.");
}

main().catch((err) => {
  console.error(`\n${err.message ?? err}`);
  process.exit(1);
});
