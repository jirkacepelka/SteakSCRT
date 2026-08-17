# Runbook

What to do when something is wrong. Written before it happens, because the moment you need
it is the moment you have least patience for reading code.

Two things are true of this protocol and worth holding onto while you work:

**Every upkeep message is permissionless.** `Sync`, `Compound`, `AdvanceWindow` and
`CollectMatured` can be sent by anyone with a funded key. Nothing below needs the manager
key, and nothing below can move a user's funds. If you are locked out of the manager
wallet, you can still do all of it.

**Users no longer depend on the keeper to reach their money.** Deposits and withdrawals
refresh their own bookkeeping, claims mature their own windows, and any deposit or
withdrawal closes an overdue window on its way past. A dead keeper costs yield, not access.
That is the difference every page below turns on.

---

## Reading the protocol

Start here for anything. No key needed.

```bash
node -e "import('secretjs').then(async ({SecretNetworkClient})=>{const d=require('./deploy/pulsar-3.json');const c=new SecretNetworkClient({chainId:d.chainId,url:'https://pulsar.lcd.secretnodes.com'});const q=(x)=>c.query.compute.queryContract({contract_address:d.core.address,code_hash:d.core.codeHash,query:x});console.log(JSON.stringify((await q({state:{}})).state,null,1));console.log(JSON.stringify((await q({windows:{state:null,start_after:null,limit:20}})).windows.windows,null,1));})"
```

What the figures mean:

| Field | Reading |
|---|---|
| `is_unattended` | nobody has run upkeep lately. Costs yield, not access. |
| `last_sync_time` | when the cache was last refreshed by anyone, keeper or user |
| `scrt_owed_to_windows` | everything promised to withdrawers, across all three phases |
| window `state` | `open` accepting requests, `unbonding` in the chain's queue, `matured` claimable, `settled` paid out |

---

## The keeper is dead

**Symptom:** `is_unattended` is true, `last_sync_time` hours old, the exchange rate flat.

**Impact:** yield only. Rewards sit unharvested at the validators, so they stop compounding
and the performance fee is not taken. Deposits, withdrawals and claims all still work.

**Do not panic-restart onto a second host without checking the first is really dead.** You
do not have to — the tasks are idempotent and two keepers running at once is harmless — but
you will burn double the gas for nothing.

### Running it continuously

A home server is a legitimate place for this. Losing the keeper costs yield, not access,
so home-grade uptime is a proportionate answer — and it keeps the key off a third party's
machine. Anything with Docker will do:

```bash
cp keeper/.env.example keeper/.env      # then fill it in
docker compose -f keeper/docker-compose.yml up -d
```

The container runs as a non-root user, writes nothing, and listens on no port — it needs
outbound HTTPS and a funded key, and nothing else. Its health probe is
`--check-only`, which exits non-zero when an invariant fails, so an empty gas account shows
up as unhealthy rather than as a container that looks fine and quietly does nothing.

Because every task is idempotent and permissionless, a second keeper anywhere else is
harmless and needs no coordination with the first. Two running at once waste some gas and
nothing more, which makes redundancy a decision rather than a project.

### Starting one by hand

```bash
$env:CHAIN_ID="pulsar-3"
$env:LCD_URL="https://pulsar.lcd.secretnodes.com"
$env:LST_CORE_ADDRESS="<core address>"
$env:LST_CORE_CODE_HASH="<core code hash>"
$env:KEEPER_MNEMONIC="<keeper wallet>"
npm --prefix keeper start
```

One pass and exit, if you only want to unstick things now: `npm --prefix keeper run once`.

**If the keeper is running but doing nothing**, check its own balance — it needs gas and
nothing else:

```bash
npm --prefix keeper run check
```

That reports the invariants without sending anything. A keeper out of gas logs failures on
every task and looks identical to a stalled one.

---

## A window is stuck

A window that will not move is the failure that used to trap money. It no longer does, but
it still delays people, so work out which of the three shapes you have.

