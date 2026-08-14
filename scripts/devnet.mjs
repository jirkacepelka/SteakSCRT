#!/usr/bin/env node
/**
 * LocalSecret devnet for end-to-end tests.
 *
 * Two things make this more than `docker run`:
 *
 *   Short unbonding. LocalSecret ships `unbonding_time = "90s"`, so the full
 *   deposit -> window -> undelegate -> claim cycle runs in minutes instead of the three
 *   weeks mainnet would take. That is the only reason the withdrawal path is testable
 *   at all.
 *
 *   Multiple validators. LocalSecret starts with exactly one, and almost everything
 *   interesting in this protocol — undelegation spilling across validators, per-validator
 *   entry ceilings, draining, rebalancing — is invisible with one. Extra validators are
 *   created after start-up against the pre-funded devnet accounts. They never sign a
 *   block, so `devnet/post_init.sh` disables downtime slashing to stop them being jailed
 *   out of the set mid-test.
 *
 * Everything runs through Node rather than a shell script on purpose: Git Bash on Windows
 * rewrites environment values that look like absolute paths, which silently turned
 * POST_INIT_SCRIPT=/devnet/post_init.sh into a path under the Git installation and skipped
 * the genesis patch without failing.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "secret-lst-devnet";
/**
 * Track mainnet, not whatever version happens to be lying around.
 *
 * This matters more than it looks. An earlier round of governance probes ran against
 * v1.15.0 and concluded that chain governance cannot reach a contract at all — a
 * conclusion that was true of that binary and wrong about the network, because v1.21.6
 * added governance-based contract migration and a cron module that executes CosmWasm
 * messages from a proposal. Testing an old node produced a confident, wrong answer about
 * the protocol's entire ownership model.
 */
const IMAGE = "ghcr.io/scrtlabs/localsecret:v1.24.0";
const CHAIN_ID = "secretdev-1";
const RPC = "http://localhost:26657";

/**
 * NOT SECRETS. These are the well-known test mnemonics published in SCRT Labs'
 * LocalSecret image, funded only on a throwaway local chain that exists for the length of
 * a `docker run`. They are reproduced here so the devnet is reproducible, and a secret
 * scanner flagging them is a false positive.
 *
 * Anyone putting real funds behind one of these keys would be handing them to the public.
 */
export const DEVNET_ACCOUNTS = {
  validator:
    "push certain add next grape invite tobacco bubble text romance again lava crater pill genius vital fresh guard great patch knee series era tonight",
  a: "grant rice replace explain federal release fix clever romance raise often wild taxi quarter soccer fiber love must tape steak together observe swap guitar",
  b: "jelly shadow frog dirt dragon use armed praise universe win jungle close inmate rain oil canvas beauty pioneer chef soccer icon dizzy thunder meadow",
  c: "chair love bleak wonder skirt permit say assist aunt credit roast size obtain minute throw sand usual age smart exact enough room shadow charge",
  d: "word twist toast cloth movie predict advance crumble escape whale sail such angry muffin balcony keen move employ cook valve hurt glimpse breeze brick",
};

/** Accounts that get turned into extra validators. */
const EXTRA_VALIDATOR_ACCOUNTS = ["a", "b", "c"];

const docker = (args, opts = {}) =>
  execFileSync("docker", args, { encoding: "utf8", ...opts });

