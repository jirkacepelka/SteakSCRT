//! Validator set validation and stake placement.
//!
//! Pure functions over an already-loaded set, so the interesting cases — a drained
//! validator, an entry ceiling reached mid-plan, a set that no longer sums to 100% —
//! are unit-testable without a chain.

use cosmwasm_std::Uint128;
use std::collections::HashSet;

use lst_types::core::types::{ValidatorEntry, ValidatorInit, ValidatorStatus, BPS_DENOM};

use crate::error::ContractError;

/// Reject a validator set that cannot be used safely.
///
/// Weights are required to sum to exactly 100% of active stake rather than being
/// normalised on the fly: a set that silently renormalises hides a governance typo until
/// it has already moved stake.
pub fn validate_set(validators: &[ValidatorInit]) -> Result<(), ContractError> {
    if validators.is_empty() {
        return Err(ContractError::EmptyValidatorSet);
    }

    let mut seen = HashSet::with_capacity(validators.len());
    for v in validators {
        if !seen.insert(v.address.as_str()) {
            return Err(ContractError::DuplicateValidator {
                address: v.address.clone(),
            });
        }
    }

    let sum: u32 = validators.iter().map(|v| u32::from(v.weight_bps)).sum();
    if sum != u32::from(BPS_DENOM) {
        return Err(ContractError::BadWeightSum { got: sum });
    }

    Ok(())
}

/// Reject a weight assignment the manager is not entitled to make.
///
/// This is the boundary that makes the manager role safe to hand out. Without the
/// allowlist check a manager could introduce a validator they operate; without the per-
/// validator ceiling they could route the whole stake to one of the approved validators
/// that happens to be theirs. Either way they would take the entire yield as validator
/// commission without ever touching a user's token, and no amount of care elsewhere in
/// the contract would notice.
pub fn validate_managed_weights(
    weights: &[ValidatorInit],
    allowlist: &[String],
    max_weight_bps: u16,
) -> Result<(), ContractError> {
    validate_set(weights)?;

    for w in weights {
        if !allowlist.iter().any(|a| a == &w.address) {
            return Err(ContractError::ValidatorNotAllowed {
                address: w.address.clone(),
            });
        }
        if w.weight_bps > max_weight_bps {
            return Err(ContractError::WeightTooHigh {
                address: w.address.clone(),
                got: w.weight_bps,
                max: max_weight_bps,
            });
        }
    }

    Ok(())
}

/// Apply a new weight assignment to the working set.
///
/// Validators that keep a weight stay `Active`. Validators that lose their place move to
/// `Draining` rather than disappearing: their stake cannot be recalled synchronously, so
/// they stop receiving new delegations and are emptied first on the way out. Only once
/// drained do they become `Removed`. Newly weighted validators are appended.
pub fn apply_weights(set: &mut Vec<ValidatorEntry>, weights: &[ValidatorInit]) {
    for entry in set.iter_mut() {
        match weights.iter().find(|w| w.address == entry.address) {
            Some(w) => {
                entry.weight_bps = w.weight_bps;
                entry.status = ValidatorStatus::Active;
            }
            None => {
                entry.weight_bps = 0;
                entry.status = if entry.bonded.is_zero() {
                    ValidatorStatus::Removed
                } else {
                    ValidatorStatus::Draining
                };
            }
        }
    }

    for w in weights {
        if !set.iter().any(|e| e.address == w.address) {
            set.push(ValidatorEntry {
                address: w.address.clone(),
                weight_bps: w.weight_bps,
                status: ValidatorStatus::Active,
                bonded: Uint128::zero(),
                pending_rewards: Uint128::zero(),
                active_unbond_entries: 0,
            });
        }
    }
}

/// Total stake currently bonded across the whole set, draining validators included.
pub fn total_bonded(validators: &[ValidatorEntry]) -> Uint128 {
    validators
        .iter()
        .fold(Uint128::zero(), |acc, v| acc + v.bonded)
}

/// Index of the validator that should receive the next delegation.
///
/// Picks the validator furthest below its target share. Placing the whole deposit with a
/// single validator, rather than splitting it proportionally, keeps deposits at one
/// `Delegate` message each; the set converges on its target weights across many deposits
/// instead of within each one.
pub fn select_for_delegation(
    validators: &[ValidatorEntry],
    incoming: Uint128,
) -> Result<usize, ContractError> {
    let pool_after = total_bonded(validators)
        .checked_add(incoming)
        .map_err(|_| ContractError::Overflow {
            context: "delegation target",
        })?;

    let mut best: Option<(usize, Uint128)> = None;

    for (idx, v) in validators.iter().enumerate() {
        if !v.status.accepts_stake() {
            continue;
        }

        // Deficit against target. Validators already at or above target score zero and
        // only win if nothing else is available.
        let target = pool_after.multiply_ratio(u128::from(v.weight_bps), u128::from(BPS_DENOM));
        let deficit = target.saturating_sub(v.bonded);

        match best {
            Some((_, best_deficit)) if deficit <= best_deficit => {}
            _ => best = Some((idx, deficit)),
        }
    }

    best.map(|(idx, _)| idx)
        .ok_or(ContractError::EmptyValidatorSet)
}

