//! Wire messages for the `lst-core` contract.

use cosmwasm_std::{Binary, Uint128};
use schemars::JsonSchema;
use secret_toolkit::permit::Permit;
use serde::{Deserialize, Serialize};

use super::types::{
    ConfigResponse, ProtocolParams, RedelegateStep, StateResponse, UnbondWindow, UserClaim,
    ValidatorEntry, ValidatorInit, WindowState,
};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct InstantiateMsg {
    /// Emergency multisig. May pause deposits and nothing else. Defaults to the sender.
    pub admin: Option<String>,
    /// Governance address — in production this must be the timelock contract. Defaults to
    /// the sender so that deployment can bootstrap, but leaving it there is a rug vector
    /// and the deploy script refuses to finish without handing it over.
    pub gov: Option<String>,
    /// Recipient of the performance fee.
    pub treasury: String,
    /// Staking denom, `uscrt` on mainnet. Parameterised only so tests can use a devnet denom.
    pub bonded_denom: String,
    pub validators: Vec<ValidatorInit>,
    pub params: ProtocolParams,
    /// Entropy for viewing-key generation.
    pub prng_seed: Binary,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecuteMsg {
    // ---- user ----
    /// Deposit native SCRT and receive derivative tokens.
    Deposit {},
    /// SNIP-20 receiver hook. Reaching this with the derivative token registers a
    /// withdrawal request in the currently open window and burns the tokens.
    Receive {
        sender: String,
        from: String,
        amount: Uint128,
        msg: Option<Binary>,
    },
    /// Claim SCRT from windows that have matured. Claims every eligible window when
    /// `window_ids` is omitted.
    ClaimMatured {
        window_ids: Option<Vec<u64>>,
    },

    // ---- viewing-key management (claims are private contract state) ----
    SetViewingKey {
        key: String,
    },
    CreateViewingKey {
        entropy: String,
    },

    // ---- permissionless upkeep, normally driven by the keeper ----
    /// Withdraw rewards, take the performance fee, restake the rest. Paginated over the
    /// validator set because sweeping every validator in one transaction would risk
    /// exceeding the block gas limit.
    Compound {
        limit: Option<u32>,
    },
    /// Close the open window and issue the batched `Undelegate` messages.
    AdvanceWindow {},
    /// Mark windows whose unbonding period has elapsed as claimable.
    CollectMatured {
        limit: Option<u32>,
    },
    /// Refresh cached totals from on-chain staking queries.
    Sync {
        limit: Option<u32>,
    },

    // ---- governance (timelock only) ----
    Gov(GovMsg),

    // ---- admin ----
    /// Emergency stop. Blocks `Deposit` only — claiming matured funds is never pausable,
    /// so a compromised or absent admin can never trap user withdrawals.
    SetPaused {
        paused: bool,
    },
    /// Bind the derivative token contract. One-shot: callable by the admin exactly once,
    /// and only before any tokens exist.
    RegisterToken {
        address: String,
        code_hash: String,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GovMsg {
    UpdateParams {
        params: ProtocolParams,
    },
    /// Replace the validator set wholesale. Weights of active validators must sum to
    /// 10_000. Validators dropped from the set move to `Draining`, not `Removed`.
    SetValidators {
        validators: Vec<ValidatorInit>,
    },
    AddValidator {
        address: String,
        weight_bps: u16,
    },
    /// Move a validator to `Draining`.
    RemoveValidator {
        address: String,
    },
    /// Execute a rebalancing plan as redelegations.
    Rebalance {
        plan: Vec<RedelegateStep>,
    },
    SetTreasury {
        address: String,
    },
    SetGov {
        address: String,
    },
    SetAdmin {
        address: String,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QueryMsg {
    // ---- public ----
    Config {},
    State {},
    ExchangeRate {},
    Validators {},
    Windows {
        state: Option<WindowState>,
        start_after: Option<u64>,
        limit: Option<u32>,
    },

    // ---- authenticated ----
    /// Viewing-key authenticated query.
    PendingClaims {
        address: String,
        key: String,
    },
    /// SNIP-24 permit authenticated query. Preferred over viewing keys: no on-chain
    /// setup transaction and no shared secret stored in the contract.
    WithPermit {
        permit: Permit,
        query: AuthQueryMsg,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AuthQueryMsg {
    PendingClaims {},
}

/// The payload a user attaches to a SNIP-20 `Send` to request a withdrawal.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReceiveHookMsg {
    Unbond {},
}

// ---- query responses ----

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QueryAnswer {
    Config(ConfigResponse),
    State(StateResponse),
    /// SCRT per derivative token, scaled by 10^18.
    ExchangeRate {
        rate: Uint128,
        is_stale: bool,
    },
    Validators {
        validators: Vec<ValidatorEntry>,
    },
    Windows {
        windows: Vec<UnbondWindow>,
    },
    PendingClaims {
        claims: Vec<UserClaim>,
        total_owed: Uint128,
        total_claimable_now: Uint128,
    },
    /// Returned instead of failing when a viewing key does not match, so that a caller
    /// cannot distinguish "wrong key" from "no claims".
    ViewingKeyError {
        msg: String,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecuteAnswer {
    Deposit {
        scrt_deposited: Uint128,
        shares_minted: Uint128,
    },
    Unbond {
        window_id: u64,
        shares_burned: Uint128,
        scrt_owed: Uint128,
        matures_at_estimate: u64,
    },
    ClaimMatured {
        scrt_claimed: Uint128,
        windows_settled: Vec<u64>,
    },
    Compound {
        rewards_withdrawn: Uint128,
        fee_shares_minted: Uint128,
        validators_processed: u32,
        done: bool,
    },
    AdvanceWindow {
        closed_window_id: u64,
        new_window_id: u64,
        scrt_undelegated: Uint128,
    },
    CollectMatured {
        windows_matured: Vec<u64>,
    },
    Sync {
        total_bonded: Uint128,
        validators_processed: u32,
        done: bool,
    },
    CreateViewingKey {
        key: String,
    },
    Ok {},
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MigrateMsg {
    /// No state migration required; only the code changes.
    Noop {},
}
