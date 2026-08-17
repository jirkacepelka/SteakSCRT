//! Persistent storage layout.
//!
//! Secret encrypts contract state, but encryption is not authorisation: anything returned
//! by a query is readable by whoever can make that query. Per-user data therefore lives
//! under a per-address suffix and is only ever served behind a viewing key or a permit.

use cosmwasm_std::{Addr, Storage, Uint128};
use schemars::JsonSchema;
use secret_toolkit::serialization::Json;
use secret_toolkit::storage::{AppendStore, Item, Keymap};
use serde::{Deserialize, Serialize};

use lst_types::core::types::{
    ConfigResponse, ContractInfo, ManagerLimits, ProtocolParams, UnbondWindow, ValidatorEntry,
};

use crate::error::ContractError;

pub const KEY_CONFIG: &[u8] = b"config";
pub const KEY_VALIDATORS: &[u8] = b"validators";
pub const KEY_TOTALS: &[u8] = b"totals";
pub const KEY_WINDOWS: &[u8] = b"windows";
pub const KEY_OPEN_WINDOW: &[u8] = b"open_window";
pub const KEY_NEXT_WINDOW_ID: &[u8] = b"next_window_id";
pub const KEY_SYNC_CURSOR: &[u8] = b"sync_cursor";
pub const KEY_ACTIVE_WINDOWS: &[u8] = b"active_windows";
pub const KEY_ALLOWLIST: &[u8] = b"validator_allowlist";
pub const KEY_CLAIMS: &[u8] = b"claims";
pub const KEY_CLAIM_INDEX: &[u8] = b"claim_index";

pub static CONFIG: Item<Config> = Item::new(KEY_CONFIG);
/// The validator set is a single vector rather than a map: it holds ten to twenty entries,
/// and every routine that touches it (selection, sync, rebalancing) iterates the whole
/// thing anyway.
pub static VALIDATORS: Item<Vec<ValidatorEntry>, Json> = Item::new(KEY_VALIDATORS);
pub static TOTALS: Item<TotalsCache> = Item::new(KEY_TOTALS);
pub static WINDOWS: Keymap<u64, UnbondWindow, Json> = Keymap::new(KEY_WINDOWS);
/// Id of the window currently accepting withdrawal requests.
pub static OPEN_WINDOW: Item<u64> = Item::new(KEY_OPEN_WINDOW);
pub static NEXT_WINDOW_ID: Item<u64> = Item::new(KEY_NEXT_WINDOW_ID);
/// Index into `VALIDATORS` at which the next paginated `Sync` or `Compound` resumes.
pub static SYNC_CURSOR: Item<u32> = Item::new(KEY_SYNC_CURSOR);
/// Ids of windows that are unbonding or matured but not yet drained.
///
/// A short list — the unbonding pipeline holds at most `ceil(period / window)` entries,
/// plus however many matured windows still have unclaimed money. Keeping it separate
/// means `CollectMatured` never has to walk every window ever opened.
pub static ACTIVE_WINDOWS: Item<Vec<u64>> = Item::new(KEY_ACTIVE_WINDOWS);
/// Validators the manager is permitted to assign weight to.
///
/// Kept separate from the working validator set: a validator dropped from the allowlist
/// still holds stake and has to be drained, so the two lists legitimately diverge for
/// weeks at a time.
pub static ALLOWLIST: Item<Vec<String>, Json> = Item::new(KEY_ALLOWLIST);

/// Per-user claim against a single window, stored under a per-address suffix.
pub static CLAIMS: Keymap<u64, ClaimRecord> = Keymap::new(KEY_CLAIMS);
/// Window ids a user has a claim in, so that `PendingClaims` does not have to scan every
/// window ever opened.
pub static CLAIM_INDEX: AppendStore<u64> = AppendStore::new(KEY_CLAIM_INDEX);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct Config {
    /// Runs the protocol day to day, within `limits`. The only address this contract
    /// grants any authority to.
    ///
    /// Everything else — the parameters, the allowlist, the treasury, and who the manager
    /// is — changes only by replacing the code, which the network gates behind a
    /// governance vote. There is deliberately no second key that can change the rules.
    pub manager: Addr,
    /// Whoever instantiated the contract, retained solely so they can bind the derivative
    /// token once.
    ///
    /// The binding cannot happen at instantiation because the contract and its token each
    /// need the other's address. Cleared by `Bootstrap`, after which no address holds this
    /// right and the token can never be re-pointed.
    pub deployer: Option<Addr>,
    pub limits: ManagerLimits,
    pub treasury: Addr,
    /// `None` until `RegisterToken` binds the derivative token. Deposits are refused
    /// while unset.
    pub token: Option<ContractInfo>,
    pub bonded_denom: String,
    pub params: ProtocolParams,
    pub paused: bool,
}

impl Config {
    pub fn into_response(self, allowlist: Vec<String>) -> ConfigResponse {
        ConfigResponse {
            manager: self.manager,
            limits: self.limits,
            validator_allowlist: allowlist,
            bootstrapped: self.deployer.is_none(),
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
    /// Owed to the open window. Its SCRT has been priced and its shares burned, but the
    /// stake is still delegated, so the money is still inside `total_bonded`.
    pub scrt_owed_open: Uint128,
    /// Owed to windows whose undelegation is in flight. This SCRT is in neither
    /// `total_bonded` nor the contract's balance — the staking module is holding it.
    pub scrt_owed_unbonding: Uint128,
    /// Owed to matured windows. This SCRT has arrived and is sitting in the balance.
    pub scrt_owed_matured: Uint128,
    pub last_sync_time: u64,
}

impl TotalsCache {
    /// Window liabilities whose SCRT is still counted in `total_bonded` or the balance,
    /// and which therefore must be subtracted when pricing.
    ///
    /// Excludes the in-flight leg on purpose: that SCRT has already left `total_bonded`
    /// and has not yet reached the balance, so subtracting it would remove the same money
    /// twice and collapse the rate for the holders who stayed.
    pub fn owed_backed(&self) -> Uint128 {
        self.scrt_owed_open + self.scrt_owed_matured
    }

    /// Everything still owed to withdrawers, across all three phases. Reporting only.
    pub fn owed_total(&self) -> Uint128 {
        self.scrt_owed_open + self.scrt_owed_unbonding + self.scrt_owed_matured
    }

    /// Whether the cache has gone unrefreshed for longer than the protocol expects.
    ///
    /// No longer a gate on anything: deposits and withdrawals refresh the cache in their
    /// own transaction, so nothing prices against this. It survives as a health signal —
    /// a stale cache means nobody has compounded lately, which costs yield rather than
    /// correctness, and both the keeper and the app surface it as such.
    pub fn is_unattended(&self, now: u64, max_age: u64) -> bool {
        now.saturating_sub(self.last_sync_time) > max_age
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
        assert!(!c.is_unattended(1_000 + 7_200, 7_200));
        assert!(c.is_unattended(1_000 + 7_201, 7_200));
    }

    #[test]
    fn a_clock_that_runs_backwards_does_not_wrap_into_staleness() {
        // Block time should never go backwards, but saturating arithmetic here means a
        // chain quirk degrades to "fresh" rather than to an underflow panic.
        let c = cache(5_000);
        assert!(!c.is_unattended(4_000, 7_200));
    }
}