/// One leg of an undelegation, as an index into the validator set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UnbondLeg {
    pub index: usize,
    pub amount: Uint128,
}

/// Spread an undelegation across the set.
///
/// Order of preference:
/// 1. `Draining` validators, so that a validator governance wants gone actually empties;
/// 2. validators furthest *above* their target weight, which rebalances for free.
///
/// Validators that have reached `max_entries_per_validator` are skipped entirely. That
/// ceiling is kept below the chain's limit of 7, so skipping here is what prevents an
/// `Undelegate` from being rejected on-chain and wedging the whole withdrawal pipeline.
pub fn plan_undelegation(
    validators: &[ValidatorEntry],
    amount: Uint128,
    max_entries_per_validator: u8,
) -> Result<Vec<UnbondLeg>, ContractError> {
    if amount.is_zero() {
        return Ok(Vec::new());
    }

    let pool = total_bonded(validators);

    let mut candidates: Vec<(usize, u8, Uint128, Uint128)> = validators
        .iter()
        .enumerate()
        .filter(|(_, v)| !v.bonded.is_zero() && v.active_unbond_entries < max_entries_per_validator)
        .map(|(idx, v)| {
            let drain_first = u8::from(v.status == ValidatorStatus::Active);
            let target = pool.multiply_ratio(u128::from(v.weight_bps), u128::from(BPS_DENOM));
            let surplus = v.bonded.saturating_sub(target);
            (idx, drain_first, surplus, v.bonded)
        })
        .collect();

    // Draining validators first (drain_first == 0), then by surplus, then by size so the
    // ordering is total and the plan is deterministic.
    candidates.sort_by(|a, b| {
        a.1.cmp(&b.1)
            .then(b.2.cmp(&a.2))
            .then(b.3.cmp(&a.3))
            .then(a.0.cmp(&b.0))
    });

    let mut legs = Vec::new();
    let mut remaining = amount;

    for (idx, _, _, bonded) in candidates {
        if remaining.is_zero() {
            break;
        }
        let take = remaining.min(bonded);
        if take.is_zero() {
            continue;
        }
        legs.push(UnbondLeg {
            index: idx,
            amount: take,
        });
        remaining -= take;
    }

    if !remaining.is_zero() {
        // Either the set is genuinely out of stake, or every validator holding stake has
        // used up its entry slots. Both are worth failing loudly: silently unbonding less
        // than a window owes would under-fund the claims that window already priced.
        return Err(ContractError::NoUnbondingCapacity);
    }

    Ok(legs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(addr: &str, weight_bps: u16, bonded: u128, status: ValidatorStatus) -> ValidatorEntry {
        ValidatorEntry {
            address: addr.to_string(),
            weight_bps,
            status,
            bonded: Uint128::new(bonded),
            pending_rewards: Uint128::zero(),
            active_unbond_entries: 0,
        }
    }

    fn active(addr: &str, weight_bps: u16, bonded: u128) -> ValidatorEntry {
        entry(addr, weight_bps, bonded, ValidatorStatus::Active)
    }

    fn init(addr: &str, weight_bps: u16) -> ValidatorInit {
        ValidatorInit {
            address: addr.to_string(),
            weight_bps,
        }
    }

    // ---- validate_set ----

    #[test]
    fn a_well_formed_set_is_accepted() {
        assert!(validate_set(&[init("a", 5_000), init("b", 5_000)]).is_ok());
    }

    #[test]
    fn an_empty_set_is_rejected() {
        assert_eq!(validate_set(&[]), Err(ContractError::EmptyValidatorSet));
    }

    #[test]
    fn weights_that_miss_one_hundred_percent_are_rejected() {
        // A single dropped digit is the realistic governance mistake here.
        assert_eq!(
            validate_set(&[init("a", 5_000), init("b", 500)]),
            Err(ContractError::BadWeightSum { got: 5_500 })
        );
    }

    #[test]
    fn duplicate_validators_are_rejected() {
        assert_eq!(
            validate_set(&[init("a", 5_000), init("a", 5_000)]),
            Err(ContractError::DuplicateValidator {
                address: "a".to_string()
            })
        );
    }

    // ---- select_for_delegation ----

    #[test]
    fn stake_goes_to_the_most_underweight_validator() {
        let set = vec![
            active("a", 5_000, 900),
            active("b", 3_000, 100),
            active("c", 2_000, 0),
        ];
        // Pool after the deposit is 1100, so targets are 550 / 330 / 220 and the
        // shortfalls are 0 / 230 / 220. "b" is furthest behind.
        assert_eq!(select_for_delegation(&set, Uint128::new(100)).unwrap(), 1);
    }

    #[test]
    fn underweight_is_measured_in_absolute_scrt_not_as_a_ratio() {
        // "b" is at 30% of its target while "c" is at 0% of its, so a ratio-based rule
        // would pick "c". Absolute shortfall is the right metric: it is the one that
        // shrinks the set's total distance from its target weights fastest, and a ratio
        // rule would keep funnelling deposits into whichever validator happens to be
        // smallest regardless of how little that fixes.
        let set = vec![
            active("a", 5_000, 900),
            active("b", 3_000, 100),
            active("c", 2_000, 0),
        ];
        let picked = select_for_delegation(&set, Uint128::new(100)).unwrap();
        assert_eq!(set[picked].address, "b");
    }

    #[test]
    fn an_empty_set_still_places_the_first_deposit() {
        let set = vec![active("a", 6_000, 0), active("b", 4_000, 0)];
        // Nothing is bonded yet, so the largest target wins.
        assert_eq!(select_for_delegation(&set, Uint128::new(1_000)).unwrap(), 0);
    }

    #[test]
    fn draining_validators_never_receive_new_stake() {
        let set = vec![
            entry("a", 0, 0, ValidatorStatus::Draining),
            active("b", 10_000, 5_000),
        ];
        assert_eq!(select_for_delegation(&set, Uint128::new(100)).unwrap(), 1);
    }

    #[test]
    fn a_set_with_no_active_validators_cannot_take_a_deposit() {
        let set = vec![
            entry("a", 0, 100, ValidatorStatus::Draining),
            entry("b", 0, 0, ValidatorStatus::Removed),
        ];
        assert_eq!(
            select_for_delegation(&set, Uint128::new(100)),
            Err(ContractError::EmptyValidatorSet)
        );
    }

    // ---- plan_undelegation ----

    #[test]
    fn undelegation_takes_from_the_most_overweight_validator_first() {
        let set = vec![active("a", 5_000, 8_000), active("b", 5_000, 2_000)];
        let legs = plan_undelegation(&set, Uint128::new(1_000), 6).unwrap();
        assert_eq!(
            legs,
            vec![UnbondLeg {
                index: 0,
                amount: Uint128::new(1_000)
            }]
        );
    }

    #[test]
    fn draining_validators_are_emptied_before_healthy_ones() {
        let set = vec![
            active("a", 10_000, 9_000),
            entry("b", 0, 1_000, ValidatorStatus::Draining),
        ];
        let legs = plan_undelegation(&set, Uint128::new(1_500), 6).unwrap();
        assert_eq!(legs[0].index, 1);
        assert_eq!(legs[0].amount, Uint128::new(1_000));
        assert_eq!(legs[1].index, 0);
        assert_eq!(legs[1].amount, Uint128::new(500));
    }

    #[test]
    fn an_undelegation_spills_over_when_one_validator_cannot_cover_it() {
        let set = vec![
            active("a", 5_000, 1_000),
            active("b", 3_000, 800),
            active("c", 2_000, 500),
        ];
        let legs = plan_undelegation(&set, Uint128::new(2_000), 6).unwrap();
        let total: Uint128 = legs.iter().map(|l| l.amount).sum();
        assert_eq!(total, Uint128::new(2_000));
        // Never more than a validator actually holds.
        for leg in &legs {
            assert!(leg.amount <= set[leg.index].bonded);
        }
    }

    #[test]
    fn validators_at_their_entry_ceiling_are_skipped() {
        let mut set = vec![active("a", 5_000, 10_000), active("b", 5_000, 3_000)];
        set[0].active_unbond_entries = 6; // at the ceiling

        let legs = plan_undelegation(&set, Uint128::new(1_000), 6).unwrap();
        assert_eq!(
            legs,
            vec![UnbondLeg {
                index: 1,
                amount: Uint128::new(1_000)
            }],
            "the overweight validator is out of entry slots, so 'b' has to absorb it"
        );
    }

    #[test]
    fn running_out_of_entry_slots_everywhere_fails_loudly() {
        // Under-unbonding would leave a window owing more than it can pay, so this must
        // be an error rather than a partial plan.
        let mut set = vec![active("a", 5_000, 10_000), active("b", 5_000, 10_000)];
        set[0].active_unbond_entries = 6;
        set[1].active_unbond_entries = 6;

        assert_eq!(
            plan_undelegation(&set, Uint128::new(1_000), 6),
            Err(ContractError::NoUnbondingCapacity)
        );
    }

    #[test]
    fn asking_for_more_than_is_bonded_fails() {
        let set = vec![active("a", 10_000, 500)];
        assert_eq!(
            plan_undelegation(&set, Uint128::new(1_000), 6),
            Err(ContractError::NoUnbondingCapacity)
        );
    }

    #[test]
    fn a_zero_undelegation_is_a_no_op() {
        let set = vec![active("a", 10_000, 500)];
        assert_eq!(plan_undelegation(&set, Uint128::zero(), 6).unwrap(), vec![]);
    }

    #[test]
    fn the_plan_is_deterministic_for_identical_validators() {
        // Ties must break the same way every run, or two nodes could disagree.
        let set = vec![
            active("a", 3_334, 1_000),
            active("b", 3_333, 1_000),
            active("c", 3_333, 1_000),
        ];
        let first = plan_undelegation(&set, Uint128::new(2_500), 6).unwrap();
        for _ in 0..5 {
            assert_eq!(
                plan_undelegation(&set, Uint128::new(2_500), 6).unwrap(),
                first
            );
        }
    }
}
