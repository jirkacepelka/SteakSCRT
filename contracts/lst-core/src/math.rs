//! Share accounting for the derivative token.
//!
//! # Rounding policy
//!
//! Every conversion rounds **in favour of the pool**, never the caller:
//! minting rounds shares down, redeeming rounds SCRT down. The residue stays with the
//! remaining holders. Rounding the other way would let an attacker mint-and-burn in a
//! loop to bleed the pool one unit at a time.
//!
//! # Overflow
//!
//! `deposit * total_supply` overflows `u128` for realistic supplies, so every ratio is
//! computed through a 256-bit intermediate and only narrowed back once divided.

use cosmwasm_std::{Uint128, Uint256};

use crate::error::ContractError;

/// Fixed-point scale of the publicly reported exchange rate: SCRT per share, times 10^18.
pub const RATE_SCALE: u128 = 1_000_000_000_000_000_000;

/// Hard ceiling on the performance fee, independent of governance.
///
/// The manager tunes the fee within a lower ceiling the network sets; raising this one
/// takes a new code version, which takes a governance vote. Holders therefore see the
/// change coming instead of finding it already applied.
pub const MAX_PERFORMANCE_FEE_BPS: u16 = 2_000; // 20%

/// Hardest ceiling on any single validator's share of the stake.
///
/// Concentration is the failure this protocol is meant to avoid, and the incumbent routes
/// 64% of its stake to one operator. Capping it in code rather than in configuration means
/// raising it is a code change an auditor can see and the network votes on, not a
/// parameter anyone can quietly flip.
pub const MAX_VALIDATOR_WEIGHT_BPS: u16 = 2_500; // 25%

/// The chain's `max_entries` staking parameter: concurrent unbonding entries permitted
/// per (delegator, validator) pair. The protocol must stay strictly below it.
pub const CHAIN_MAX_UNBOND_ENTRIES: u8 = 7;

/// Ceiling on the derivative supply the protocol will mint.
///
/// Denominated in shares, not in SCRT, and the reason is that a cap on assets closes the
/// door and never reopens it. Rewards accrue at around 23% a year, so assets that reach a
/// ceiling keep climbing past it on their own; the only thing that could bring them back
/// under is withdrawals outrunning the yield, which does not happen to a protocol people
/// want. Deposits would stop permanently.
///
/// Supply moves only on mint and burn. It reaches the ceiling, and room appears exactly
/// when somebody leaves — one out, one in, which is what a cap is supposed to do.
///
/// What it bounds is therefore `supply x rate` rather than a fixed number of SCRT, and
/// that figure grows with the rate. At 23% a year the drift is small next to the
/// alternative's failure mode, but it is real: this caps how many claims exist, not how
/// much they are worth.
///
/// Compiled in rather than configured, for the same reason as the concentration ceiling:
/// a cap the manager can raise protects nobody, because a compromised manager raises it
/// first. Changing it takes a code version the network votes on.
///
/// Only deposits are gated. Withdrawals and claims are never refused by it — a cap that
/// could trap money would be worse than no cap.
pub const MAX_TOTAL_SUPPLY: u128 = 100_000_000_000; // 100k dSCRT

/// Largest allowlist the protocol will accept.
///
/// Deposits and withdrawals re-read every validator's delegation before pricing, so the
/// size of this set lands in the gas bill of every user action. Measured on a devnet, a
/// validator costs roughly 7 000 gas to read, which puts a twenty-validator set at about
/// 140 000 gas of refresh on top of an 87 000-gas deposit — noticeable, and still an order
/// of magnitude below anything that would threaten a block.
///
/// Twenty is also far more than the 25% concentration ceiling needs; that requires four.
pub const MAX_VALIDATORS: usize = 20;

const BPS_DENOM: u128 = 10_000;

/// Total assets backing the derivative token.
///
/// Deliberately takes already-synced components rather than querying: the caller is
/// responsible for proving freshness, so that a stale read cannot silently produce a
/// plausible-looking rate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolTotals {
    /// Sum of bonded amounts as last read from `StakingQuery::Delegation`.
    pub bonded: Uint128,
    /// Rewards accrued at the validators but not yet withdrawn.
    pub pending_rewards: Uint128,
    /// Everything the contract holds in the staking denom, undeployed principal and
    /// matured window money alike.
    pub liquid: Uint128,
    /// Window liabilities whose SCRT is still inside `bonded` or `liquid`.
    ///
    /// Only the open window (its stake has not been undelegated yet) and matured windows
    /// (their SCRT has arrived in the balance) count. A window that is mid-unbonding is
    /// deliberately excluded: its SCRT has already left `bonded` and has not yet reached
    /// `liquid`, so subtracting it would count the same money out twice and drive the
    /// exchange rate toward zero for the holders who stayed.
    pub owed_backed: Uint128,
    /// Derivative token supply, mirrored from the token contract.
    pub supply: Uint128,
}

