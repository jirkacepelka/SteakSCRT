use cosmwasm_std::{StdError, Uint128};
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("unauthorized")]
    Unauthorized,

    #[error("deposits are paused")]
    Paused,

    #[error("derivative token is not registered yet")]
    TokenNotRegistered,

    #[error("derivative token is already registered")]
    TokenAlreadyRegistered,

    #[error("expected exactly one coin of denom {expected}")]
    WrongDenom { expected: String },

    #[error("deposit of {sent} is below the minimum of {min}")]
    DepositTooSmall { sent: Uint128, min: Uint128 },

    #[error("amount rounds to zero shares")]
    ZeroShares,

    /// The deposit would push the protocol past the ceiling compiled into the contract.
    ///
    /// Deposits only. Withdrawals and claims are never gated by this, so a full protocol
    /// stops taking money in rather than trapping what it already holds.
    #[error("deposit would take the derivative supply to {would_mint}, above the {cap} ceiling")]
    CapExceeded { would_mint: Uint128, cap: Uint128 },

    #[error("amount must be greater than zero")]
    ZeroAmount,

    #[error("validator weights must sum to 10000 bps, got {got}")]
    BadWeightSum { got: u32 },

    #[error("validator set must not be empty")]
    EmptyValidatorSet,

    /// The staking module would not answer for a validator during a pricing refresh.
    ///
    /// Deliberately fatal rather than falling back to the cached figure. If that validator
    /// had just been slashed, the cached number is exactly the one an arbitrageur wants
    /// the pool priced against — refusing costs liveness for as long as the fault lasts,
    /// where guessing costs the holders who stayed. Claims on matured windows do not
    /// refresh and so keep paying out regardless.
    #[error("could not read the delegation to {address}: {reason}")]
    ValidatorUnreadable { address: String, reason: String },

    /// Every deposit and withdrawal re-reads the whole set, so its size is a gas cost
    /// users pay. Bounded in code rather than left to configuration.
    #[error("validator set of {got} exceeds the maximum of {max}")]
    TooManyValidators { got: usize, max: usize },

    #[error("duplicate validator {address}")]
    DuplicateValidator { address: String },

    #[error("unknown validator {address}")]
    UnknownValidator { address: String },

    /// The manager tried to use a validator the network has not approved.
    ///
    /// Without this the manager could introduce a validator they operate and take the
    /// protocol's whole yield as validator commission, having never moved a user token.
    #[error("validator {address} is not on the allowlist")]
    ValidatorNotAllowed { address: String },

    #[error("weight of {got} bps for {address} exceeds the {max} bps per-validator ceiling")]
    WeightTooHigh { address: String, got: u16, max: u16 },

    #[error("a manager limit exceeds the ceiling compiled into the contract")]
    LimitsExceedCode,

    #[error("validator {address} still has {bonded} bonded and cannot be removed outright")]
    ValidatorNotDrained { address: String, bonded: Uint128 },

    /// Raised when no validator can absorb an undelegation without exceeding the
    /// protocol's per-validator entry ceiling.
    #[error("no validator has unbonding capacity left; retry after an existing entry matures")]
    NoUnbondingCapacity,

    #[error("window {id} is not open")]
    WindowNotOpen { id: u64 },

    #[error("window {id} has not closed yet (closes at {closes_at}, now {now})")]
    WindowNotClosed { id: u64, closes_at: u64, now: u64 },

    #[error("window {id} has not matured yet (matures at {matures_at}, now {now})")]
    WindowNotMatured { id: u64, matures_at: u64, now: u64 },

    #[error("nothing to claim")]
    NothingToClaim,

    #[error("claim for window {id} was already paid out")]
    AlreadyClaimed { id: u64 },

    #[error("performance fee of {got} bps exceeds the {max} bps ceiling")]
    FeeTooHigh { got: u16, max: u16 },

    #[error("unbond window of {got}s would allow {entries} concurrent unbonding entries, above the protocol ceiling of {max}")]
    WindowTooShort { got: u64, entries: u32, max: u8 },

    #[error("max_unbond_entries_per_validator of {got} must be between 1 and {max} (the chain's limit is 7)")]
    BadEntryCeiling { got: u8, max: u8 },

    #[error("insufficient contract balance: needed {needed}, available {available}")]
    InsufficientBalance { needed: Uint128, available: Uint128 },

    #[error("arithmetic overflow in {context}")]
    Overflow { context: &'static str },
}

impl From<ContractError> for StdError {
    fn from(err: ContractError) -> Self {
        match err {
            ContractError::Std(e) => e,
            other => StdError::generic_err(other.to_string()),
        }
    }
}
