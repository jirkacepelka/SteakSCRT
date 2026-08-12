#!/bin/bash
# Genesis patches applied by LocalSecret's POST_INIT_SCRIPT hook, before keys are
# created and the genesis transaction is collected.
#
# LocalSecret already sets `unbonding_time = "90s"`, which is what makes the full
# deposit -> window -> unbond -> claim cycle testable in minutes rather than in three
# weeks. Everything below exists to support a *multi-validator* devnet.
#
# The protocol spreads stake across a set of validators, so the interesting bugs —
# undelegation spilling across validators, entry ceilings, draining, rebalancing — only
# show up with more than one. LocalSecret runs a single node, so the extra validators
# created after start-up never sign a block and would be jailed for downtime within
# minutes, silently changing the set underneath a running test.
#
# Disabling downtime slashing keeps them in the active set. Jailing behaviour is covered
# by unit tests against a mocked querier instead, where it can be triggered deliberately
# rather than as a side effect of the test rig.

set -oe errexit

GENESIS=~/.secretd/config/genesis.json

jq '
  .app_state.slashing.params.signed_blocks_window = "10000000" |
  .app_state.slashing.params.min_signed_per_window = "0.000000000000000000" |
  .app_state.slashing.params.slash_fraction_downtime = "0.000000000000000000" |
  .app_state.staking.params.max_validators = 10
' "$GENESIS" > "$GENESIS.tmp" && mv "$GENESIS.tmp" "$GENESIS"

echo "devnet: slashing disabled for downtime, max_validators = 10"
