#!/usr/bin/env node
/**
 * Can Secret Network's chain governance control code upgrades of this protocol?
 *
 * The naive routes do not work, and an earlier version of this probe stopped there and
 * concluded — wrongly — that the chain cannot govern a contract at all. Two things were
 * wrong with that: it ran against LocalSecret v1.15.0, and it used the ordinary
 * `MsgMigrateContract`.
 *
 * v1.21.6 added a purpose-built path. A contract admin calls `set-contract-governance`,
 * a **one-way** switch after which upgrades require a governance vote, and the vote
 * carries `MsgContractGovernanceProposal` rather than a normal migrate message.
 *
 * The reason that one can work where the others cannot is visible in the proto:
 *
 *   message MigrateContractInfo { string address = 1; uint64 new_code_id = 2; }
 *
 * There is no `msg` field. Nothing is encrypted, so there is no ciphertext needing to be
 * bound to a transaction signature — which is exactly what fails when governance
 * dispatches an ordinary compute message from EndBlocker.
 *
 * This probe runs the real flow end to end and checks the chain's own record of the
 * contract afterwards.
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
  execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "sh", "-c", "cat > /tmp/proposal.json"],
    {
      input: JSON.stringify({
        messages,
        metadata: "probe",
        deposit: "1000000000uscrt",
        title,
        summary: title,
      }),
    },
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
  const validators = JSON.parse(
    secretd(["query", "staking", "validators", "--output", "json"]),
  ).validators.map((v) => v.operator_address);

  console.log(`Node version: ${secretd(["version"]).trim()}`);
  console.log(`Gov module account: ${govAddress}`);

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
  console.log(`  code ids ${codeId} and ${targetCodeId}`);

  const DAY = 86_400;
  console.log("Instantiating, admin = deployer for now ...");
  const init = await client.tx.compute.instantiateContract(
    {
      sender: wallet.address,
      admin: wallet.address,
      code_id: codeId,
      code_hash: codeHash,
      label: `lst-core-govmigrate-${Date.now()}`,
      init_msg: {
        manager: wallet.address,
        limits: { max_performance_fee_bps: 1000, max_validator_weight_bps: 2500 },
        validator_allowlist: validators.slice(0, 4),
        treasury: wallet.address,
        bonded_denom: "uscrt",
        validators: validators
          .slice(0, 4)
          .map((address) => ({ address, weight_bps: 2500 })),
        params: {
          unbond_window_secs: 5 * DAY,
          unbonding_period_secs: 90,
          performance_fee_bps: 800,
          withdrawal_fee_bps: 0,
          min_deposit: "1000000",
          sync_stale_after_secs: 7200,
          max_unbond_entries_per_validator: 6,
        },
      },
    },
    { gasLimit: 1_500_000 },
  );
  if (init.code !== 0) throw new Error(`instantiate failed: ${init.rawLog}`);
  const contract = init.arrayLog.find((l) => l.key === "contract_address").value;
  console.log(`  contract ${contract}`);

  // ---- hand code upgrades to the network, irreversibly ----
  console.log("\nCalling set-contract-governance (one-way) ...");
  const handover = JSON.parse(
    secretd([
      "tx", "compute", "set-contract-governance", contract,
      "--from", "validator", "--chain-id", CHAIN_ID,
      "--keyring-backend", "test", "--gas", "300000",
      "--gas-prices", "0.25uscrt", "--output", "json", "-y",
    ]),
  );
  if (handover.code !== 0) {
    console.error(`  failed: ${handover.raw_log}`);
    process.exit(1);
  }
  await sleep(6_000);
  console.log(`  contract info now: ${JSON.stringify(contractInfo(contract))}`);

  // ---- the actual question ----
  console.log("\nGovernance proposal to migrate the contract");
  const result = await runProposal("Probe: governance migrates the contract", [
    {
      "@type": "/secret.compute.v1beta1.MsgContractGovernanceProposal",
      authority: govAddress,
      title: "Migrate lst-core",
      description: "Probe",
      contracts: [{ address: contract, new_code_id: String(targetCodeId) }],
      admin_updates: [],
    },
  ]);
  console.log(`  -> ${result.outcome}${result.detail ? `: ${result.detail}` : ""}`);

  // The proposal only *authorises* the upgrade. Someone still has to submit the migrate
  // transaction — which is the whole reason the next two checks matter.
  const migrate = (toCodeId) =>
    JSON.parse(
      secretd([
        "tx", "compute", "migrate", contract, String(toCodeId), "{}",
        "--from", "validator", "--chain-id", CHAIN_ID,
        "--keyring-backend", "test", "--gas", "900000",
        "--gas-prices", "0.25uscrt", "--output", "json", "-y",
      ]),
    ).txhash;

  const txResult = (hash) =>
    JSON.parse(secretd(["query", "tx", hash, "--output", "json"]));

  console.log("\nSubmitting the approved migration ...");
  const approvedTx = migrate(targetCodeId);
  await sleep(8_000);
  const approved = txResult(approvedTx);
  console.log(`  code ${approved.code}${approved.code ? `: ${approved.raw_log}` : " (accepted)"}`);

  // The negative control, and the more important of the two. If an admin could migrate
  // without a matching proposal, the governance gate would be decoration.
  console.log("\nControl: migrating back with no proposal behind it ...");
  const refusedTx = migrate(codeId);
  await sleep(8_000);
  const refused = txResult(refusedTx);
  console.log(`  code ${refused.code}: ${refused.raw_log}`);

  const after = contractInfo(contract);
  console.log("\n---- ground truth ----");
  console.log(`code id: ${after.code_id} (was ${codeId}, approved target ${targetCodeId})`);

  const upgraded = Number(after.code_id) === targetCodeId;
  const gateHeld = refused.code !== 0;

  if (upgraded && gateHeld) {
    console.log(
      "\nRESULT: the network gates upgrades. The approved migration went through, the\n" +
        "unapproved one was refused. The admin key is a relay, not an authority.",
    );
  } else if (upgraded) {
    console.log(
      "\nRESULT: the migration worked, but an unapproved one ALSO worked — the gate is\n" +
        "not holding. Do not rely on it.",
    );
  } else {
    console.log("\nRESULT: the approved migration did not take effect.");
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
