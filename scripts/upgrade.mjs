#!/usr/bin/env node
/**
 * Migrate a deployed `lst-core` onto a new code version.
 *
 *   node scripts/upgrade.mjs --network devnet
 *   DEPLOY_MNEMONIC=... node scripts/upgrade.mjs --network pulsar-3
 *
 * A migration runs against a contract that already holds other people's money, and it
 * cannot be undone by migrating back — the old code cannot repair state the new code has
 * already rewritten. So this does three things rather than one:
 *
 *   It records the protocol's state before touching anything.
 *   It migrates.
 *   It reads the same state back and refuses to call the upgrade a success unless every
 *   figure that must survive did survive.
 *
 * The check is the point. `MsgMigrateContract` succeeding only means the new code's
 * `migrate` entry point returned Ok; it says nothing about whether the storage the old
 * code wrote is still readable by the new one. A layout change that silently drops the
 * validator set would report a clean migration and an empty protocol.
 *
 * Once upgrades have been handed to the network with `set-contract-governance`, this stops
 * working — by design. From then on the code id must be approved by a vote and the
 * migration relayed by the admin the proposal names.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SecretNetworkClient, Wallet } from "secretjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NETWORKS = {
  devnet: {
    chainId: "secretdev-1",
    url: "http://localhost:1317",
    // Public LocalSecret genesis key. Not a secret, and useless off the local chain.
    mnemonic:
      "push certain add next grape invite tobacco bubble text romance again lava crater pill genius vital fresh guard great patch knee series era tonight",
  },
  "pulsar-3": {
    chainId: "pulsar-3",
    url: "https://pulsar.lcd.secretnodes.com",
    mnemonic: process.env.DEPLOY_MNEMONIC,
  },
  "secret-4": {
    chainId: "secret-4",
    url: "https://lcd.mainnet.secretsaturn.net",
    mnemonic: process.env.DEPLOY_MNEMONIC,
  },
};

function parseArgs() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--network");
  const name = at === -1 ? "devnet" : argv[at + 1];
  const network = NETWORKS[name];
  if (!network) {
    throw new Error(`Unknown network "${name}". Use one of: ${Object.keys(NETWORKS).join(", ")}`);
  }
  if (!network.mnemonic) {
    throw new Error(`No mnemonic for ${name}. Set DEPLOY_MNEMONIC.`);
  }
  return { name, network, dryRun: argv.includes("--dry-run") };
}

async function upload(client, wallet) {
  const wasm = readFileSync(join(ROOT, "artifacts", "lst_core.wasm.gz"));
  const tx = await client.tx.compute.storeCode(
    { sender: wallet.address, wasm_byte_code: wasm, source: "", builder: "" },
    { gasLimit: 5_000_000 },
  );
  if (tx.code !== 0) throw new Error(`upload failed: ${tx.rawLog}`);

  const codeId = Number(tx.arrayLog.find((l) => l.key === "code_id").value);
  const { code_hash: codeHash } = await client.query.compute.codeHashByCodeId({
    code_id: String(codeId),
  });
  return { codeId, codeHash };
}

/** Everything that must read the same before and after. */
async function snapshot(client, core) {
  const query = (q) =>
    client.query.compute.queryContract({
      contract_address: core.address,
      code_hash: core.codeHash,
      query: q,
    });

  const [state, config, validators, windows] = await Promise.all([
    query({ state: {} }),
    query({ config: {} }),
    query({ validators: {} }),
    query({ windows: { state: null, start_after: null, limit: 50 } }),
  ]);

  return {
    state: state.state,
    config: config.config,
    validators: validators.validators.validators,
    windows: windows.windows.windows,
  };
}

/**
 * Compare the two snapshots.
 *
 * The exchange rate and the reward figures are expected to move — rewards accrue every
 * block, and the new code reads them live — so those are checked for direction rather than
 * equality. Everything else is an accounting fact that a migration has no business
 * changing.
 */
function verify(before, after) {
  const problems = [];
  const eq = (what, a, b) => {
    if (String(a) !== String(b)) problems.push(`${what}: ${a} -> ${b}`);
  };

  eq("total_supply", before.state.total_supply, after.state.total_supply);
  eq("scrt_owed_to_windows", before.state.scrt_owed_to_windows, after.state.scrt_owed_to_windows);
  eq("manager", before.config.manager, after.config.manager);
  eq("treasury", before.config.treasury, after.config.treasury);
  eq("paused", before.config.paused, after.config.paused);
  eq("performance_fee_bps", before.config.params.performance_fee_bps, after.config.params.performance_fee_bps);
  eq("allowlist", before.config.validator_allowlist.join(","), after.config.validator_allowlist.join(","));
  eq("validator count", before.validators.length, after.validators.length);
  eq("window count", before.windows.length, after.windows.length);

  for (const [i, w] of before.windows.entries()) {
    const now = after.windows[i];
    if (!now) {
      problems.push(`window ${w.id} disappeared`);
      continue;
    }
    eq(`window ${w.id} state`, w.state, now.state);
    eq(`window ${w.id} scrt_owed`, w.scrt_owed, now.scrt_owed);
    eq(`window ${w.id} shares_burned`, w.shares_burned, now.shares_burned);
  }

  // Bonded may only have grown, and only by rewards the new code now reads live.
  if (BigInt(after.state.total_bonded) < BigInt(before.state.total_bonded)) {
    problems.push(
      `total_bonded fell: ${before.state.total_bonded} -> ${after.state.total_bonded}`,
    );
  }
  if (BigInt(after.state.exchange_rate) < BigInt(before.state.exchange_rate)) {
    problems.push(
      `exchange rate fell: ${before.state.exchange_rate} -> ${after.state.exchange_rate}`,
    );
  }

  return problems;
}