impl PoolTotals {
    /// SCRT backing the outstanding supply.
    ///
    /// Withdrawal requests are priced and their shares burned the moment they are made,
    /// so the SCRT they claim stops backing the remaining supply immediately — long
    /// before it physically leaves the contract.
    pub fn assets(&self) -> Result<Uint128, ContractError> {
        let gross = self
            .bonded
            .checked_add(self.pending_rewards)
            .and_then(|v| v.checked_add(self.liquid))
            .map_err(|_| ContractError::Overflow {
                context: "pool assets",
            })?;

        Ok(gross.saturating_sub(self.owed_backed))
    }
}

/// Shares minted for a deposit. Rounds down.
///
/// The `supply == 0` branch is only reachable at instantiation, where the bootstrap
/// deposit mints unredeemable shares. Keeping supply permanently non-zero is what makes
/// the first-depositor inflation attack uneconomic: an attacker would have to donate
/// enough to out-scale the bootstrap before rounding could swallow a real deposit, and
/// `min_deposit` puts a floor under what rounding can swallow anyway.
pub fn shares_for_deposit(deposit: Uint128, totals: &PoolTotals) -> Result<Uint128, ContractError> {
    if deposit.is_zero() {
        return Err(ContractError::ZeroAmount);
    }

    let assets = totals.assets()?;
    if totals.supply.is_zero() || assets.is_zero() {
        // Bootstrap: one share per uscrt.
        return Ok(deposit);
    }

    mul_div_floor(deposit, totals.supply, assets, "shares_for_deposit")
}

/// SCRT redeemable for a number of shares. Rounds down.
pub fn assets_for_shares(shares: Uint128, totals: &PoolTotals) -> Result<Uint128, ContractError> {
    if shares.is_zero() {
        return Err(ContractError::ZeroAmount);
    }
    if totals.supply.is_zero() {
        return Ok(Uint128::zero());
    }

    let assets = totals.assets()?;
    mul_div_floor(shares, assets, totals.supply, "assets_for_shares")
}

/// SCRT per share, scaled by [`RATE_SCALE`].
///
/// Display and monitoring only — never use this to price a deposit or a withdrawal.
/// Going through the scaled rate would round twice, and the second rounding is the one
/// that can be steered.
pub fn exchange_rate(totals: &PoolTotals) -> Result<Uint128, ContractError> {
    if totals.supply.is_zero() {
        return Ok(Uint128::new(RATE_SCALE));
    }
    let assets = totals.assets()?;
    mul_div_floor(
        assets,
        Uint128::new(RATE_SCALE),
        totals.supply,
        "exchange_rate",
    )
}

/// Shares to mint to the treasury so that it ends up owning `performance_fee_bps` of the
/// rewards just added to the pool.
///
/// Taking the fee as freshly minted shares rather than as withdrawn SCRT keeps the whole
/// reward compounded and staked, and avoids a bank transfer per compound cycle.
///
/// With assets `A` and supply `S` *before* the rewards land, rewards `R` and fee value
/// `f = R * bps / 10000`, the treasury must hold `m` shares such that
/// `m / (S + m) * (A + R) = f`, i.e. `m = f * S / (A + R - f)`.
///
/// `totals` must describe the pool **before** `rewards` are added.
pub fn fee_shares_for_rewards(
    rewards: Uint128,
    fee_bps: u16,
    totals: &PoolTotals,
) -> Result<Uint128, ContractError> {
    if rewards.is_zero() || fee_bps == 0 || totals.supply.is_zero() {
        return Ok(Uint128::zero());
    }

    let fee_value = mul_div_floor(
        rewards,
        Uint128::new(u128::from(fee_bps)),
        Uint128::new(BPS_DENOM),
        "fee_value",
    )?;
    if fee_value.is_zero() {
        return Ok(Uint128::zero());
    }

    let assets_after =
        totals
            .assets()?
            .checked_add(rewards)
            .map_err(|_| ContractError::Overflow {
                context: "assets after rewards",
            })?;

    // `fee_value <= rewards <= assets_after`, and the fee is capped well below 100%, so
    // the denominator is positive. Guarded anyway rather than trusting the invariant.
    let denom = assets_after
        .checked_sub(fee_value)
        .map_err(|_| ContractError::Overflow {
            context: "fee denominator",
        })?;
    if denom.is_zero() {
        return Ok(Uint128::zero());
    }

    mul_div_floor(fee_value, totals.supply, denom, "fee_shares")
}

