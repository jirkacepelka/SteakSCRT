# Can Secret Network's chain governance control this protocol?

**Yes — for code upgrades, through a purpose-built path.** Not through the obvious ones.

An earlier version of this document said no. That conclusion was wrong on two counts: it
was measured against LocalSecret **v1.15.0** while mainnet runs v1.24, and it used the
ordinary compute messages rather than the governance-specific ones added in **v1.21.6**.
Everything below is re-measured on v1.24.0.

## The measurements

| Route | Message | Result |
|---|---|---|
| Call the contract | `MsgExecuteContract` from gov | passed the vote, **execution failed** |
| Upgrade the code | `MsgMigrateContract` from gov | passed the vote, **execution failed** |
| Hand on the admin role | `MsgUpdateAdmin` from gov | passed the vote, **execution failed** |
| **Governance-gated upgrade** | `set-contract-governance` + `MsgContractGovernanceProposal` | **works** |

The three failures all return the same error:

```
Unable to decode transaction from bytes: proto: Tx: illegal tag 0 (wire type 6):
parse signature failed
```

Secret's compute module authenticates its messages against the signature of the carrying
transaction — the binding that ties an encrypted contract input to whoever encrypted it. A
message dispatched by the gov module runs in EndBlocker, where no such transaction exists,
so the parse fails before authorisation is considered. That is also why `MsgUpdateAdmin`
fails despite carrying no ciphertext: the requirement is on every compute message.

## The path that works

```
message MigrateContractInfo { string address = 1; uint64 new_code_id = 2; }
```

No `msg` field, therefore no ciphertext, therefore nothing that needs binding to a
signature. That is why this route survives where the others cannot.

The flow is two steps:

1. The contract admin calls `set-contract-governance <contract>`. This is **one-way** —
   once upgrades require governance, they require it permanently.
2. Governance passes `MsgContractGovernanceProposal` naming the contract and the target
   code id. The admin then submits the ordinary migrate transaction, which the chain now
   permits.

Verified end to end, and — more importantly — verified negatively. With
`require_governance` set and no matching proposal, the admin's own migration is refused:

```
failed to execute message: requires governance approval for migration
```

So the admin is a relay, not an authority. It can execute the upgrade the network approved
and nothing else.

`MsgContractGovernanceProposal` also carries `admin_updates`, so governance can replace the
relay itself.

Reproduce with:

```bash
node scripts/devnet.mjs up
node scripts/probe-gov-execute.mjs    # the direct route: still fails
node scripts/probe-gov-migrate.mjs    # the governance-gated route: works
```

## The consequence that shapes the contract

Step 2 is an ordinary `MsgMigrateContract`, and **the admin supplies its `MigrateMsg`**.
The proposal approves *which code* runs, not *what arguments* it runs with.

So a `MigrateMsg` carrying privileged parameters would hand the relay authority the network
never granted it: governance approves version N, and the relay picks the numbers. The
migrate entry point therefore takes no parameters at all. Anything the network decides
ships *inside* the code it voted for.

## What this means for the ownership model

- **Manager** — fees and the distribution across validators. A contract message, effective
  immediately, bounded by ceilings compiled into the code.
- **The network** — everything else, by voting on a code version. Slow by construction,
  which is appropriate for changing rules rather than operating them.

There is no third party holding a key that can change protocol rules on its own.

## Also available, not currently used

v1.21.6 added a **cron module** that executes CosmWasm messages on a schedule installed by
governance proposal. That is a second route by which the chain can reach a contract. It is
not needed here — upgrades cover everything outside the manager's remit — but it is the
mechanism to reach for if a future version needs governance to call the contract directly
rather than replace it.
