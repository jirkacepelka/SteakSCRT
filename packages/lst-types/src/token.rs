//! The subset of the derivative token's SNIP-20 interface that `lst-core` calls.
//!
//! `secret_toolkit::snip20` already provides helpers for the standard messages, but
//! `lst-core` needs the exact shapes for a few of them (and needs `TokenInfo` to mirror
//! total supply), so they are declared explicitly rather than reconstructed at each call
//! site.

use cosmwasm_std::Uint128;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TokenExecuteMsg {
    /// Mint derivative tokens. `lst-core` is the sole minter.
    Mint {
        recipient: String,
        amount: Uint128,
        memo: Option<String>,
        padding: Option<String>,
    },
    /// Burn tokens the contract holds. Used after a `Send`-driven withdrawal request.
    Burn {
        amount: Uint128,
        memo: Option<String>,
        padding: Option<String>,
    },
    /// Register `lst-core` as a receiver so that `Send` reaches its `Receive` hook.
    RegisterReceive {
        code_hash: String,
        padding: Option<String>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TokenQueryMsg {
    TokenInfo {},
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TokenQueryAnswer {
    TokenInfo {
        name: String,
        symbol: String,
        decimals: u8,
        /// Present only because the derivative token is instantiated with
        /// `public_total_supply = true` — the exchange rate is meaningless without it,
        /// and DEX integrations require it.
        total_supply: Option<Uint128>,
    },
}
