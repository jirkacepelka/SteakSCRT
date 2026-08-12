//! Shared types for the SCRT liquid staking protocol.
//!
//! This crate is the single source of truth for the wire format of every contract in
//! the workspace. It is also the input to the TypeScript codegen used by the keeper
//! bot and the frontend, so anything declared here is a public API surface: changing a
//! variant name is a breaking change for off-chain consumers.

pub mod core;
pub mod token;

pub use crate::core::{msg as core_msg, types as core_types};
