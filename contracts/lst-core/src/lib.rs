//! `lst-core` — the staking engine of the SCRT liquid staking protocol.
//!
//! Responsibilities:
//! * take native SCRT deposits and mint the derivative token against a slashing-aware
//!   exchange rate,
//! * spread stake across a governed validator set,
//! * batch withdrawals into fixed-length unbonding windows so that the chain's limit of
//!   seven concurrent unbonding entries per validator is never reached,
//! * compound staking rewards and take the protocol's performance fee.

pub mod contract;
pub mod error;
pub mod math;
pub mod state;
pub mod validators;
pub mod windows;

pub use error::ContractError;
