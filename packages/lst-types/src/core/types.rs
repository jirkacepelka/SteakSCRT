//! Domain types shared between `lst-core`, the keeper bot and the frontend.

use cosmwasm_std::{Addr, Uint128};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Basis points denominator. All `*_bps` fields are relative to this.
pub const BPS_DENOM: u16 = 10_000;

/// Lifecycle of a validator in the protocol's curated set.
///
/// Removal is deliberately not instantaneous: SCRT delegated to a validator cannot be
/// pulled out synchronously, so a validator leaves the set by first draining (it stops
/// receiving new stake and is preferred as an undelegation source) and only becomes
/// `Removed` once its bonded balance reaches zero.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ValidatorStatus {
    /// Receives new delegations, weighted by `weight_bps`.
    Active,
    /// Receives no new delegations and is drained first when unbonding.
    Draining,
    /// Fully drained and no longer considered by any selection routine.
    Removed,
}

impl ValidatorStatus {
    /// Whether this validator may receive new stake.
    pub fn accepts_stake(self) -> bool {
        matches!(self, ValidatorStatus::Active)
    }
}

/// A validator in the protocol's curated set.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct ValidatorEntry {
    pub address: String,
    /// Target share of total stake, in basis points. Weights of all `Active` validators
    /// must sum to [`BPS_DENOM`].
    pub weight_bps: u16,
    pub status: ValidatorStatus,
    /// Last synced bonded amount. Refreshed from `StakingQuery::Delegation`, never
    /// derived purely arithmetically, so that slashing is reflected rather than assumed
    /// away.
    pub bonded: Uint128,
    /// Rewards observed at the last sync but not yet withdrawn.
    pub pending_rewards: Uint128,
    /// Number of unbonding entries currently in flight against this validator.
    ///
    /// The chain caps this at `max_entries = 7` per (delegator, validator) pair. The
    /// protocol enforces its own lower ceiling so that a full queue can never wedge the
    /// unbonding pipeline.
    pub active_unbond_entries: u8,
}

/// Validator definition accepted at instantiation and by governance.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct ValidatorInit {
    pub address: String,
    pub weight_bps: u16,
}

/// State machine of a batched unbonding window.
///
/// Users never unbond individually: the chain allows only 7 concurrent unbonding entries
/// per validator, so withdrawals are aggregated into fixed-length windows and a single
/// `Undelegate` per validator is issued when a window closes.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WindowState {
    /// Accepting withdrawal requests.
    Open,
    /// Closed; `Undelegate` messages issued, waiting out the chain's unbonding period.
    Unbonding,
    /// SCRT has returned to the contract and is claimable by users.
    Matured,
    /// Every claim has been paid out.
    Settled,
}

/// A batched unbonding window.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct UnbondWindow {
    pub id: u64,
    pub opened_at: u64,
    /// When the window stops accepting requests. `AdvanceWindow` is callable from here on.
    pub closes_at: u64,
    /// Earliest time the SCRT can be claimed. Zero until the window actually closes,
    /// because it is derived from the block time at which `Undelegate` was issued.
    pub matures_at: u64,
    /// Derivative tokens burned into this window.
    pub shares_burned: Uint128,
    /// SCRT owed to this window's participants, priced at the exchange rate in effect
    /// when each request was made.
    pub scrt_owed: Uint128,
    /// SCRT that actually came back from the staking module, set when the window matures.
    ///
    /// Normally equal to `scrt_owed`. It is lower when a validator holding this window's
    /// undelegation was slashed while the unbonding was in flight — the chain returns
    /// less than was undelegated, and no amount of bookkeeping conjures the difference
    /// back. Claims are scaled by `scrt_realised / scrt_owed` so the loss is shared
    /// pro-rata within the window instead of being paid out first-come-first-served.
    pub scrt_realised: Option<Uint128>,
    /// SCRT already paid out to claimants.
    pub scrt_claimed: Uint128,
    /// Validators this window undelegated from, recorded so their entry counters can be
    /// released when it matures.
    pub validators_used: Vec<String>,
    pub state: WindowState,
}

impl UnbondWindow {
    /// SCRT this window can actually pay, which is what it received rather than what it
    /// promised. Falls back to the promise before maturity, when nothing is payable yet.
    pub fn payable(&self) -> Uint128 {
        self.scrt_realised.unwrap_or(self.scrt_owed)
    }

    /// SCRT still to be paid out.
    pub fn outstanding(&self) -> Uint128 {
        self.payable().saturating_sub(self.scrt_claimed)
    }
}

/// A single user's claim against one window.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct UserClaim {
    pub window_id: u64,
    pub shares_burned: Uint128,
    pub scrt_owed: Uint128,
    pub matures_at: u64,
    pub state: WindowState,
    pub claimed: bool,
}

