/**
 * End-to-end scenarios against a running LocalSecret devnet.
 *
 * These cover what the unit tests structurally cannot:
 *
 *   - the permit path, because a permit is a wallet signature and the mock harness has no
 *     wallet;
 *   - the cross-contract dance between lst-core and the SNIP-20, including the receiver
 *     hook that turns a token transfer into a withdrawal request;
 *   - the real staking module, whose delegation and unbonding behaviour the mock querier
 *     only imitates.
 *
 * Start the devnet first: `node scripts/devnet.mjs up`.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  account,
  api,
  callCore,
  deployProtocol,
  MNEMONICS,
  requestUnbond,
  scrtBalance,
  signPermit,
  sleep,
  UNBONDING_SECS,
} from "./harness.mjs";

const SCRT = 1_000_000n;

/** What the withdrawal scenario's request was actually priced at, shared by its payout. */
let owed = 0n;
const WINDOW_SECS = 60;
const PARITY = "1000000000000000000";

/** Poll until a predicate holds, so tests wait on the chain rather than on a guess. */
async function until(what, predicate, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(3_000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("liquid staking, end to end", { concurrency: 1 }, () => {
  let protocol;
  let query;
  let user;

  before(async () => {
    user = account(MNEMONICS.a);
    protocol = await deployProtocol({ windowSecs: WINDOW_SECS });
    query = api(protocol);
  });

  it("starts seeded, at parity, and delegated", async () => {
    const state = await query.state();
    assert.equal(state.total_bonded, "10000000", "the bootstrap seed is delegated");
    assert.equal(state.total_supply, "10000000", "and backed one for one");
    assert.equal(state.exchange_rate, PARITY);
    assert.equal(state.is_unattended, false);

    const validators = await query.validators();
    const delegated = validators.reduce((sum, v) => sum + BigInt(v.bonded), 0n);
    assert.equal(delegated, 10n * SCRT, "every seeded token reached a validator");
  });

  it("refuses a deposit below the minimum", async () => {
    await assert.rejects(
      () => callCore(protocol, user, { deposit: {} }, [{ denom: "uscrt", amount: "999" }]),
      /below the minimum/,
    );
  });

  it("still takes a deposit when nobody has synced for longer than the protocol expects", async () => {
    // The regression this guards: the protocol used to refuse every deposit and
    // withdrawal once the cache aged past `sync_stale_after_secs`, so an idle keeper took
    // it offline for users. A deposit now re-reads its own delegations.
    const idle = await deployProtocol({ windowSecs: WINDOW_SECS, syncStaleAfterSecs: 5 });
    const depositor = account(MNEMONICS.a);

    await sleep(12_000);
    const before = await api(idle).state();
    assert.equal(before.is_unattended, true, "the cache should be reported unattended by now");

    await callCore(idle, depositor, { deposit: {} }, [
      { denom: "uscrt", amount: (5n * SCRT).toString() },
    ]);

    const after = await api(idle).state();
    // Asserting the timestamp moved rather than that the cache reads fresh: with a
    // five-second threshold it is stale again by the time this query lands, which says
    // nothing about whether the deposit refreshed it.
    assert.ok(
      after.last_sync_time > before.last_sync_time,
      `the deposit should have refreshed the cache (${before.last_sync_time} -> ${after.last_sync_time})`,
    );
    assert.ok(
      BigInt(after.total_bonded) - BigInt(before.total_bonded) >= 5n * SCRT,
      "the deposit should have landed",
    );
  });

  it("mints against the live rate, never more than the deposit is worth", async () => {
    const before = await query.state();
    await callCore(protocol, user, { deposit: {} }, [
      { denom: "uscrt", amount: (10n * SCRT).toString() },
    ]);

    const after = await query.state();
    const minted = BigInt(after.total_supply) - BigInt(before.total_supply);

    assert.equal(BigInt(after.total_bonded) - BigInt(before.total_bonded), 10n * SCRT);
    assert.ok(minted <= 10n * SCRT, `minted ${minted} for a 10 SCRT deposit`);
    // Rewards accrue every block on a real chain, so the rate is at or just above parity
    // rather than exactly on it — which is the whole point of the derivative.
    assert.ok(minted > 9n * SCRT, `minted ${minted}, far below the deposit`);
    assert.ok(BigInt(after.exchange_rate) >= BigInt(PARITY));
  });

  it("shows a user their own claims behind a permit, and nobody else's", async () => {
    await requestUnbond(protocol, user, (4n * SCRT).toString());

    const permit = await signPermit(protocol, user);
    const mine = await query.pendingClaims(permit);

    assert.equal(mine.claims.length, 1);
    // Not exactly 4 SCRT: a withdrawal is priced against delegations read in its own
    // transaction, so it carries the holder's share of rewards accrued right up to that
    // block. Worth a little over the round number, never less.
    owed = BigInt(mine.claims[0].scrt_owed);
    assert.ok(
      owed >= 4n * SCRT && owed < 4n * SCRT + SCRT / 100n,
      `expected a shade over 4 SCRT, got ${owed}`,
    );
    assert.equal(mine.claims[0].state, "open");
    assert.equal(mine.total_claimable_now, "0", "nothing until the window matures");

    // A permit signed by somebody else returns their position, not this user's. This is
    // the property that makes claims private, and it cannot be checked without a wallet.
    const stranger = account(MNEMONICS.b);
    const theirs = await query.pendingClaims(await signPermit(protocol, stranger));
    assert.equal(theirs.claims.length, 0);
    assert.equal(theirs.total_owed, "0");
  });

  it("never lets a withdrawal move the rate against the holders who stayed", async () => {
    // The regression the unit tests pinned once the three-phase liability model landed.
    // Re-checked against a real staking module, where the money genuinely leaves the
    // delegation and arrives in the balance a minute and a half later.
    //
    // The rate may only rise, and only because rewards accrue. Any fall would mean a
    // withdrawal took value from the people who did not withdraw.
    const stages = [];
    const record = async (label) => {
      const rate = BigInt((await query.state()).exchange_rate);
      stages.push([label, rate]);
      return rate;
    };

    await record("request booked");

    const target = (await query.windows("open"))[0];
    await until("the window to close", async () =>
      Math.floor(Date.now() / 1000) >= target.closes_at,
    );

    await callCore(protocol, user, { advance_window: {} });
    await record("undelegation in flight");

    await until(
      "the window to mature",
      async () => {
        const w = (await query.windows()).find((x) => x.id === target.id);
        // Wait for the window itself, not for it to disappear from a filtered list: an
        // absent window used to read as "done" and let the test race ahead of the chain.
        return w && w.state === "unbonding" && Math.floor(Date.now() / 1000) >= w.matures_at;
      },
      (UNBONDING_SECS + 120) * 1000,
    );

    await callCore(protocol, user, { collect_matured: {} });
    await record("money back, unclaimed");

    for (let i = 1; i < stages.length; i++) {
      assert.ok(
        stages[i][1] >= stages[i - 1][1],
        `rate fell between "${stages[i - 1][0]}" and "${stages[i][0]}": ${stages[i - 1][1]} -> ${stages[i][1]}`,
      );
    }
    assert.ok(stages[0][1] >= BigInt(PARITY));
  });

  it("pays the withdrawal out", async () => {
    const before = await scrtBalance(user);

    const permit = await signPermit(protocol, user);
    const claimable = await query.pendingClaims(permit);
    assert.equal(
      claimable.total_claimable_now,
      owed.toString(),
      "the matured window is claimable in full, for exactly what it was priced at",
    );

    await callCore(protocol, user, { claim_matured: { window_ids: null } });

    const after = await scrtBalance(user);
    // Gas comes out of the same balance, so assert the direction and rough size rather
    // than an exact figure.
    assert.ok(
      after > before + 3n * SCRT,
      `expected roughly 4 SCRT back, balance moved by ${after - before}`,
    );

    const settled = await query.pendingClaims(permit);
    assert.equal(settled.claims[0].claimed, true);
    assert.equal(settled.total_claimable_now, "0");
  });

  it("refuses to pay the same claim twice", async () => {
    await assert.rejects(
      () => callCore(protocol, user, { claim_matured: { window_ids: null } }),
      /nothing to claim/i,
    );
  });

  it("rolls an unused window forward without spending an entry slot", async () => {
    const before = await query.validators();
    const slotsBefore = before.reduce((n, v) => n + v.active_unbond_entries, 0);

    const openWindow = (await query.windows("open"))[0];
    await until("the empty window to close", async () => {
      return Math.floor(Date.now() / 1000) >= openWindow.closes_at;
    });

    await callCore(protocol, user, { advance_window: {} });

    const after = await query.validators();
    const slotsAfter = after.reduce((n, v) => n + v.active_unbond_entries, 0);
    assert.equal(
      slotsAfter,
      slotsBefore,
      "nobody withdrew, so no undelegation and no slot consumed",
    );
  });
});

describe("the manager's boundaries hold on chain", { concurrency: 1 }, () => {
  let protocol;
  let query;
  let manager;
  let outsider;

  before(async () => {
    manager = account(MNEMONICS.c);
    outsider = account(MNEMONICS.b);
    protocol = await deployProtocol({ windowSecs: WINDOW_SECS, manager: manager.address });
    query = api(protocol);
  });

  it("lets the manager redistribute within the ceiling", async () => {
    const allowlist = (await query.config()).validator_allowlist;
    await callCore(protocol, manager, {
      manager: {
        set_weights: {
          weights: allowlist.map((address) => ({ address, weight_bps: 2_500 })),
        },
      },
    });

    const validators = await query.validators();
    assert.ok(validators.every((v) => v.weight_bps === 2_500));
  });

  it("refuses to concentrate stake past the compiled ceiling", async () => {
    const allowlist = (await query.config()).validator_allowlist;
    await assert.rejects(
      () =>
        callCore(protocol, manager, {
          manager: {
            set_weights: {
              weights: [
                { address: allowlist[0], weight_bps: 9_000 },
                { address: allowlist[1], weight_bps: 1_000 },
              ],
            },
          },
        }),
      /ceiling/,
      "a manager must not be able to route the stake to one validator",
    );
  });

  it("refuses a validator the network never approved", async () => {
    const allowlist = (await query.config()).validator_allowlist;
    await assert.rejects(
      () =>
        callCore(protocol, manager, {
          manager: {
            set_weights: {
              weights: [
                { address: allowlist[0], weight_bps: 2_500 },
                { address: allowlist[1], weight_bps: 2_500 },
                { address: allowlist[2], weight_bps: 2_500 },
                { address: "secretvaloper1notonthelistatallxxxxxxxxxxxxxxxxxx", weight_bps: 2_500 },
              ],
            },
          },
        }),
      /allowlist/,
    );
  });

  it("refuses a fee above the ceiling the network set", async () => {
    await assert.rejects(
      () => callCore(protocol, manager, { manager: { set_performance_fee: { bps: 1_001 } } }),
      /exceeds/,
    );
    await callCore(protocol, manager, { manager: { set_performance_fee: { bps: 1_000 } } });
    assert.equal((await query.config()).params.performance_fee_bps, 1_000);
  });

  it("refuses everything to a wallet that is not the manager", async () => {
    await assert.rejects(
      () => callCore(protocol, outsider, { manager: { set_performance_fee: { bps: 0 } } }),
      /unauthorized/i,
    );
    await assert.rejects(
      () => callCore(protocol, outsider, { set_paused: { paused: true } }),
      /unauthorized/i,
    );
  });

  it("lets the manager pause deposits without trapping withdrawals", async () => {
    const user = account(MNEMONICS.a);
    await callCore(protocol, user, { deposit: {} }, [
      { denom: "uscrt", amount: (5n * SCRT).toString() },
    ]);

    await callCore(protocol, manager, { set_paused: { paused: true } });

    await assert.rejects(
      () =>
        callCore(protocol, user, { deposit: {} }, [
          { denom: "uscrt", amount: (1n * SCRT).toString() },
        ]),
      /paused/,
    );

    // The point of the design: a pause stops money coming in, never going out.
    await requestUnbond(protocol, user, (1n * SCRT).toString());
    const windows = await query.windows("open");
    const queued = BigInt(windows[0].scrt_owed);
    assert.ok(
      queued >= 1n * SCRT && queued < 1n * SCRT + SCRT / 100n,
      `expected a shade over 1 SCRT queued, got ${queued}`,
    );

    await callCore(protocol, manager, { set_paused: { paused: false } });
  });

  after(async () => {
    // Leave the devnet in a state the next run can reuse.
    await sleep(500);
  });
});