async function main() {
  const { name, network, dryRun } = parseArgs();
  const deployment = JSON.parse(readFileSync(join(ROOT, "deploy", `${name}.json`), "utf8"));

  const wallet = new Wallet(network.mnemonic);
  const client = new SecretNetworkClient({
    chainId: network.chainId,
    url: network.url,
    wallet,
    walletAddress: wallet.address,
  });

  console.log(`Upgrading lst-core on ${name}`);
  console.log(`  contract ${deployment.core.address}`);
  console.log(`  signer   ${wallet.address}\n`);

  const info = await client.query.compute.contractInfo({
    contract_address: deployment.core.address,
  });
  const admin = info.contract_info?.admin;
  if (!admin) {
    throw new Error(
      "This contract has no admin. Upgrades belong to the network now: the code id needs a\n" +
        "governance vote and the migration is relayed by whoever the proposal names.",
    );
  }
  if (admin !== wallet.address) {
    throw new Error(`Contract admin is ${admin}, but you are signing as ${wallet.address}.`);
  }

  console.log("1. Reading the protocol as it stands ...");
  const before = await snapshot(client, deployment.core);
  console.log(
    `   supply ${before.state.total_supply}, bonded ${before.state.total_bonded}, ` +
      `${before.validators.length} validators, ${before.windows.length} windows`,
  );

  console.log("\n2. Uploading the new code ...");
  const next = await upload(client, wallet);
  console.log(`   code ${next.codeId}`);
  console.log(`   hash ${next.codeHash}`);

  if (next.codeHash === deployment.core.codeHash) {
    console.log("\n   Identical to what is already deployed. Nothing to migrate.");
    return;
  }

  if (dryRun) {
    console.log("\n--dry-run: stopping before the migration. The upload above is harmless;");
    console.log("uploaded code does nothing until a contract is pointed at it.");
    return;
  }

  console.log("\n3. Migrating ...");
  const tx = await client.tx.compute.migrateContract(
    {
      sender: wallet.address,
      contract_address: deployment.core.address,
      code_id: next.codeId,
      code_hash: next.codeHash,
      msg: {},
    },
    { gasLimit: 2_000_000 },
  );
  if (tx.code !== 0) throw new Error(`migration failed: ${tx.rawLog}`);
  console.log(`   ${tx.transactionHash}`);

  console.log("\n4. Reading it back ...");
  const after = await snapshot(client, { ...deployment.core, codeHash: next.codeHash });
  const problems = verify(before, after);

  if (problems.length > 0) {
    console.error("\nMIGRATION DAMAGED STATE:");
    for (const p of problems) console.error(`  ${p}`);
    console.error("\nDo not treat this deployment as healthy. The old code cannot repair");
    console.error("state the new code has rewritten; recovery means a fixed code version.");
    process.exit(1);
  }

  console.log("   every figure that had to survive did");
  console.log(
    `   supply ${after.state.total_supply}, bonded ${after.state.total_bonded}, ` +
      `${after.validators.length} validators, ${after.windows.length} windows`,
  );

  deployment.core.codeId = next.codeId;
  deployment.core.codeHash = next.codeHash;
  deployment.upgradedAt = new Date().toISOString();

  const { writeFileSync, existsSync, readFileSync } = await import("node:fs");
  const path = join(ROOT, "deploy", `${name}.json`);
  writeFileSync(path, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`\nWrote ${path}`);

  /*
   * Keep the local frontend in step.
   *
   * A migration changes the code hash, and the app addresses the contract by hash as well
   * as by address — so a stale value does not degrade, it stops every query dead. Printing
   * the new hash and trusting whoever ran this to copy it is precisely what went wrong the
   * first time this ran, so the local env file is rewritten here. Only when it already
   * points at this network, and never anything outside the repo.
   */
  const envPath = join(ROOT, "app", ".env.local");
  if (existsSync(envPath)) {
    const env = readFileSync(envPath, "utf8");
    if (env.includes(`NEXT_PUBLIC_CHAIN_ID=${network.chainId}`)) {
      writeFileSync(
        envPath,
        env.replace(/NEXT_PUBLIC_CORE_CODE_HASH=.*/, `NEXT_PUBLIC_CORE_CODE_HASH=${next.codeHash}`),
      );
      console.log(`Updated ${envPath}`);
    } else {
      console.log(`Left ${envPath} alone — it points at a different network.`);
    }
  }

  console.log("\nThe code hash changed. Everything that talks to this contract needs it, and");
  console.log("a stale one does not degrade — it stops every query dead:");
  console.log(`\n  NEXT_PUBLIC_CORE_CODE_HASH=${next.codeHash}`);
  console.log(`  LST_CORE_CODE_HASH=${next.codeHash}`);
  console.log("\nSet it wherever the app is hosted and redeploy — it is compiled into the");
  console.log("bundle, so saving the variable is not enough on its own. Restart the keeper.");
}

main().catch((err) => {
  console.error(`\n${err.message ?? err}`);
  process.exit(1);
});
