# Secret LST — liquid staking for SCRT

A liquid staking protocol for Secret Network. Deposit native SCRT, receive a
non-rebasing SNIP-20 derivative whose value against SCRT grows as staking rewards
compound.

> **Status: pre-alpha, under construction.** Nothing here has been audited or deployed.
> Do not put real funds anywhere near it.

## What it does

Staked SCRT is locked for 21 days. This protocol pools deposits, spreads them across a
governed validator set, compounds rewards automatically, and hands the depositor a liquid
token they can trade or use as collateral in the meantime.

## The constraint that shapes everything

Cosmos allows only **7 concurrent unbonding entries per (delegator, validator) pair**, and
this contract is a single delegator. Per-user unbonding is therefore impossible: a few
dozen withdrawals would wedge the protocol permanently.

Withdrawals are instead batched into fixed-length **unbonding windows**. One `Undelegate`
per validator is issued when a window closes, which caps concurrent entries at
`ceil(unbonding_period / window)` plus a slot of margin.

Against the chain's 21-day period:

| Window | Entry slots needed | Verdict |
|---|---|---|
| 3 days | 8 | Exceeds the chain's limit of 7 |
| 4 days | 7 | Legal, but no headroom |
| **5 days** | **6** | **Default — one slot of headroom** |

A withdrawal therefore takes 21 days at best and 26 at worst.

## Privacy: what is and isn't hidden

Secret encrypts *contract state*, not the bank or staking modules. Be clear-eyed about it:

**Public:** deposits (a native SCRT transfer), the contract's delegations, the exchange
rate, TVL, and every window's size.

**Private:** derivative token balances and transfers (SNIP-20 with delayed write buffers
and bucketed entry tries), and the link between a deposit and its eventual holder once the
token has moved.

The incumbent, Shade Protocol's `stkd-SCRT`, has exactly the same properties. Anyone
claiming a Secret LST makes staking "anonymous" is overselling it.

## Layout

```
contracts/lst-core     staking engine, unbonding queue, exchange-rate accounting
contracts/lst-token    submodule: scrtlabs/snip20-reference-impl @ v1.5.0, unmodified
packages/lst-types     shared wire types; source of truth for TypeScript codegen
keeper/                upkeep bot: compound, advance windows, collect, rebalance
app/                   frontend
scripts/               build, schema, devnet, deploy
devnet/                LocalSecret with a patched genesis for end-to-end tests
```

## The derivative token is not ours

`dSCRT` is SCRT Labs' SNIP-20 reference implementation at tag `v1.5.0`, vendored as a
submodule and built **unmodified**.

We planned to fork it and then found nothing worth changing. Everything the protocol needs
is already configuration: `public_total_supply` and `enable_mint`/`enable_burn` are
instantiation flags, and `SetMinters` hands minting rights to `lst-core` after deployment.
Forking would have meant owning ~5,000 lines of privacy-critical code — delayed write
buffers, bucketed entry tries, permit handling — for no behavioural gain, and every future
upstream fix would have become a manual merge.

The token carries its own internal admin, separate from the chain-level contract admin,
and it is a real authority: it can change the minter set and halt all transfers. Deployment
disposes of it rather than holding it.

- `SetMinters` is called once to make `lst-core` the sole minter. It replaces the list
  wholesale, so the same call removes the deploy key — leaving it in would be a
  mint-anything backdoor.
- The token's admin is then set to **`lst-core`'s own address**. `lst-core` has no code
  path that sends token admin messages, so the powers become permanently inert: the minter
  set can never change, the token can never be halted, and the admin can never be handed
  on. Upgrades to the token itself go through `set-contract-governance` like `lst-core`'s.

That last point matters for withdrawals. A halted token would block new withdrawal
*requests*, because those burn dSCRT. Making the halt unreachable removes the concern
entirely — and even if it were reachable, claims on already-matured windows pay out native
SCRT straight from `lst-core` and never touch the token.

## Development

Requires Rust (stable), Node 20+, and Docker.

Clone with submodules, or initialise them afterwards:

```bash
git submodule update --init --recursive
```

```bash
npm run check
```

Runs formatting, clippy and the unit tests. Individually:

```bash
cargo test --workspace
```

### Building deployable wasm

```bash
npm run build
```

Contracts are compiled **inside SCRT Labs' pinned optimizer image**, never with the host
toolchain, and Docker must be running.

This is not optional ceremony. Rust 1.82 enabled the `reference-types` and `multivalue`
wasm proposals by default; Secret's engine rejects both, so a host-built contract uploads
and then fails validation with an unhelpful `zero byte expected` error. The pinned image
predates that change and makes builds byte-reproducible for auditors as a bonus.

### End-to-end scenarios

```bash
node scripts/devnet.mjs up
npm --prefix tests/e2e test
```

These run against a real chain and cover what unit tests structurally cannot: the permit
path, because a permit is a wallet signature and the mock harness has no wallet; the
cross-contract dance between `lst-core` and the SNIP-20; and the real staking module,
whose unbonding behaviour the mock querier only imitates.

Each scenario deploys its own instance. Sharing one would make the tests order-dependent —
a withdrawal in one leaves a window in flight for the next — and the point of testing
against a chain is to catch what only appears when state is real.

Two assumptions the mock quietly encouraged did not survive contact with a live chain:
rewards accrue every block, so the exchange rate is at or just above parity rather than
exactly on it, and a window has to be waited for rather than assumed to have matured.

## Who controls this

Two parties, and only two.

**The manager** sets the performance fee and the distribution of stake across validators.
That is the entire list. It is a contract message, effective immediately, and bounded by
ceilings compiled into the binary: a fee cap, a **25% ceiling on any single validator's
share**, and an allowlist of validators it may use at all.

Those bounds are what make the role safe to hand out. Without the weight ceiling a manager
could route the whole stake to a validator they operate and take the yield as validator
commission, having never touched a user's token; the allowlist closes the same hole from
the other side, and redelegation is checked against it too.

**The network** decides everything else — parameters, the allowlist, the treasury address,
and who the manager is — by voting on a code version. The contract is deployed with
`set-contract-governance`, a one-way switch after which upgrades require a passed
`MsgContractGovernanceProposal`.

There is no third key that can change the rules. Verified on a devnet running mainnet's
node version, positively and negatively: with the switch set and no matching proposal, the
admin's own migration is refused with `requires governance approval for migration`. The
admin is a relay that can execute the upgrade the network approved and nothing else. See
[docs/governance-findings.md](docs/governance-findings.md), reproducible via
`scripts/probe-gov-migrate.mjs`.

Migration deliberately takes no parameters. The proposal approves which code runs, not what
arguments it runs with, and the relay chooses the payload — so a `MigrateMsg` carrying
privileged fields would hand it authority the network never voted for.

The deployer holds exactly one power, once: binding the derivative token, which cannot
happen at instantiation because the contract and its token each need the other's address.
The call consumes the right.

## Security posture

- `overflow-checks` stays on in release builds. Every arithmetic path touches user funds.
- Share conversions round in favour of the pool, never the caller.
- Deposits and withdrawals are refused when cached totals are stale, so an unsynced
  slashing event cannot be arbitraged.
- Claiming matured funds is never pausable — a compromised or absent admin cannot trap
  withdrawals.
- Contract migration is gated behind a governance vote, not an admin key.

## License

Apache-2.0.
