#!/usr/bin/env node
/**
 * Can Secret Network's on-chain governance execute a message against a secret contract?
 *
 * This is not a curiosity. The protocol's ownership model puts the network itself in the
 * owner role, and that only works if a passed proposal can actually reach the contract.
 *
 * The reason to doubt it: contract input on Secret is encrypted client-side against the
 * consensus IO key, and the enclave validates the transaction that carries it. A message
 * executed by the governance module is submitted inside a proposal, sits on chain through
 * the whole voting period, and is finally dispatched by the gov module account rather than
 * by a signing user. Whether the enclave accepts that is a question about Secret's
 * internals, not about Cosmos SDK, and guessing it wrong would mean designing the entire
 * governance model around something that does not work.
 *
 * The probe deploys lst-core with governance as its admin, submits a proposal calling an
 * admin-only message, votes it through, and reports what happened. Even an authorisation
 * error from the contract would be a success signal: it would prove the payload decrypted
 * and reached contract code.
 *
 * Run against a running devnet: node scripts/devnet.mjs up && node scripts/probe-gov-execute.mjs
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

async function main() {
  const wallet = new Wallet(VALIDATOR_MNEMONIC);
  const client = new SecretNetworkClient({
    chainId: CHAIN_ID,
    url: LCD,
    wallet,
    walletAddress: wallet.address,
  });

  console.log(`Deployer: ${wallet.address}`);

  // The gov module account is the "network" in this design.
  const govAddress = JSON.parse(
    secretd(["query", "auth", "module-account", "gov", "--output", "json"]),
  ).account.value.address;
  console.log(`Gov module account: ${govAddress}`);

  const validators = JSON.parse(
    secretd(["query", "staking", "validators", "--output", "json"]),
  ).validators.map((v) => v.operator_address);

  // ---- upload ----
  const wasm = readFileSync(join(ROOT, "artifacts", "lst_core.wasm.gz"));
  console.log("Uploading lst-core ...");
  const upload = await client.tx.compute.storeCode(
    { sender: wallet.address, wasm_byte_code: wasm, source: "", builder: "" },
    { gasLimit: 5_000_000 },
  );
  if (upload.code !== 0) throw new Error(`upload failed: ${upload.rawLog}`);

  const codeId = Number(
    upload.arrayLog.find((l) => l.key === "code_id").value,
  );
  const { code_hash: codeHash } =
    await client.query.compute.codeHashByCodeId({ code_id: String(codeId) });
  console.log(`  code id ${codeId}`);

  // ---- instantiate, with governance as admin ----
  const DAY = 86_400;
  const initMsg = {
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
      unbonding_period_secs: 90, // the devnet's actual unbonding time
      performance_fee_bps: 800,
      withdrawal_fee_bps: 0,
      min_deposit: "1000000",
      sync_stale_after_secs: 7200,
      max_unbond_entries_per_validator: 6,
    },
  };

  console.log("Instantiating ...");
  const init = await client.tx.compute.instantiateContract(
    {
      sender: wallet.address,
      code_id: codeId,
      code_hash: codeHash,
      init_msg: initMsg,
      label: `lst-core-probe-${Date.now()}`,
    },
    { gasLimit: 1_000_000 },
  );
  if (init.code !== 0) throw new Error(`instantiate failed: ${init.rawLog}`);

  const contractAddress = init.arrayLog.find(
    (l) => l.key === "contract_address",
  ).value;
  console.log(`  contract ${contractAddress}`);

  // ---- the actual question ----
  //
  // Encrypt the execute payload exactly as a normal transaction would, then hand the
  // ciphertext to governance and see whether the enclave still accepts it when the gov
  // module dispatches it.
  // SetPaused is callable by the owner, and the owner is governance here.
  const encrypted = await client.encryptionUtils.encrypt(codeHash, {
    set_paused: { paused: true },
  });

  const proposal = {
    messages: [
      {
        "@type": "/secret.compute.v1beta1.MsgExecuteContract",
        sender: govAddress,
        contract: contractAddress,
        msg: Buffer.from(encrypted).toString("base64"),
        sent_funds: [],
      },
    ],
    metadata: "probe",
    deposit: "1000000000uscrt",
    title: "Probe: can governance execute a secret contract",
    summary: "Pauses deposits on a throwaway contract to test the mechanism.",
  };

  execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "sh", "-c", "cat > /tmp/proposal.json"],
    { input: JSON.stringify(proposal) },
  );

  console.log("Submitting the proposal ...");
  const submit = JSON.parse(
    secretd([
      "tx", "gov", "submit-proposal", "/tmp/proposal.json",
      "--from", "validator", "--chain-id", CHAIN_ID,
      "--keyring-backend", "test", "--gas", "500000",
      "--gas-prices", "0.25uscrt", "--output", "json", "-y",
    ]),
  );
  if (submit.code !== 0) {
    console.error(`\nRESULT: the proposal was rejected at submission.`);
    console.error(submit.raw_log);
    process.exit(2);
  }

  await sleep(6_000);
  const proposals = JSON.parse(
    secretd(["query", "gov", "proposals", "--output", "json"]),
  ).proposals;
  const id = proposals[proposals.length - 1].id;
  console.log(`  proposal ${id}`);

  console.log("Voting yes ...");
  secretd([
    "tx", "gov", "vote", id, "yes",
    "--from", "validator", "--chain-id", CHAIN_ID,
    "--keyring-backend", "test", "--gas", "300000",
    "--gas-prices", "0.25uscrt", "--output", "json", "-y",
  ]);

  console.log("Waiting out the 90s voting period ...");
  for (let i = 0; i < 40; i++) {
    await sleep(5_000);
    const p = JSON.parse(
      secretd(["query", "gov", "proposal", id, "--output", "json"]),
    ).proposal;
    if (p.status === "PROPOSAL_STATUS_PASSED") {
      console.log("\nRESULT: governance executed the contract message.");
      break;
    }
    if (p.status === "PROPOSAL_STATUS_FAILED") {
      console.log("\nRESULT: the proposal passed the vote but execution FAILED.");
      console.log(`  ${p.failed_reason ?? "(no reason reported)"}`);
      break;
    }
    if (p.status === "PROPOSAL_STATUS_REJECTED") {
      console.log("\nRESULT: rejected by the vote (not a mechanism failure).");
      break;
    }
    process.stdout.write(".");
  }

  // Ground truth: did the contract's state actually change?
  const config = await client.query.compute.queryContract({
    contract_address: contractAddress,
    code_hash: codeHash,
    query: { config: {} },
  });
  console.log(`\nContract paused flag: ${JSON.stringify(config.config?.paused)}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
