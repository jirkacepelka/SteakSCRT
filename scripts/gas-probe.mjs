#!/usr/bin/env node
/**
 * Measure what the user paths and the keeper's upkeep actually cost, and check that the
 * limits the app declares are enough.
 *
 * A Cosmos transaction is charged the fee it declares, not the gas it burns, so these
 * limits are a real cost to users rather than a safety net that is free to leave loose.
 * They should be sized from this script's output, not from caution — and re-run whenever
 * the pricing path changes, because deposits and withdrawals re-read every validator and
 * that cost scales with the set.
 *
 * Devnet only. Uses the public LocalSecret genesis key, which is not a secret.
 *
 *   node scripts/devnet.mjs up
 *   node scripts/deploy.mjs --network devnet
 *   node scripts/gas-probe.mjs
 */

import { readFileSync } from "node:fs";
import { SecretNetworkClient, Wallet } from "secretjs";

const d = JSON.parse(readFileSync("deploy/devnet.json", "utf8"));
const app = readFileSync("app/src/lib/protocol.ts", "utf8");

const num = (re) => Number(app.match(re)[1].replace(/_/g, ""));

// Mirror the app's own sizing rather than restating it, so the two cannot drift.
const BASE = {
  deposit: num(/deposit: ([\d_]+), unbond/),
  unbond: num(/unbond: ([\d_]+) \} as const/),
};
const PER_VALIDATOR = num(/GAS_PER_VALIDATOR = ([\d_]+)/);
const MARGIN = Number(app.match(/GAS_MARGIN = ([\d.]+)/)[1]);
const PRICE = Number(app.match(/GAS_PRICE = ([\d.]+)/)[1]);

const scaled = (action, n) => Math.ceil((BASE[action] + PER_VALIDATOR * n) * MARGIN);
const GAS = { claim: num(/claim: ([\d_]+)/) };

const wallet = new Wallet(
  "push certain add next grape invite tobacco bubble text romance again lava crater pill genius vital fresh guard great patch knee series era tonight",
);
const client = new SecretNetworkClient({
  chainId: "secretdev-1",
  url: "http://localhost:1317",
  wallet,
  walletAddress: wallet.address,
});

const core = { contract_address: d.core.address, code_hash: d.core.codeHash };
const token = { contract_address: d.token.address, code_hash: d.token.codeHash };
const toBase64 = (s) => Buffer.from(s, "utf8").toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const exec = (target, msg, gasLimit, funds = []) =>
  client.tx.compute.executeContract(
    { sender: wallet.address, ...target, msg, sent_funds: funds },
    { gasLimit, gasPriceInFeeDenom: PRICE },
  );

let failed = false;
function report(label, tx, gasLimit) {
  const ok = tx.code === 0;
  if (!ok) failed = true;
  const headroom = gasLimit / tx.gasUsed;
  if (headroom < 1.8 && ok) failed = true;
  console.log(
    `${label.padEnd(22)} used ${String(tx.gasUsed).padStart(7)} / ${String(gasLimit).padStart(7)}` +
      `  ${headroom.toFixed(1)}x  ${((gasLimit * PRICE) / 1e6).toFixed(5)} SCRT` +
      `  ${ok ? (headroom < 1.8 ? "TOO TIGHT" : "ok") : "FAILED " + tx.rawLog.slice(0, 70)}`,
  );
}

const n = d.validators.length;
const depositGas = scaled("deposit", n);
const unbondGas = scaled("unbond", n);

console.log(`validators: ${n}   price: ${PRICE} uscrt`);
console.log(
  `at the contract's twenty-validator ceiling these would be ` +
    `${scaled("deposit", 20)} / ${scaled("unbond", 20)}\n`,
);

report(
  "deposit",
  await exec(core, { deposit: {} }, depositGas, [{ denom: "uscrt", amount: "10000000" }]),
  depositGas,
);

const send = (amount) => ({
  send: {
    recipient: d.core.address,
    recipient_code_hash: d.core.codeHash,
    amount,
    msg: toBase64(JSON.stringify({ unbond: {} })),
  },
});
report("unbond", await exec(token, send("3000000"), unbondGas), unbondGas);
report("unbond again", await exec(token, send("1000000"), unbondGas), unbondGas);

// Keeper paths, at the limit the keeper would size for this set. Read from its source
// rather than restated, for the same reason as the app's.
const kc = readFileSync("keeper/src/client.ts", "utf8");
const knum = (re) => Number(kc.match(re)[1].replace(/_/g, ""));
const KEEPER_GAS = Math.ceil(
  (knum(/COMPOUND_BASE_GAS = ([\d_]+)/) + knum(/PER_VALIDATOR_GAS = ([\d_]+)/) * n) *
    Number(kc.match(/GAS_MARGIN = ([\d.]+)/)[1]),
);
report("sync (keeper)", await exec(core, { sync: { limit: 25 } }, KEEPER_GAS), KEEPER_GAS);
report("compound (keeper)", await exec(core, { compound: { limit: 25 } }, KEEPER_GAS), KEEPER_GAS);

console.log("\ndriving a window to maturity for the claim path…");
for (let i = 0; i < 40; i++) {
  await sleep(15_000);
  if ((await exec(core, { advance_window: {} }, KEEPER_GAS)).code === 0) break;
}
let matured = false;
for (let i = 0; i < 40; i++) {
  await sleep(15_000);
  const col = await exec(core, { collect_matured: { limit: 25 } }, KEEPER_GAS);
  const st = await client.query.compute.queryContract({
    ...core,
    query: { windows: { state: "matured" } },
  });
  if (col.code === 0 && JSON.stringify(st).includes("matured")) {
    matured = true;
    break;
  }
}

if (matured) {
  report("claim", await exec(core, { claim_matured: { window_ids: null } }, GAS.claim), GAS.claim);
} else {
  failed = true;
  console.log("claim NOT measured — the window never matured");
}

console.log(failed ? "\nFAIL — a limit is too tight or a path failed" : "\nevery limit holds");
process.exit(failed ? 1 : 0);
