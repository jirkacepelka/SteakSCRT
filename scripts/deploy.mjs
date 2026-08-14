#!/usr/bin/env node
/**
 * Deploy the protocol.
 *
 * The ordering here is not arbitrary. Each step disposes of a power the previous step
 * created, and doing them out of order leaves a key holding something it should not:
 *
 *   1. upload both binaries
 *   2. instantiate the token, admin = deployer, minter = deployer
 *   3. instantiate lst-core
 *   4. token.SetMinters([lst-core])   — replaces the list, so the deploy key stops being
 *                                       a minter in the same call
 *   5. token.ChangeAdmin(lst-core)    — lst-core has no code path that sends token admin
 *                                       messages, so the minter set and the halt switch
 *                                       become permanently unreachable
 *   6. core.Bootstrap(token) + seed   — consumes the deployer's one-shot right
 *   7. set-contract-governance        — one-way; from here upgrades need a vote
 *
 * After step 7 the deploy key holds nothing at all.
 *
 * Usage:
 *   node scripts/deploy.mjs --network devnet
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { SecretNetworkClient, Wallet } from "secretjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86_400;

const NETWORKS = {
  devnet: {
    chainId: "secretdev-1",
    url: "http://localhost:1317",
    container: "secret-lst-devnet",
    // LocalSecret ships a 90-second unbonding period, which is the only reason the
    // withdrawal path is testable in a single sitting.
    unbondingPeriodSecs: 90,
    unbondWindowSecs: 120,
    // Public LocalSecret genesis key. Not a secret, and useless off the local chain.
    mnemonic:
      "push certain add next grape invite tobacco bubble text romance again lava crater pill genius vital fresh guard great patch knee series era tonight",
  },
  "pulsar-3": {
    chainId: "pulsar-3",
    url: "https://pulsar.lcd.secretnodes.com",
    container: null,
    unbondingPeriodSecs: 21 * DAY,
    unbondWindowSecs: 5 * DAY,
    mnemonic: process.env.DEPLOY_MNEMONIC,
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return { name, network, govHandover: argv.includes("--hand-to-governance") };
}

async function upload(client, wallet, file) {
  const wasm = readFileSync(join(ROOT, "artifacts", file));
  const tx = await client.tx.compute.storeCode(
    { sender: wallet.address, wasm_byte_code: wasm, source: "", builder: "" },
    { gasLimit: 5_000_000 },
  );
  if (tx.code !== 0) throw new Error(`upload of ${file} failed: ${tx.rawLog}`);

  const codeId = Number(tx.arrayLog.find((l) => l.key === "code_id").value);
  const { code_hash: codeHash } = await client.query.compute.codeHashByCodeId({
    code_id: String(codeId),
  });
  console.log(`  ${file}: code ${codeId}`);
  return { codeId, codeHash };
}

async function exec(client, contract, codeHash, msg, label, funds = []) {
  const tx = await client.tx.compute.executeContract(
    {
      sender: client.address,
      contract_address: contract,
      code_hash: codeHash,
      msg,
      sent_funds: funds,
    },
    { gasLimit: 1_500_000 },
  );
  if (tx.code !== 0) throw new Error(`${label} failed: ${tx.rawLog}`);
  console.log(`  ${label}`);
  return tx;
}

/**
 * Choose the validator set.
 *
 * On the devnet, whatever `devnet.mjs` created. Elsewhere, read the bonded set from the
 * chain and take the ones with the lowest commission, skipping any that are jailed.
 *
 * `VALIDATORS` overrides all of it, because a real launch should name its validators
 * deliberately rather than let a script pick them: this protocol decides where a
 * meaningful share of a chain's stake goes, and that is a governance decision, not a
 * sorting function.
 */