/// Steady-state number of concurrent unbonding entries per validator implied by a window
/// length.
///
/// Windows close on a fixed cadence `P`, and an entry created at time `c` occupies a slot
/// until `c + U`. At any instant `T` the live entries are those created in `(T - U, T]`,
/// which for closings spaced `P` apart is exactly `ceil(U / P)`.
///
/// Windows can only ever close *late* (`AdvanceWindow` refuses before `closes_at`), and
/// closing late widens the spacing, so this is a genuine upper bound rather than an
/// average.
pub fn concurrent_entries_for_window(unbonding_period_secs: u64, window_secs: u64) -> u32 {
    if window_secs == 0 {
        return u32::MAX;
    }
    u32::try_from(unbonding_period_secs.div_ceil(window_secs)).unwrap_or(u32::MAX)
}

/// Entry slots a window length must be allowed to occupy: the steady-state count plus one.
///
/// The extra slot covers maturity landing a block or two later than
/// `unbonding_period_secs` predicts, which would briefly overlap the oldest entry with the
/// newest. Parameter validation is written against this number, not the bare steady-state
/// count, so that the protocol never *relies* on the redirect-to-another-validator
/// fallback during normal operation — that fallback is defence in depth, not the plan.
pub fn required_entry_slots(unbonding_period_secs: u64, window_secs: u64) -> u32 {
    concurrent_entries_for_window(unbonding_period_secs, window_secs).saturating_add(1)
}