const dockerQuiet = (args) =>
  spawnSync("docker", args, { encoding: "utf8" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertDockerRunning() {
  const probe = dockerQuiet(["info", "--format", "{{.ServerVersion}}"]);
  if (probe.error || probe.status !== 0) {
    console.error("Docker is not reachable. Start Docker Desktop and retry.");
    process.exit(1);
  }
}

async function waitForChain(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write("Waiting for the chain to produce blocks");

  while (Date.now() < deadline) {
    // A bad genesis patch aborts the bootstrap and the container exits. Without this
    // check the poll loop just times out minutes later and reports the wrong problem.
    const state = dockerQuiet([
      "inspect", CONTAINER, "--format", "{{.State.Status}}",
    ]).stdout.trim();

    if (state === "exited") {
      const log = dockerQuiet(["logs", "--tail", "20", CONTAINER]);
      console.error("\nThe devnet container exited during start-up:\n");
      console.error((log.stderr || log.stdout || "").trim());
      process.exit(1);
    }

    try {
      const res = await fetch(`${RPC}/status`);
      const body = await res.json();
      const height = Number(body?.result?.sync_info?.latest_block_height ?? 0);
      if (height > 0) {
        console.log(` ok (height ${height})`);
        return;
      }
    } catch {
      // Chain not up yet.
    }
    process.stdout.write(".");
    await sleep(2_000);
  }

  console.error("\nThe chain did not produce a block in time.");
  console.error(`Inspect it with: docker logs ${CONTAINER}`);
  process.exit(1);
}

/**
 * Confirm the genesis patch actually landed.
 *
 * LocalSecret prints "Custom script not found. Continuing..." and carries on when the
 * hook path is wrong, so without this check a misconfigured mount produces a devnet that
 * looks healthy and then jails the extra validators partway through a test run.
 */
function assertGenesisPatched() {
  const raw = docker([
    "exec",
    CONTAINER,
    "jq",
    "-r",
    ".app_state.slashing.params.slash_fraction_downtime",
    "/root/.secretd/config/genesis.json",
  ]).trim();

  if (Number(raw) !== 0) {
    console.error(
      [
        `Genesis was not patched: slash_fraction_downtime is ${raw}, expected 0.`,
        "",
        "devnet/post_init.sh did not run. Check that the devnet directory is mounted at",
        "/devnet inside the container and that POST_INIT_SCRIPT points at it.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log("Genesis patch confirmed (downtime slashing disabled).");
}

function secretd(args, opts = {}) {
  return docker(["exec", "-i", CONTAINER, "secretd", ...args], opts);
}

function existingValidators() {
  const out = secretd(["query", "staking", "validators", "--output", "json"]);
  return JSON.parse(out).validators ?? [];
}

/**
 * Create one validator from a pre-funded account.
 *
 * The consensus pubkey is random. These validators exist to be delegated to, never to
 * sign anything, and the chain does not care that no node holds the matching private key.
 */
function createValidator(account, index) {
  const spec = {
    pubkey: {
      "@type": "/cosmos.crypto.ed25519.PubKey",
      key: randomBytes(32).toString("base64"),
    },
    amount: "1000000000uscrt",
    moniker: `devnet-${account}`,
    "commission-rate": "0.05",
    "commission-max-rate": "0.20",
    "commission-max-change-rate": "0.01",
    "min-self-delegation": "1",
  };

  const path = `/tmp/validator-${account}.json`;
  docker(["exec", "-i", CONTAINER, "sh", "-c", `cat > ${path}`], {
    input: JSON.stringify(spec),
  });

  const out = secretd([
    "tx",
    "staking",
    "create-validator",
    path,
    "--from",
    account,
    "--chain-id",
    CHAIN_ID,
    "--keyring-backend",
    "test",
    "--gas",
    "300000",
    "--gas-prices",
    "0.25uscrt",
    "--output",
    "json",
    "-y",
  ]);

  const res = JSON.parse(out);
  if (res.code && res.code !== 0) {
    throw new Error(`create-validator for ${account} failed: ${res.raw_log}`);
  }
  console.log(`  validator ${index + 1}: devnet-${account}`);
}

async function up() {
  assertDockerRunning();

  console.log(`Removing any previous ${CONTAINER} container ...`);
  dockerQuiet(["rm", "-f", CONTAINER]);

  console.log(`Starting ${IMAGE} ...`);
  docker([
    "run",
    "-d",
    "--name",
    CONTAINER,
    "-p", "1317:1317",
    "-p", "26657:26657",
    "-p", "9091:9091",
    "-p", "5000:5000",
    "-e", "FAST_BLOCKS=true",
    "-e", "POST_INIT_SCRIPT=/devnet/post_init.sh",
    "-v", `${join(ROOT, "devnet")}:/devnet`,
    IMAGE,
  ]);

  await waitForChain();
  assertGenesisPatched();

  const before = existingValidators().length;
  if (before > 1) {
    console.log(`Validator set already has ${before} entries; skipping creation.`);
  } else {
    console.log("Creating extra validators ...");
    EXTRA_VALIDATOR_ACCOUNTS.forEach(createValidator);
    // Give the set a couple of blocks to include them.
    await sleep(3_000);
  }

  const validators = existingValidators();
  console.log("");
  console.log(`Devnet ready — ${validators.length} validators, chain id ${CHAIN_ID}`);
  console.log(`  LCD     http://localhost:1317`);
  console.log(`  RPC     ${RPC}`);
  console.log(`  faucet  http://localhost:5000`);
  console.log(`  unbonding period: 90s`);

  if (validators.length < 2) {
    console.error("");
    console.error(
      "Only one validator is active. Multi-validator behaviour cannot be tested.",
    );
    process.exit(1);
  }
}

function down() {
  assertDockerRunning();
  dockerQuiet(["rm", "-f", CONTAINER]);
  console.log(`Removed ${CONTAINER}.`);
}

function status() {
  assertDockerRunning();
  const running = dockerQuiet([
    "ps", "--filter", `name=${CONTAINER}`, "--format", "{{.Status}}",
  ]).stdout.trim();

  if (!running) {
    console.log("Devnet is not running. Start it with `npm run devnet:up`.");
    return;
  }
  console.log(`Container: ${running}`);
  for (const v of existingValidators()) {
    console.log(
      `  ${v.description.moniker.padEnd(14)} ${v.operator_address}  ${v.status}  bonded=${v.tokens}`,
    );
  }
}

const command = process.argv[2] ?? "up";
const commands = { up, down, status };

if (!commands[command]) {
  console.error(`Unknown command "${command}". Use one of: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}

await commands[command]();