async function pickValidators(client, network) {
  if (process.env.VALIDATORS) {
    const named = JSON.parse(process.env.VALIDATORS);
    if (named.length < 4) {
      throw new Error(`VALIDATORS must name at least 4, got ${named.length}.`);
    }
    return named.slice(0, 4);
  }

  if (network.container) {
    const all = JSON.parse(
      execFileSync(
        "docker",
        ["exec", "-i", network.container, "secretd", "query", "staking", "validators", "--output", "json"],
        { encoding: "utf8" },
      ),
    ).validators.map((v) => v.operator_address);
    if (all.length < 4) throw new Error(`Devnet has ${all.length} validators, need 4.`);
    return all.slice(0, 4);
  }

  const { validators } = await client.query.staking.validators({
    status: "BOND_STATUS_BONDED",
    pagination: { limit: "300" },
  });

  const usable = (validators ?? [])
    .filter((v) => !v.jailed)
    .map((v) => ({
      address: v.operator_address,
      commission: Number(v.commission?.commission_rates?.rate ?? "1"),
    }))
    .sort((a, b) => a.commission - b.commission);

  if (usable.length < 4) {
    throw new Error(
      `Only ${usable.length} bonded validators available; set VALIDATORS explicitly.`,
    );
  }

  console.warn(
    [
      "",
      "   No VALIDATORS given — picking the four lowest-commission bonded validators.",
      "   Fine for a testnet. For mainnet, name them deliberately.",
    ].join("\n"),
  );
  return usable.slice(0, 4).map((v) => v.address);
}

