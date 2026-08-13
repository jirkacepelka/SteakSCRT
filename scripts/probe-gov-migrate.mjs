#!/usr/bin/env node
/**
 * Can Secret Network's governance control a contract through the *admin* role?
 *
 * A companion to `probe-gov-execute.mjs`, which established that governance cannot call
 * `MsgExecuteContract` against a secret contract: the enclave parses the signed
 * transaction carrying the encrypted input, and a message dispatched by the gov module in
 * EndBlocker has no such transaction. That failure closed the obvious route.
 *
 * The admin role is a different route and worth measuring separately, because the two
 * messages behave differently:
 *
 *   `MsgUpdateAdmin` carries no encrypted payload at all. If governance can send it, the
 *   network can at least decide *who* may upgrade.
 *
 *   `MsgMigrateContract` does carry an encrypted `MigrateMsg`, so it may well fail for the
 *   same reason execute did. If it succeeds, the network controls the code itself, and
 *   everything outside the manager's remit can be governed by shipping a new version.
 *
 * The answer decides how much of the protocol the chain can actually govern, so it is
 * measured rather than assumed.
 *
 * Run against a running devnet:
 *   node scripts/devnet.mjs up && node scripts/probe-gov-migrate.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { SecretNetworkClient, Wallet } from "secretjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "secret-lst-devnet";
const CHAIN_ID = "secretdev-1";
const LCD = "http://localhost:1317";

const VALIDATOR_MNEMONIC =
  "push certain add next grape invite tobacco bubble text romance again lava crater pill genius vital fresh guard great patch knee series era tonight";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const secretd = (args) =>
  execFileSync("docker", ["exec", "-i", CONTAINER, "secretd", ...args], {
    encoding: "utf8",
  });

/** The chain's record for a contract. Fields sit under `contract_info`, not at the root. */
function contractInfo(address) {
  return JSON.parse(
    secretd(["query", "compute", "contract", address, "--output", "json"]),
  ).contract_info;
}

/** Submit a proposal, vote it through, and report what the chain did with it. */
async function runProposal(title, messages) {
  const proposal = {
    messages,
    metadata: "probe",
    deposit: "1000000000uscrt",
    title,
    summary: title,
  };

  execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "sh", "-c", "cat > /tmp/proposal.json"],
    { input: JSON.stringify(proposal) },
  );

  const submit = JSON.parse(
    secretd([
      "tx", "gov", "submit-proposal", "/tmp/proposal.json",
      "--from", "validator", "--chain-id", CHAIN_ID,
      "--keyring-backend", "test", "--gas", "700000",
      "--gas-prices", "0.25uscrt", "--output", "json", "-y",
    ]),
  );
  if (submit.code !== 0) {
    return { outcome: "rejected at submission", detail: submit.raw_log };
  }

  await sleep(6_000);
  const all = JSON.parse(
    secretd(["query", "gov", "proposals", "--output", "json"]),
  ).proposals;
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
    const p = JSON.parse(
      secretd(["query", "gov", "proposal", id, "--output", "json"]),
    ).proposal;

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
  const wallet = new Wallet(VALIDATOR_MNEMONIC);
  const client = new SecretNetworkClient({
    chainId: CHAIN_ID,
    url: LCD,
    wallet,
    walletAddress: wallet.address,
  });

  const govAddress = JSON.parse(
    secretd(["query", "auth", "module-account", "gov", "--output", "json"]),
  ).account.value.address;
  console.log(`Gov module account: ${govAddress}`);

  const validators = JSON.parse(
    secretd(["query", "staking", "validators", "--output", "json"]),
  ).validators.map((v) => v.operator_address);

  const wasm = readFileSync(join(ROOT, "artifacts", "lst_core.wasm.gz"));

  console.log("Uploading lst-core twice (a migration needs a target code id) ...");
  const codeIds = [];
  for (let i = 0; i < 2; i++) {
    const up = await client.tx.compute.storeCode(
      { sender: wallet.address, wasm_byte_code: wasm, source: "", builder: "" },
      { gasLimit: 5_000_000 },
    );
    if (up.code !== 0) throw new Error(`upload failed: ${up.rawLog}`);
    codeIds.push(Number(up.arrayLog.find((l) => l.key === "code_id").value));
  }
  const [codeId, targetCodeId] = codeIds;
  const { code_hash: codeHash } = await client.query.compute.codeHashByCodeId({
    code_id: String(codeId),
  });
  const { code_hash: targetHash } = await client.query.compute.codeHashByCodeId({
    code_id: String(targetCodeId),
  });
  console.log(`  code ids ${codeId} and ${targetCodeId}`);

  const DAY = 86_400;
  console.log("Instantiating with governance as the contract admin ...");
  const init = await client.tx.compute.instantiateContract(
    {
      sender: wallet.address,
      // The whole question: can this address exercise the admin role?
      admin: govAddress,
      code_id: codeId,
      code_hash: codeHash,
      label: `lst-core-migrate-probe-${Date.now()}`,
      init_msg: {
        owner: wallet.address,
        manager: wallet.address,
        limits: {
          max_performance_fee_bps: 1000,
          max_validator_weight_bps: 2500,
        },
        validator_allowlist: validators.slice(0, 4),
        treasury: wallet.address,
        bonded_denom: "uscrt",
        validators: validators.slice(0, 4).map((address) => ({
          address,
          weight_bps: 2500,
        })),
        params: {
          unbond_window_secs: 5 * DAY,
          unbonding_period_secs: 90,
          performance_fee_bps: 800,
          withdrawal_fee_bps: 0,
          min_deposit: "1000000",
          sync_stale_after_secs: 7200,
          max_unbond_entries_per_validator: 6,
        },
        prng_seed: Buffer.from("probe").toString("base64"),
      },
    },
    { gasLimit: 1_500_000 },
  );
  if (init.code !== 0) throw new Error(`instantiate failed: ${init.rawLog}`);

  const contract = init.arrayLog.find((l) => l.key === "contract_address").value;
  console.log(`  contract ${contract}`);

  console.log(`  admin recorded on chain: ${contractInfo(contract).admin ?? "(none)"}`);

  // ---- 1. migration, which carries an encrypted MigrateMsg ----
  console.log("\n1. MsgMigrateContract from governance");
  const encrypted = await client.encryptionUtils.encrypt(targetHash, {
    noop: {},
  });
  const migrate = await runProposal("Probe: governance migrates the contract", [
    {
      "@type": "/secret.compute.v1beta1.MsgMigrateContract",
      sender: govAddress,
      contract,
      code_id: String(targetCodeId),
      msg: Buffer.from(encrypted).toString("base64"),
    },
  ]);
  console.log(`   -> ${migrate.outcome}${migrate.detail ? `: ${migrate.detail}` : ""}`);

  // ---- 2. changing the admin, which carries no encrypted payload ----
  console.log("\n2. MsgUpdateAdmin from governance");
  const update = await runProposal("Probe: governance hands the admin role on", [
    {
      "@type": "/secret.compute.v1beta1.MsgUpdateAdmin",
      sender: govAddress,
      new_admin: wallet.address,
      contract,
    },
  ]);
  console.log(`   -> ${update.outcome}${update.detail ? `: ${update.detail}` : ""}`);

  // Ground truth rather than proposal status.
  const after = JSON.parse(
    secretd(["query", "compute", "contract", contract, "--output", "json"]),
  );
  console.log("\n---- ground truth ----");
  console.log(`code id now:  ${after.code_id} (was ${codeId}, migration target ${targetCodeId})`);
  console.log(`admin now:    ${after.admin ?? "(none)"}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