### Open and past its closing time

**Symptom:** the open window's `closes_at` is in the past and it is still `open`.

Any deposit or withdrawal request closes it automatically now, so on a protocol with users
this resolves itself. If nothing is happening:

```bash
npm --prefix keeper run once
```

**If that does not close it**, the cause is almost always unbonding capacity. Cosmos allows
seven concurrent unbonding entries per (delegator, validator) pair and the protocol keeps
itself under six. When every validator is at the ceiling, there is nowhere to undelegate
and the close is deliberately skipped rather than failing.

Check:

```bash
node -e "import('secretjs').then(async ({SecretNetworkClient})=>{const d=require('./deploy/pulsar-3.json');const c=new SecretNetworkClient({chainId:d.chainId,url:'https://pulsar.lcd.secretnodes.com'});const v=(await c.query.compute.queryContract({contract_address:d.core.address,code_hash:d.core.codeHash,query:{validators:{}}})).validators.validators;for(const x of v)console.log(x.address, 'entries', x.active_unbond_entries, 'bonded', x.bonded);})"
```

If entries are at the ceiling: **wait**. Slots free themselves as earlier windows mature —
at most one unbonding period. Nothing is lost; the queue is doing what it was designed to
do under the chain's limit. Forcing it is not possible and would not be desirable.

If entries are *not* at the ceiling and it still will not close, that is a bug. Capture the
failing transaction's `rawLog` before doing anything else.

### Unbonding, past its maturity, not claimable

**Symptom:** window `state` is `unbonding`, `matures_at` is in the past.

Any claim matures its own windows now, so a user claiming will fix this for themselves. To
fix it for everyone:

```bash
npm --prefix keeper run once
```

**If the window matures but pays less than `scrt_owed`**, that is a slashing, not a fault.
`scrt_realised` records what the chain actually returned, and the shortfall is shared
pro-rata across everyone in that window rather than paid first-come-first-served. There is
nothing to fix; make sure anyone who asks understands the loss was on the validator, not in
the contract.

### Matured but a claim fails

Check the contract's own balance covers what the window owes:

```bash
curl -s "https://pulsar.lcd.secretnodes.com/cosmos/bank/v1beta1/balances/<core address>"
```

If the balance is short of `scrt_realised` for matured windows, stop and investigate — that
is money going somewhere it should not. Do not migrate the contract to "fix" it until you
know where it went; a migration cannot undo a bad state, only add code on top of it.

---

## The frontend is down but the chain is fine

The app is a static export with no server. It talks to one LCD endpoint, baked in at build
time, so an LCD outage takes the interface down while the protocol keeps running.

Nobody's funds are at risk and there is no rush. Point `NEXT_PUBLIC_LCD_URL` at another
Secret LCD and redeploy — the variable is compiled into the bundle, so it needs a rebuild,
not just a settings change.

Anyone can also transact without the app at all, using `secretd` against the contract
directly. Say so if people ask; it is true, and it is the point of a static frontend.

---

## Deposits are paused and nobody meant to pause them

`SetPaused` is the manager's. If deposits are paused unexpectedly, treat the manager key as
compromised until proven otherwise: check whether the fee or the validator weights also
moved, because those are the other things that key can reach.

Pausing cannot trap anyone. Withdrawal requests and claims are deliberately not pausable.

---

## What none of this covers

**A validator misbehaving** — jailed, tombstoned, raising commission — is the manager's
call, not an incident. Move the weight with the Governor console and let the drift do the
rest.

**Anything requiring a code change** needs the upgrade path, and after
`set-contract-governance` that means a vote. `scripts/upgrade.mjs` refuses to run once the
contract has no admin, which is the signal that you are in that world.

**Do not migrate as a reflex.** A migration is the one action here that cannot be undone by
doing it again: the old code cannot repair state the new code has rewritten. Read
`scripts/upgrade.mjs` for what it checks, and rehearse against a devnet with a funded pool
before touching a live one.