/// Protocol parameters.
///
/// Only `performance_fee_bps` is reachable by the manager. Every other field changes by
/// replacing the code, which the network gates behind a governance vote.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct ProtocolParams {
    /// Length of an unbonding window.
    ///
    /// Concurrent unbonding entries per validator are `ceil(unbonding_period / window)`,
    /// plus one slot of margin for a maturity that lands late. Against the chain's 21-day
    /// period and its limit of 7 entries: a 3-day window needs 8 slots and is illegal, a
    /// 4-day window needs 7 and leaves no headroom, and a 5-day window needs 6 — which is
    /// why 5 days is the default.
    ///
    /// The cost is bounded: withdrawals still complete in 21 days at best and 26 at worst.
    pub unbond_window_secs: u64,
    /// Mirror of the chain's `unbonding_time` staking parameter, used to predict
    /// maturity. Must be kept in sync with the chain by governance.
    pub unbonding_period_secs: u64,
    /// Protocol cut of *staking rewards* (never of principal), taken at compound time.
    pub performance_fee_bps: u16,
    /// Optional fee on withdrawal. Defaults to zero.
    pub withdrawal_fee_bps: u16,
    /// Smallest accepted deposit. Guards against dust deposits that would round to zero
    /// shares and against griefing the window bookkeeping.
    pub min_deposit: Uint128,
    /// How long cached totals stay usable.
    ///
    /// If the cache is older than this, `Deposit` and unbond requests are rejected. This
    /// is what stops someone from front-running an unsynced slashing event and minting at
    /// a stale — and therefore too favourable — exchange rate.
    pub sync_stale_after_secs: u64,
    /// Protocol-side ceiling on concurrent unbonding entries per validator, kept strictly
    /// below the chain's `max_entries = 7`.
    pub max_unbond_entries_per_validator: u8,
}

/// Bounds on what the manager may do, fixed by the network.
///
/// The manager runs the protocol day to day and must never be able to extract value from
/// it. The fee ceiling is the obvious half. The weight ceiling is the half that matters
/// more: without it a manager could route the entire stake to a validator they operate and
/// take the whole yield as validator commission, having never touched a single user token.
/// The allowlist closes the same hole from the other side — the manager picks *among* the
/// network's validators, never *which* validators exist.
///
/// Changing any of it requires a new code version, which requires a governance vote.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct ManagerLimits {
    /// Highest performance fee the manager may set.
    pub max_performance_fee_bps: u16,
    /// Largest share of stake any single validator may be assigned.
    pub max_validator_weight_bps: u16,
}

/// Public, unauthenticated view of the protocol's configuration.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct ConfigResponse {
    /// Sets the fee and the distribution across validators, within `limits`. The only
    /// address with any authority over this contract.
    pub manager: Addr,
    pub limits: ManagerLimits,
    /// Validators the manager may assign weight to. Fixed by the network.
    pub validator_allowlist: Vec<String>,
    /// True once the derivative token has been bound. Until then the deployer holds a
    /// single-use right to bind it; afterwards nobody holds any right at all.
    pub bootstrapped: bool,
    pub treasury: Addr,
    pub token: Option<ContractInfo>,
    pub bonded_denom: String,
    pub params: ProtocolParams,
    pub paused: bool,
}

/// Address plus code hash — Secret requires the code hash for every cross-contract call.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct ContractInfo {
    pub address: Addr,
    pub code_hash: String,
}

/// Public, unauthenticated view of protocol state.
///
/// Every field here is already observable on-chain (delegations and native balances are
/// public on Secret), so exposing it leaks nothing that a block explorer would not.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct StateResponse {
    /// Sum of the last synced bonded amounts across all validators.
    pub total_bonded: Uint128,
    /// Rewards accrued but not yet withdrawn, as of the last sync.
    pub pending_rewards: Uint128,
    /// Contract-held SCRT that is not yet delegated and not owed to a window.
    pub liquid_unallocated: Uint128,
    /// SCRT owed to unbonding and matured windows.
    pub scrt_owed_to_windows: Uint128,
    /// Derivative token supply, mirrored from the token contract at each sync.
    pub total_supply: Uint128,
    pub last_sync_time: u64,
    /// True when the cache is too old to price deposits or withdrawals against.
    /// Nobody has run upkeep within `sync_stale_after_secs`.
    ///
    /// A health signal, not a gate. Deposits, withdrawals and claims all do their own
    /// bookkeeping, so this costs yield — rewards sitting unharvested — rather than
    /// access to anyone's money.
    pub is_unattended: bool,
    /// SCRT per derivative token, scaled by 10^18.
    pub exchange_rate: Uint128,
}

/// One step of a governance-approved rebalancing plan.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct RedelegateStep {
    pub src_validator: String,
    pub dst_validator: String,
    pub amount: Uint128,
}
