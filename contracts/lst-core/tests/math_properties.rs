//! Property tests for the exchange-rate arithmetic.
//!
//! The scenario tests elsewhere cover the cases someone thought of. These cover the ones
//! nobody did: proptest generates pool shapes across the whole range a real protocol could
//! reach — dust, whole-supply positions, pools lopsided by slashing, liabilities that
//! swallow the assets — and asserts the invariants that must hold for every one of them.
//!
//! Rounding is where value leaks, and it leaks a millionth at a time, which is exactly the
//! size of bug that scenario tests miss and an attacker repeats. Every property below is
//! written so that the *pool* wins ties. A holder losing a microSCRT to rounding is
//! unfortunate; the pool losing one to every caller is a drain.

use cosmwasm_std::Uint128;
use proptest::prelude::*;

use lst_core::math::{
    assets_for_shares, exchange_rate, shares_for_deposit, PoolTotals, RATE_SCALE,
};

/// Amounts spanning dust to far more SCRT than will ever exist.
fn amount() -> impl Strategy<Value = u128> {
    prop_oneof![
        1u128..1_000,                                // dust, where rounding bites hardest
        1_000u128..1_000_000_000_000,                // ordinary balances
        1_000_000_000_000u128..u128::from(u64::MAX), // absurd, but must not panic
    ]
}

prop_compose! {
    /// A pool that could actually exist: some stake, some rewards, some cash, some debt.
    fn pool()(
        bonded in amount(),
        rewards in 0u128..1_000_000_000,
        liquid in 0u128..1_000_000_000,
        supply in amount(),
        owed_ratio in 0u32..=100,
    ) -> PoolTotals {
        let gross = bonded.saturating_add(rewards).saturating_add(liquid);
        // Liabilities up to and including everything the pool holds — a fully drained
        // protocol is a legitimate state and must not misbehave.
        let owed = gross / 100 * u128::from(owed_ratio);
        PoolTotals {
            bonded: Uint128::new(bonded),
            pending_rewards: Uint128::new(rewards),
            liquid: Uint128::new(liquid),
            owed_backed: Uint128::new(owed),
            supply: Uint128::new(supply),
        }
    }
}

