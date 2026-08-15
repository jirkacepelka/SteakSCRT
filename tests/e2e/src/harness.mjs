/**
 * Devnet harness.
 *
 * Each scenario deploys its own protocol instance rather than sharing one. Sharing would
 * make the tests order-dependent — a withdrawal in one leaves a window in flight for the
 * next — and the whole reason for testing against a chain is to catch the things that
 * only appear when state is real.
 *
 * Window and unbonding periods are seconds here rather than days. LocalSecret ships a
 * 90-second unbonding period, which is the only reason the withdrawal path is testable at
 * all; against mainnet's 21 days a single scenario would take three weeks.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { SecretNetworkClient, Wallet } from "secretjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const CONTAINER = "secret-lst-devnet";
export const CHAIN_ID = "secretdev-1";
export const LCD = "http://localhost:1317";
export const DENOM = "uscrt";

/** LocalSecret's actual unbonding period. */
export const UNBONDING_SECS = 90;

/**
 * NOT SECRETS — the public LocalSecret genesis mnemonics, valid only on a throwaway local
 * chain. See scripts/devnet.mjs.
 */
export const MNEMONICS = {
  validator:
    "push certain add next grape invite tobacco bubble text romance again lava crater pill genius vital fresh guard great patch knee series era tonight",
  a: "grant rice replace explain federal release fix clever romance raise often wild taxi quarter soccer fiber love must tape steak together observe swap guitar",
  b: "jelly shadow frog dirt dragon use armed praise universe win jungle close inmate rain oil canvas beauty pioneer chef soccer icon dizzy thunder meadow",
  c: "chair love bleak wonder skirt permit say assist aunt credit roast size obtain minute throw sand usual age smart exact enough room shadow charge",
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const secretd = (args) =>
  execFileSync("docker", ["exec", "-i", CONTAINER, "secretd", ...args], {
    encoding: "utf8",
  });

export function account(mnemonic) {
  const wallet = new Wallet(mnemonic);
  const client = new SecretNetworkClient({
    chainId: CHAIN_ID,
    url: LCD,
    wallet,
    walletAddress: wallet.address,
  });
  return { wallet, client, address: wallet.address };
}

export function validators() {
  return JSON.parse(
    secretd(["query", "staking", "validators", "--output", "json"]),
  ).validators.map((v) => v.operator_address);
}

/** Store both binaries once and reuse the code ids across scenarios. */
let codeCache = null;

async function uploadOnce(deployer) {
  if (codeCache) return codeCache;

  const upload = async (file) => {
    const wasm = readFileSync(join(ROOT, "artifacts", file));
    const tx = await deployer.client.tx.compute.storeCode(
      { sender: deployer.address, wasm_byte_code: wasm, source: "", builder: "" },
      { gasLimit: 5_000_000 },
    );
    if (tx.code !== 0) throw new Error(`upload of ${file} failed: ${tx.rawLog}`);
    const codeId = Number(tx.arrayLog.find((l) => l.key === "code_id").value);
    const { code_hash: codeHash } =
      await deployer.client.query.compute.codeHashByCodeId({ code_id: String(codeId) });
    return { codeId, codeHash };
  };

  codeCache = {
    core: await upload("lst_core.wasm.gz"),
    token: await upload("snip20_reference_impl.wasm.gz"),
  };
  return codeCache;
}

/**
 * Deploy a fresh protocol, wired the way `scripts/deploy.mjs` wires production: lst-core is
 * the sole minter, the token's admin is disposed of, and the pool is seeded.
 */
export async function deployProtocol({
  windowSecs = 60,
  minDeposit = "1000000",
  performanceFeeBps = 800,
  manager,
  // Only the staleness scenario touches this. It no longer gates anything, but it still
  // decides when the protocol reports itself unattended.
  syncStaleAfterSecs = 7_200,
} = {}) {
  const deployer = account(MNEMONICS.validator);
  const code = await uploadOnce(deployer);
  const chosen = validators().slice(0, 4);

  const tokenInit = await deployer.client.tx.compute.instantiateContract(
    {
      sender: deployer.address,
      admin: deployer.address,
      code_id: code.token.codeId,
      code_hash: code.token.codeHash,
      label: `dSCRT-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      init_msg: {
        name: "Staked SCRT",
        symbol: "DSCRT",
        decimals: 6,
        admin: deployer.address,
        prng_seed: Buffer.from(String(Date.now())).toString("base64"),
        config: {
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
  if (tokenInit.code !== 0) throw new Error(`token init: ${tokenInit.rawLog}`);
  const token = tokenInit.arrayLog.find((l) => l.key === "contract_address").value;

  const coreInit = await deployer.client.tx.compute.instantiateContract(
    {
      sender: deployer.address,
      admin: deployer.address,
      code_id: code.core.codeId,
      code_hash: code.core.codeHash,
      label: `lst-core-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      init_msg: {
        manager: manager ?? deployer.address,
        limits: { max_performance_fee_bps: 1_000, max_validator_weight_bps: 2_500 },
        validator_allowlist: chosen,
        treasury: deployer.address,
        bonded_denom: DENOM,
        validators: chosen.map((address) => ({ address, weight_bps: 2_500 })),
        params: {
          unbond_window_secs: windowSecs,
          unbonding_period_secs: UNBONDING_SECS,
          performance_fee_bps: performanceFeeBps,
          withdrawal_fee_bps: 0,
          min_deposit: minDeposit,
          sync_stale_after_secs: syncStaleAfterSecs,
          max_unbond_entries_per_validator: 6,
        },
      },
    },
    { gasLimit: 2_000_000 },
  );
  if (coreInit.code !== 0) throw new Error(`core init: ${coreInit.rawLog}`);
  const core = coreInit.arrayLog.find((l) => l.key === "contract_address").value;

  const exec = async (contract, codeHash, msg, funds = []) => {
    const tx = await deployer.client.tx.compute.executeContract(
      {
        sender: deployer.address,
        contract_address: contract,
        code_hash: codeHash,
        msg,
        sent_funds: funds,
      },
      { gasLimit: 1_500_000 },
    );
    if (tx.code !== 0) throw new Error(tx.rawLog);
    return tx;
  };

  await exec(token, code.token.codeHash, { set_minters: { minters: [core] } });
  await exec(token, code.token.codeHash, { change_admin: { address: core } });
  await exec(
    core,
    code.core.codeHash,
    { bootstrap: { token_address: token, token_code_hash: code.token.codeHash } },
    [{ denom: DENOM, amount: "10000000" }],
  );

  return {
    deployer,
    core: { address: core, codeHash: code.core.codeHash },
    token: { address: token, codeHash: code.token.codeHash },
    validators: chosen,
  };
}

/** Query helpers bound to a deployment. */
export function api(protocol, client = protocol.deployer.client) {
  const queryCore = (query) =>
    client.query.compute.queryContract({
      contract_address: protocol.core.address,
      code_hash: protocol.core.codeHash,
      query,
    });

  return {
    state: async () => (await queryCore({ state: {} })).state,
    config: async () => (await queryCore({ config: {} })).config,
    validators: async () => (await queryCore({ validators: {} })).validators.validators,
    windows: async (state = null) =>
      (await queryCore({ windows: { state, start_after: null, limit: 50 } })).windows
        .windows,
    pendingClaims: async (permit) =>
      (await queryCore({ with_permit: { permit, query: { pending_claims: {} } } }))
        .pending_claims,
    raw: queryCore,
  };
}

/** Send an execute to lst-core from an arbitrary account. */
export async function callCore(protocol, from, msg, funds = []) {
  const tx = await from.client.tx.compute.executeContract(
    {
      sender: from.address,
      contract_address: protocol.core.address,
      code_hash: protocol.core.codeHash,
      msg,
      sent_funds: funds,
    },
    { gasLimit: 1_500_000 },
  );
  if (tx.code !== 0) throw new Error(tx.rawLog);
  return tx;
}

/** Request a withdrawal the way the frontend does: a token Send carrying the hook. */
export async function requestUnbond(protocol, from, microShares) {
  const tx = await from.client.tx.compute.executeContract(
    {
      sender: from.address,
      contract_address: protocol.token.address,
      code_hash: protocol.token.codeHash,
      msg: {
        send: {
          recipient: protocol.core.address,
          recipient_code_hash: protocol.core.codeHash,
          amount: microShares,
          msg: Buffer.from(JSON.stringify({ unbond: {} })).toString("base64"),
        },
      },
    },
    { gasLimit: 1_500_000 },
  );
  if (tx.code !== 0) throw new Error(tx.rawLog);
  return tx;
}

/**
 * Sign an app-wide permit.
 *
 * This is the path unit tests cannot reach: a permit is a wallet signature, and the mock
 * harness has no wallet. Everything about private claims is therefore only really proven
 * here.
 */
export async function signPermit(protocol, holder) {
  const permitName = `e2e-${Date.now()}`;
  const allowed = [protocol.core.address, protocol.token.address];

  const { signature } = await holder.wallet.signAmino(holder.address, {
    chain_id: CHAIN_ID,
    account_number: "0",
    sequence: "0",
    fee: { amount: [{ denom: DENOM, amount: "0" }], gas: "1" },
    msgs: [
      {
        type: "query_permit",
        value: {
          permit_name: permitName,
          allowed_tokens: allowed,
          permissions: ["balance", "owner"],
        },
      },
    ],
    memo: "",
  });

  return {
    params: {
      permit_name: permitName,
      allowed_tokens: allowed,
      chain_id: CHAIN_ID,
      permissions: ["balance", "owner"],
    },
    signature,
  };
}

export async function scrtBalance(who) {
  const { balance } = await who.client.query.bank.balance({
    address: who.address,
    denom: DENOM,
  });
  return BigInt(balance?.amount ?? "0");
}
