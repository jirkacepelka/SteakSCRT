//! Wire messages for the `lst-core` contract.

use cosmwasm_std::{Binary, Uint128};
use schemars::JsonSchema;
use secret_toolkit::permit::Permit;
use serde::{Deserialize, Serialize};

use super::types::{
    ConfigResponse, ManagerLimits, ProtocolParams, RedelegateStep, StateResponse, UnbondWindow,
    UserClaim, ValidatorEntry, ValidatorInit, WindowState,
};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct InstantiateMsg {
    /// Runs the protocol day to day. Defaults to the sender.
    pub manager: Option<String>,
    /// Bounds on what the manager may do. Changing them requires a governance-approved
    /// code version.
    pub limits: ManagerLimits,
    /// Validators the manager may assign weight to. Must contain every validator in
    /// `validators`.
    pub validator_allowlist: Vec<String>,
    /// Recipient of the performance fee.
    pub treasury: String,
    /// Staking denom, `uscrt` on mainnet. Parameterised only so tests can use a devnet denom.
    pub bonded_denom: String,
    pub validators: Vec<ValidatorInit>,
    pub params: ProtocolParams,
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

    // ---- the manager, the only authority this contract recognises ----
    Manager(ManagerMsg),

    /// Emergency stop, available to the manager.
    ///
    /// Blocks `Deposit` only. Claiming matured funds is never pausable, so the worst a
    /// rogue manager achieves is turning away new money — which the network answers by
    /// voting in a version naming a different manager, not a way to trap anyone's funds.
    SetPaused {
        paused: bool,
    },
    /// Bind the derivative token and seed the pool, in one atomic call.
    ///
    /// Callable exactly once, by whoever instantiated the contract, and required before
    /// any deposit is accepted. The right is consumed by the call: the token address and
    /// the derivative token's minter are both fixed forever afterwards, so this is a
    /// deployment step rather than a standing power.
    ///
    /// The attached SCRT is
    /// delegated and its shares are minted to this contract's own address, where no code
    /// path can ever redeem them. Those permanently locked shares are what makes the
    /// classic first-depositor inflation attack uneconomic: an attacker would have to
    /// donate more than the seed to move the exchange rate enough for rounding to swallow
    /// a real deposit.
    ///
    /// Registration and seeding are deliberately not separate messages. Splitting them
    /// would leave a window in which the token exists, deposits are legal, and the pool is
    /// still empty — which is precisely the state the seed exists to prevent.
    Bootstrap {
        token_address: String,
        token_code_hash: String,
    },
}

/// Actions the manager may take.
///
/// Deliberately narrow. Nothing here changes code, changes who holds power, redirects the
/// fee stream, or moves a token belonging to anyone.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ManagerMsg {
    /// Set the target distribution across validators.
    ///
    /// Every address must be on the network's allowlist, no single weight may exceed the
    /// ceiling, and the weights must sum to 10_000.
    SetWeights { weights: Vec<ValidatorInit> },
    /// Set the performance fee, up to the ceiling the network set.
    SetPerformanceFee { bps: u16 },
    /// Move stake between validators to approach the target weights.
    Rebalance { plan: Vec<RedelegateStep> },
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
    /// SNIP-24 permit authenticated query.
    ///
    /// The only authentication this contract accepts. A permit is a signature the user
    /// makes in their wallet: it costs no transaction, stores no shared secret here, and
    /// cannot be replayed against another contract. A viewing key would be a password the
    /// contract has to keep, set by an on-chain transaction, and revocable only by
    /// replacing it.
    ///
    /// One permit covers the whole app, so a user signs once per session rather than once
    /// per screen.
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
        is_unattended: bool,
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
    Bootstrap {
        scrt_seeded: Uint128,
        locked_shares: Uint128,
    },
    Ok {},
}

/// Migration takes no parameters, deliberately.
///
/// A governance proposal approves *which code* runs, not what arguments it runs with:
/// the second step of the flow is an ordinary migrate transaction submitted by the admin
/// relay, and the relay chooses this payload. Any privileged field here would hand the
/// relay authority the network never voted for. Whatever the network decides ships inside
/// the code it approved.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct MigrateMsg {}