/// `a * b / denom`, rounded down, computed over 256 bits.
fn mul_div_floor(
    a: Uint128,
    b: Uint128,
    denom: Uint128,
    context: &'static str,
) -> Result<Uint128, ContractError> {
    if denom.is_zero() {
        return Err(ContractError::Overflow { context });
    }
    let result = a.full_mul(b) / Uint256::from(denom);
    Uint128::try_from(result).map_err(|_| ContractError::Overflow { context })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn totals(bonded: u128, rewards: u128, liquid: u128, supply: u128) -> PoolTotals {
        PoolTotals {
            bonded: Uint128::new(bonded),
            pending_rewards: Uint128::new(rewards),
            liquid: Uint128::new(liquid),
            owed_backed: Uint128::zero(),
            supply: Uint128::new(supply),
        }
    }

    #[test]
    fn bootstrap_mints_one_to_one() {
        let t = totals(0, 0, 0, 0);
        assert_eq!(
            shares_for_deposit(Uint128::new(1_000_000), &t).unwrap(),
            Uint128::new(1_000_000)
        );
        assert_eq!(exchange_rate(&t).unwrap(), Uint128::new(RATE_SCALE));
    }

    #[test]
    fn rewards_raise_the_rate_and_later_deposits_get_fewer_shares() {
        // 1000 SCRT bonded against 1000 shares, then 100 SCRT of rewards accrue.
        let t = totals(1_000_000_000, 100_000_000, 0, 1_000_000_000);
        let rate = exchange_rate(&t).unwrap();
        assert_eq!(rate, Uint128::new(1_100_000_000_000_000_000));

        // A 100 SCRT deposit now buys ~90.9 SCRT worth of shares.
        let shares = shares_for_deposit(Uint128::new(100_000_000), &t).unwrap();
        assert_eq!(shares, Uint128::new(90_909_090));
    }

    #[test]
    fn deposit_then_redeem_never_returns_more_than_was_put_in() {
        let t = totals(7_777_777, 13, 5, 3_333_333);
        let deposit = Uint128::new(1_234_567);

        let shares = shares_for_deposit(deposit, &t).unwrap();
        // Redeem against the pool as it stands after the deposit lands.
        let after = PoolTotals {
            liquid: t.liquid + deposit,
            supply: t.supply + shares,
            ..t
        };
        let back = assets_for_shares(shares, &after).unwrap();

        assert!(
            back <= deposit,
            "round-trip returned {back} for a deposit of {deposit}"
        );
    }

    #[test]
    fn round_trip_is_loss_free_at_scale() {
        // The rounding residue must be dust, not a meaningful haircut.
        let t = totals(1_000_000_000_000, 0, 0, 1_000_000_000_000);
        let deposit = Uint128::new(500_000_000);
        let shares = shares_for_deposit(deposit, &t).unwrap();
        let after = PoolTotals {
            liquid: deposit,
            supply: t.supply + shares,
            ..t
        };
        let back = assets_for_shares(shares, &after).unwrap();
        assert!(deposit - back <= Uint128::new(1));
    }

    #[test]
    fn slashing_lowers_the_rate_without_underflow() {
        let healthy = totals(1_000_000_000, 0, 0, 1_000_000_000);
        let slashed = totals(950_000_000, 0, 0, 1_000_000_000);
        assert!(exchange_rate(&slashed).unwrap() < exchange_rate(&healthy).unwrap());
        assert_eq!(
            exchange_rate(&slashed).unwrap(),
            Uint128::new(950_000_000_000_000_000)
        );
    }

    #[test]
    fn dust_deposit_rounding_to_zero_is_rejected_by_callers() {
        // 1 uscrt against a pool priced far above 1 uscrt per share rounds to nothing.
        let t = totals(1_000_000_000_000, 0, 0, 1_000);
        let shares = shares_for_deposit(Uint128::new(1), &t).unwrap();
        assert!(shares.is_zero(), "caller must reject this via ZeroShares");
    }

    #[test]
    fn zero_amounts_are_rejected() {
        let t = totals(1, 0, 0, 1);
        assert_eq!(
            shares_for_deposit(Uint128::zero(), &t),
            Err(ContractError::ZeroAmount)
        );
        assert_eq!(
            assets_for_shares(Uint128::zero(), &t),
            Err(ContractError::ZeroAmount)
        );
    }

    #[test]
    fn fee_shares_give_the_treasury_exactly_its_cut() {
        // 1000 SCRT / 1000 shares, 100 SCRT of rewards, 8% fee => treasury owns 8 SCRT.
        let before = totals(1_000_000_000, 0, 0, 1_000_000_000);
        let rewards = Uint128::new(100_000_000);
        let m = fee_shares_for_rewards(rewards, 800, &before).unwrap();

        let after = PoolTotals {
            bonded: before.bonded + rewards,
            supply: before.supply + m,
            ..before
        };
        let treasury_value = assets_for_shares(m, &after).unwrap();

        let expected = Uint128::new(8_000_000);
        let diff = treasury_value.abs_diff(expected);
        assert!(diff <= Uint128::new(1), "treasury got {treasury_value}");
    }

    #[test]
    fn zero_fee_mints_nothing() {
        let before = totals(1_000_000_000, 0, 0, 1_000_000_000);
        assert!(
            fee_shares_for_rewards(Uint128::new(100_000_000), 0, &before)
                .unwrap()
                .is_zero()
        );
    }

    #[test]
    fn fee_on_an_empty_pool_mints_nothing() {
        let before = totals(0, 0, 0, 0);
        assert!(fee_shares_for_rewards(Uint128::new(1_000), 800, &before)
            .unwrap()
            .is_zero());
    }

    #[test]
    fn large_values_do_not_overflow() {
        // Far beyond SCRT's ~300M supply at 6 decimals.
        let big = 300_000_000_000_000_000_000u128;
        let t = totals(big, big / 10, 0, big);
        let shares = shares_for_deposit(Uint128::new(1_000_000), &t).unwrap();
        assert!(!shares.is_zero());
        exchange_rate(&t).unwrap();
    }

    #[test]
    fn window_length_determines_concurrent_entries() {
        const DAY: u64 = 86_400;
        const UNBONDING: u64 = 21 * DAY;

        // Steady-state counts: ceil(21 / P).
        assert_eq!(concurrent_entries_for_window(UNBONDING, 3 * DAY), 7);
        assert_eq!(concurrent_entries_for_window(UNBONDING, 4 * DAY), 6);
        assert_eq!(concurrent_entries_for_window(UNBONDING, 5 * DAY), 5);
        assert_eq!(concurrent_entries_for_window(UNBONDING, 7 * DAY), 3);
    }

    #[test]
    fn only_five_day_windows_leave_headroom_under_the_protocol_ceiling() {
        const DAY: u64 = 86_400;
        const UNBONDING: u64 = 21 * DAY;
        // The protocol keeps its own ceiling one below the chain's 7.
        const PROTOCOL_CEILING: u32 = 6;

        // 3 days sits exactly on the chain's limit even before any margin — one late
        // maturity and an Undelegate starts failing on-chain.
        assert_eq!(
            required_entry_slots(UNBONDING, 3 * DAY),
            8,
            "3-day windows exceed the chain's limit of 7 once margin is counted"
        );
        // 4 days needs 7: legal on-chain, but with zero headroom under our own ceiling.
        assert_eq!(required_entry_slots(UNBONDING, 4 * DAY), 7);
        assert!(required_entry_slots(UNBONDING, 4 * DAY) > PROTOCOL_CEILING);
        // 5 days is the shortest window that fits, hence the default.
        assert_eq!(required_entry_slots(UNBONDING, 5 * DAY), 6);
        assert!(required_entry_slots(UNBONDING, 5 * DAY) <= PROTOCOL_CEILING);
    }
}
