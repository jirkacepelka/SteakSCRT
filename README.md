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
contracts/lst-token    the derivative SNIP-20 (fork of scrtlabs/snip20-reference-impl)
contracts/timelock     delayed execution over governance and migrations
packages/lst-types     shared wire types; source of truth for TypeScript codegen
keeper/                upkeep bot: compound, advance windows, collect, rebalance
app/                   frontend
scripts/               build, schema, devnet, deploy
devnet/                LocalSecret with a patched genesis for end-to-end tests
```

## Development

Requires Rust (stable), Node 20+, and Docker.

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

## Security posture

- `overflow-checks` stays on in release builds. Every arithmetic path touches user funds.
- Share conversions round in favour of the pool, never the caller.
- Deposits and withdrawals are refused when cached totals are stale, so an unsynced
  slashing event cannot be arbitraged.
- Claiming matured funds is never pausable — a compromised or absent admin cannot trap
  withdrawals.
- Contract migration is gated behind the timelock, not an admin key.

## License

Apache-2.0.
