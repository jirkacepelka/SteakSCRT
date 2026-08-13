# Can Secret Network's chain governance control this protocol?

**No. Measured, not assumed.**

The intended design put SCRT chain governance in the owner role: the manager sets fees and
validator distribution, and the network decides everything else. Three routes exist for a
governance proposal to reach a contract. All three were tested on a devnet against the real
`lst-core` binary, and all three fail identically.

## The measurements

| Route | Message | Result |
|---|---|---|
| Call the contract | `MsgExecuteContract` | passed the vote, **execution failed** |
| Upgrade the code | `MsgMigrateContract` | passed the vote, **execution failed** |
| Hand on the admin role | `MsgUpdateAdmin` | passed the vote, **execution failed** |

Every one returned the same error:

```
Unable to decode transaction from bytes: proto: Tx: illegal tag 0 (wire type 6):
parse signature failed
```

Ground truth confirms it rather than trusting the proposal status: the contract's admin was
correctly recorded as the gov module account, and after a passed migration proposal its
`code_id` was unchanged.

Reproduce with:

```bash
node scripts/devnet.mjs up
node scripts/probe-gov-execute.mjs
node scripts/probe-gov-migrate.mjs
```

## Why

Secret's compute module authenticates its messages against the signature of the
transaction carrying them — that binding is what ties an encrypted contract input to the
sender who encrypted it. A message dispatched by the governance module runs in EndBlocker,
where no such transaction exists, so the parse fails before authorisation is ever
considered.

That also explains why `MsgUpdateAdmin` fails despite carrying no encrypted payload: the
requirement is on every compute message, not only the ones with ciphertext in them.

Contract-to-contract calls are unaffected. Secret has a separate path for those, which is
why a DAO *contract* can govern another contract while the chain's own governance module
cannot.

## What this rules out

Any design where SCRT stakers directly control the protocol by voting. Not a configuration
problem and not something a different message shape works around.

## What remains possible

- **A multisig owner.** Practical and conventional. Trust is placed in named signers.
- **A DAO contract owner.** Holders vote inside a contract, and contract-to-contract calls
  work. The only fully on-chain option.
- **Signalling.** Chain governance passes a *text* proposal; a small executor multisig is
  socially bound to carry it out. The network decides, the multisig relays. Closest in
  spirit to network ownership, but the relay is trusted to obey.
- **No owner.** Set the owner to an unspendable address after launch. Parameters, the
  allowlist and the manager appointment are then frozen for good — including the ability to
  replace a manager whose key is lost.

The manager tier is unaffected by this choice: it is bounded in code and works the same way
underneath any of them.