proptest! {
    /// Depositing then immediately withdrawing must never return more than went in.
    ///
    /// This is the one that matters. A round trip that profits is free money, and it is
    /// repeatable, so any margin at all is a drain on everyone else.
    #[test]
    fn a_round_trip_never_profits(p in pool(), deposit in amount()) {
        let deposit = Uint128::new(deposit);
        let Ok(shares) = shares_for_deposit(deposit, &p) else { return Ok(()); };
        prop_assume!(!shares.is_zero());

        // Price the withdrawal against the pool as it stands after the deposit landed.
        let after = PoolTotals {
            liquid: p.liquid + deposit,
            supply: p.supply + shares,
            ..p
        };
        let Ok(back) = assets_for_shares(shares, &after) else { return Ok(()); };

        prop_assert!(
            back <= deposit,
            "round trip profited: put in {deposit}, got back {back} (shares {shares})",
        );
    }

    /// A deposit must never reduce what everyone else's shares are worth.
    #[test]
    fn a_deposit_never_dilutes_the_holders_already_there(p in pool(), deposit in amount()) {
        let deposit = Uint128::new(deposit);
        let Ok(before) = exchange_rate(&p) else { return Ok(()); };
        let Ok(shares) = shares_for_deposit(deposit, &p) else { return Ok(()); };

        let after_pool = PoolTotals {
            liquid: p.liquid + deposit,
            supply: p.supply + shares,
            ..p
        };
        let Ok(after) = exchange_rate(&after_pool) else { return Ok(()); };

        prop_assert!(
            after >= before,
            "a deposit moved the rate down: {before} -> {after}",
        );
    }

    /// Nor may a withdrawal, which is the same property from the other side.
    ///
    /// Partial withdrawals only. Redeeming the entire supply leaves nobody behind for the
    /// rate to be unfair to, and the contract reports parity rather than dividing by zero
    /// — a state the real protocol cannot reach anyway, because the bootstrap seed mints
    /// shares that nothing can ever unbond.
    #[test]
    fn a_withdrawal_never_dilutes_the_holders_who_stayed(p in pool(), fraction in 1u32..=99) {
        prop_assume!(!p.supply.is_zero());
        let shares = p.supply.multiply_ratio(u128::from(fraction), 100u128);
        prop_assume!(!shares.is_zero() && shares < p.supply);

        let Ok(before) = exchange_rate(&p) else { return Ok(()); };
        let Ok(owed) = assets_for_shares(shares, &p) else { return Ok(()); };

        // The shares burn immediately and the SCRT they priced becomes a liability that
        // stops backing the rest — the three-phase accounting the contract performs.
        let after_pool = PoolTotals {
            supply: p.supply - shares,
            owed_backed: p.owed_backed + owed,
            ..p
        };
        let Ok(after) = exchange_rate(&after_pool) else { return Ok(()); };

        prop_assert!(
            after >= before,
            "a withdrawal moved the rate down for the rest: {before} -> {after} \
             (burned {shares} of {}, owed {owed})",
            p.supply,
        );
    }

    /// The protocol may never promise more than it holds.
    #[test]
    fn the_whole_supply_is_never_worth_more_than_the_assets(p in pool()) {
        prop_assume!(!p.supply.is_zero());
        let Ok(assets) = p.assets() else { return Ok(()); };
        let Ok(owed) = assets_for_shares(p.supply, &p) else { return Ok(()); };

        prop_assert!(
            owed <= assets,
            "the supply claims {owed} against assets of {assets}",
        );
    }

    /// Splitting a withdrawal must never beat taking it in one go.
    ///
    /// Rounding down happens once per call, so many small calls are where a caller would
    /// look for an edge — and where the pool would bleed if the direction were wrong.
    #[test]
    fn splitting_a_withdrawal_never_beats_taking_it_whole(p in pool(), parts in 2u32..=8) {
        prop_assume!(!p.supply.is_zero());
        let shares = p.supply.multiply_ratio(1u128, 2u128);
        prop_assume!(shares >= Uint128::new(u128::from(parts)));

        let Ok(whole) = assets_for_shares(shares, &p) else { return Ok(()); };

        let piece = shares.multiply_ratio(1u128, u128::from(parts));
        prop_assume!(!piece.is_zero());
        let mut split = Uint128::zero();
        for _ in 0..parts {
            let Ok(part) = assets_for_shares(piece, &p) else { return Ok(()); };
            split += part;
        }

        prop_assert!(
            split <= whole,
            "splitting into {parts} paid {split} where one call pays {whole}",
        );
    }

    /// No input in range may panic. Overflow must arrive as an error, never as a trap.
    ///
    /// `overflow-checks` is on in release, so an unhandled overflow is not a wrong number
    /// but a halted contract.
    #[test]
    fn no_pool_shape_can_panic_the_arithmetic(p in pool(), amount in amount()) {
        let amount = Uint128::new(amount);
        let _ = shares_for_deposit(amount, &p);
        let _ = assets_for_shares(amount, &p);
        let _ = exchange_rate(&p);
        let _ = p.assets();
    }

    /// An empty pool prices at parity rather than at zero or infinity.
    #[test]
    fn an_empty_pool_reports_parity(bonded in 0u128..1_000_000) {
        let p = PoolTotals {
            bonded: Uint128::new(bonded),
            pending_rewards: Uint128::zero(),
            liquid: Uint128::zero(),
            owed_backed: Uint128::zero(),
            supply: Uint128::zero(),
        };
        prop_assert_eq!(exchange_rate(&p).unwrap(), Uint128::new(RATE_SCALE));
    }
}