async function main() {
  const { name, network, govHandover } = parseArgs();
  const wallet = new Wallet(network.mnemonic);
  const client = new SecretNetworkClient({
    chainId: network.chainId,
    url: network.url,
    wallet,
    walletAddress: wallet.address,
  });

  console.log(`Deploying to ${name} as ${wallet.address}\n`);

  console.log("1. Uploading ...");
  const core = await upload(client, wallet, "lst_core.wasm.gz");
  const token = await upload(client, wallet, "snip20_reference_impl.wasm.gz");

  const chosen = await pickValidators(client, network);
  console.log(`\n   Validators: ${chosen.length} chosen`);
  for (const v of chosen) console.log(`     ${v}`);

  console.log("\n2. Instantiating dSCRT ...");
  const tokenInit = await client.tx.compute.instantiateContract(
    {
      sender: wallet.address,
      admin: wallet.address,
      code_id: token.codeId,
      code_hash: token.codeHash,
      label: `dSCRT-${Date.now()}`,
      init_msg: {
        name: "Staked SCRT",
        symbol: "DSCRT",
        decimals: 6,
        admin: wallet.address,
        prng_seed: Buffer.from(`dscrt-${Date.now()}`).toString("base64"),
        config: {
          // The exchange rate is meaningless without it, and DEXes need it.
          public_total_supply: true,
          enable_mint: true,
          enable_burn: true,
          enable_deposit: false,
          enable_redeem: false,
        },
      },
    },
    { gasLimit: 2_000_000 },
  );
  if (tokenInit.code !== 0) throw new Error(`token instantiate failed: ${tokenInit.rawLog}`);
  const tokenAddress = tokenInit.arrayLog.find((l) => l.key === "contract_address").value;
  console.log(`  ${tokenAddress}`);

  console.log("\n3. Instantiating lst-core ...");
  const coreInit = await client.tx.compute.instantiateContract(
    {
      sender: wallet.address,
      admin: wallet.address,
      code_id: core.codeId,
      code_hash: core.codeHash,
      label: `lst-core-${Date.now()}`,
      init_msg: {
        manager: wallet.address,
        limits: { max_performance_fee_bps: 1_000, max_validator_weight_bps: 2_500 },
        validator_allowlist: chosen,
        treasury: wallet.address,
        bonded_denom: "uscrt",
        validators: chosen.map((address) => ({ address, weight_bps: 2_500 })),
        params: {
          unbond_window_secs: network.unbondWindowSecs,
          unbonding_period_secs: network.unbondingPeriodSecs,
          performance_fee_bps: 800,
          withdrawal_fee_bps: 0,
          min_deposit: "1000000",
          sync_stale_after_secs: 7_200,
          max_unbond_entries_per_validator: 6,
        },
        prng_seed: Buffer.from(`core-${Date.now()}`).toString("base64"),
      },
    },
    { gasLimit: 2_000_000 },
  );
  if (coreInit.code !== 0) throw new Error(`core instantiate failed: ${coreInit.rawLog}`);
  const coreAddress = coreInit.arrayLog.find((l) => l.key === "contract_address").value;
  console.log(`  ${coreAddress}`);

  console.log("\n4. Handing minting to lst-core ...");
  // SetMinters replaces the list wholesale: lst-core becomes the only minter and the
  // deploy key stops being one, in a single call. Adding without removing would leave a
  // mint-anything backdoor behind.
  await exec(
    client,
    tokenAddress,
    token.codeHash,
    { set_minters: { minters: [coreAddress] } },
    "minters = [lst-core]",
  );

  console.log("\n5. Disposing of the token admin ...");
  // lst-core sends no token admin messages, so pointing the admin at it makes the minter
  // set and the halt switch permanently unreachable.
  await exec(
    client,
    tokenAddress,
    token.codeHash,
    { change_admin: { address: coreAddress } },
    "token admin = lst-core (inert)",
  );

  console.log("\n6. Seeding the pool ...");
  await exec(
    client,
    coreAddress,
    core.codeHash,
    { bootstrap: { token_address: tokenAddress, token_code_hash: token.codeHash } },
    "bootstrapped, deployer's one-shot right consumed",
    [{ denom: "uscrt", amount: "10000000" }],
  );

  if (govHandover) {
    if (!network.container) {
      throw new Error("--hand-to-governance currently drives secretd through the devnet container");
    }
    console.log("\n7. Handing upgrades to governance (one-way) ...");
    execFileSync(
      "docker",
      [
        "exec", "-i", network.container, "secretd",
        "tx", "compute", "set-contract-governance", coreAddress,
        "--from", "validator", "--chain-id", network.chainId,
        "--keyring-backend", "test", "--gas", "300000",
        "--gas-prices", "0.25uscrt", "-y",
      ],
      { encoding: "utf8" },
    );
    await sleep(6_000);
    console.log("  upgrades now require a passed proposal");
  }

  const deployment = {
    network: name,
    chainId: network.chainId,
    deployedAt: new Date().toISOString(),
    core: { address: coreAddress, codeId: core.codeId, codeHash: core.codeHash },
    token: { address: tokenAddress, codeId: token.codeId, codeHash: token.codeHash },
    validators: chosen,
    governanceGated: govHandover,
  };

  mkdirSync(join(ROOT, "deploy"), { recursive: true });
  const out = join(ROOT, "deploy", `${name}.json`);
  writeFileSync(out, `${JSON.stringify(deployment, null, 2)}\n`);

  console.log(`\nWrote ${out}`);

  console.log("\n--- app/.env.local ---");
  console.log(
    [
      `NEXT_PUBLIC_CHAIN_ID=${network.chainId}`,
      `NEXT_PUBLIC_LCD_URL=${network.url}`,
      `NEXT_PUBLIC_CORE_ADDRESS=${coreAddress}`,
      `NEXT_PUBLIC_CORE_CODE_HASH=${core.codeHash}`,
      `NEXT_PUBLIC_TOKEN_ADDRESS=${tokenAddress}`,
      `NEXT_PUBLIC_TOKEN_CODE_HASH=${token.codeHash}`,
    ].join("\n"),
  );

  console.log("\n--- keeper environment ---");
  console.log(
    [
      `CHAIN_ID=${network.chainId}`,
      `LCD_URL=${network.url}`,
      `LST_CORE_ADDRESS=${coreAddress}`,
      `LST_CORE_CODE_HASH=${core.codeHash}`,
    ].join("\n"),
  );

  if (!govHandover) {
    // Worth saying out loud: until this runs, upgrades sit with whoever holds the deploy
    // key, which is the one thing this protocol's design is meant to rule out.
    console.log(
      [
        "",
        "Upgrades are still controlled by the deploy key. Handing them to the network is",
        "one-way and cannot be undone:",
        `  secretd tx compute set-contract-governance ${coreAddress} --from <admin>`,
      ].join("\n"),
    );
  }
}

main().catch((e) => {
  console.error(`\n${e.message ?? e}`);
  process.exit(1);
});
