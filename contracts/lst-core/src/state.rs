//! Persistent storage layout.
//!
//! Secret encrypts contract state, but encryption is not authorisation: anything returned
//! by a query is readable by whoever can make that query. Per-user data therefore lives
//! under a per-address suffix and is only ever served behind a viewing key or a permit.

use cosmwasm_std::{Addr, Storage, Uint128};
use schemars::JsonSchema;
use secret_toolkit::storage::{AppendStore, Item, Keymap};
use serde::{Deserialize, Serialize};

use lst_types::core::types::{
    ConfigResponse, ContractInfo, ProtocolParams, UnbondWindow, ValidatorEntry,
};

use crate::error::ContractError;

pub const KEY_CONFIG: &[u8] = b"config";
pub const KEY_VALIDATORS: &[u8] = b"validators";
pub const KEY_TOTALS: &[u8] = b"totals";
pub const KEY_WINDOWS: &[u8] = b"windows";
pub const KEY_OPEN_WINDOW: &[u8] = b"open_window";
pub const KEY_NEXT_WINDOW_ID: &[u8] = b"next_window_id";
pub const KEY_SYNC_CURSOR: &[u8] = b"sync_cursor";
pub const KEY_CLAIMS: &[u8] = b"claims";
pub const KEY_CLAIM_INDEX: &[u8] = b"claim_index";

pub static CONFIG: Item<Config> = Item::new(KEY_CONFIG);
/// The validator set is a single vector rather than a map: it holds ten to twenty entries,
/// and every routine that touches it (selection, sync, rebalancing) iterates the whole
/// thing anyway.
pub static VALIDATORS: Item<Vec<ValidatorEntry>> = Item::new(KEY_VALIDATORS);
pub static TOTALS: Item<TotalsCache> = Item::new(KEY_TOTALS);
pub static WINDOWS: Keymap<u64, UnbondWindow> = Keymap::new(KEY_WINDOWS);
/// Id of the window currently accepting withdrawal requests.
pub static OPEN_WINDOW: Item<u64> = Item::new(KEY_OPEN_WINDOW);
pub static NEXT_WINDOW_ID: Item<u64> = Item::new(KEY_NEXT_WINDOW_ID);
/// Index into `VALIDATORS` at which the next paginated `Sync` or `Compound` resumes.
pub static SYNC_CURSOR: Item<u32> = Item::new(KEY_SYNC_CURSOR);

/// Per-user claim against a single window, stored under a per-address suffix.
pub static CLAIMS: Keymap<u64, ClaimRecord> = Keymap::new(KEY_CLAIMS);
/// Window ids a user has a claim in, so that `PendingClaims` does not have to scan every
/// window ever opened.
pub static CLAIM_INDEX: AppendStore<u64> = AppendStore::new(KEY_CLAIM_INDEX);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct Config {
    pub admin: Addr,
    pub gov: Addr,
    pub treasury: Addr,
    /// `None` until `RegisterToken` binds the derivative token. Deposits are refused
    /// while unset.
    pub token: Option<ContractInfo>,
    pub bonded_denom: String,
    pub params: ProtocolParams,
    pub paused: bool,
}

impl Config {
    pub fn into_response(self) -> ConfigResponse {
        ConfigResponse {
            admin: self.admin,
            gov: self.gov,
            treasury: self.treasury,
            token: self.token,
            bonded_denom: self.bonded_denom,
            params: self.params,
            paused: self.paused,
        }
    }

    pub fn token(&self) -> Result<&ContractInfo, ContractError> {
        self.token.as_ref().ok_or(ContractError::TokenNotRegistered)
    }
}

/// Cached view of everything needed to price a deposit or a withdrawal.
///
/// This is a cache of on-chain truth, not the truth itself. `Sync` and `Compound` rewrite
/// `total_bonded` from `StakingQuery::Delegation` rather than adjusting it arithmetically,
/// which is what lets a slashing event show up instead of being assumed away.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default, JsonSchema)]
pub struct TotalsCache {
    pub total_bonded: Uint128,
    pub pending_rewards: Uint128,
    /// Mirrored from the token contract at each sync.
    pub total_supply: Uint128,
    /// SCRT promised to unbonding and matured windows. Held by the contract or in flight
    /// from the staking module, and excluded from the assets backing the live supply.
    pub scrt_owed_to_windows: Uint128,
    pub last_sync_time: u64,
}

impl TotalsCache {
    /// Whether the cache is too old to price against.
    pub fn is_stale(&self, now: u64, max_age: u64) -> bool {
        now.saturating_sub(self.last_sync_time) > max_age
    }

    /// Fail unless the cache is fresh.
    ///
    /// Deposits and withdrawal requests both go through this. Refusing is strictly better
    /// than pricing against a cache that predates a slashing event, which is exactly the
    /// window an arbitrageur would aim for.
    pub fn assert_fresh(&self, now: u64, max_age: u64) -> Result<(), ContractError> {
        if self.is_stale(now, max_age) {
            return Err(ContractError::StaleTotals {
                last_sync: self.last_sync_time,
                now,
                max_age,
            });
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct ClaimRecord {
    pub window_id: u64,
    pub shares_burned: Uint128,
    pub scrt_owed: Uint128,
    pub claimed: bool,
}

/// Claims storage scoped to one account.
pub fn claims_for(account: &Addr) -> Keymap<'static, u64, ClaimRecord> {
    CLAIMS.add_suffix(account.as_bytes())
}

/// Claim index scoped to one account.
pub fn claim_index_for(account: &Addr) -> AppendStore<'static, u64> {
    CLAIM_INDEX.add_suffix(account.as_bytes())
}

/// Allocate a fresh window id.
pub fn next_window_id(storage: &mut dyn Storage) -> Result<u64, ContractError> {
    let id = NEXT_WINDOW_ID.may_load(storage)?.unwrap_or(0);
    NEXT_WINDOW_ID.save(storage, &(id + 1))?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache(last_sync: u64) -> TotalsCache {
        TotalsCache {
            last_sync_time: last_sync,
            ..Default::default()
        }
    }

    #[test]
    fn freshness_is_inclusive_at_the_boundary() {
        let c = cache(1_000);
        // Exactly at the limit still counts as fresh.
        assert!(!c.is_stale(1_000 + 7_200, 7_200));
        assert!(c.is_stale(1_000 + 7_201, 7_200));
    }

    #[test]
    fn a_clock_that_runs_backwards_does_not_wrap_into_staleness() {
        // Block time should never go backwards, but saturating arithmetic here means a
        // chain quirk degrades to "fresh" rather than to an underflow panic.
        let c = cache(5_000);
        assert!(!c.is_stale(4_000, 7_200));
    }

    #[test]
    fn assert_fresh_reports_the_numbers_needed_to_diagnose_it() {
        let c = cache(100);
        let err = c.assert_fresh(10_000, 7_200).unwrap_err();
        assert_eq!(
            err,
            ContractError::StaleTotals {
                last_sync: 100,
                now: 10_000,
                max_age: 7_200,
            }
        );
    }
}
