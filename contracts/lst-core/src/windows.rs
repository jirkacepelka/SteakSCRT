//! Batched unbonding windows.
//!
//! Users cannot unbond individually. The chain permits seven concurrent unbonding entries
//! per (delegator, validator) pair and this contract is a single delegator, so a few dozen
//! individual withdrawals would exhaust the entries and wedge the protocol for three
//! weeks. Requests are instead pooled into fixed-length windows, and one `Undelegate` per
//! validator is issued when a window closes.
//!
//! The pure lifecycle arithmetic lives here so that the awkward cases — a window nobody
//! used, a slashed unbonding, a claim against a window that came back short — are testable
//! without a chain.

use cosmwasm_std::Uint128;

use lst_types::core::types::{UnbondWindow, WindowState};

use crate::error::ContractError;
use crate::math;

/// A newly opened, empty window.
pub fn open(id: u64, now: u64, window_secs: u64) -> UnbondWindow {
    UnbondWindow {
        id,
        opened_at: now,
        closes_at: now.saturating_add(window_secs),
        // Only known once the window closes and the undelegation is actually issued.
        matures_at: 0,
        shares_burned: Uint128::zero(),
        scrt_owed: Uint128::zero(),
        scrt_realised: None,
        scrt_claimed: Uint128::zero(),
        validators_used: Vec::new(),
        state: WindowState::Open,
    }
}

/// Fail unless the window is open and accepting requests.
pub fn assert_open(window: &UnbondWindow) -> Result<(), ContractError> {
    if window.state != WindowState::Open {
        return Err(ContractError::WindowNotOpen { id: window.id });
    }
    Ok(())
}

/// Fail unless the window's closing time has passed.
pub fn assert_closable(window: &UnbondWindow, now: u64) -> Result<(), ContractError> {
    assert_open(window)?;
    if now < window.closes_at {
        return Err(ContractError::WindowNotClosed {
            id: window.id,
            closes_at: window.closes_at,
            now,
        });
    }
    Ok(())
}

/// What actually happens when a window closes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Closure {
    /// Nobody withdrew. The window rolls forward without touching the staking module.
    ///
    /// Worth distinguishing: issuing a zero-value `Undelegate` would burn an entry slot
    /// on every validator every window, which is exactly the resource the batching exists
    /// to conserve.
    Empty,
    /// Undelegations are issued and the window starts its unbonding period.
    Unbonding,
}

/// Move a closing window into its next state.
pub fn close(window: &mut UnbondWindow, now: u64, unbonding_period_secs: u64) -> Closure {
    if window.scrt_owed.is_zero() {
        window.state = WindowState::Settled;
        window.scrt_realised = Some(Uint128::zero());
        return Closure::Empty;
    }

    window.state = WindowState::Unbonding;
    window.matures_at = now.saturating_add(unbonding_period_secs);
    Closure::Unbonding
}

/// Whether an unbonding window's period has elapsed.
pub fn is_mature(window: &UnbondWindow, now: u64) -> bool {
    window.state == WindowState::Unbonding && now >= window.matures_at
}

/// Record what a matured window actually received and make it claimable.
///
/// `available` is the SCRT the contract can attribute to this window. Capping the realised
/// amount at what is actually there is what converts a shortfall into a shared, pro-rata
/// loss rather than a race in which early claimants are paid in full and late ones find
/// an empty contract.
pub fn mature(window: &mut UnbondWindow, available: Uint128) {
    window.scrt_realised = Some(window.scrt_owed.min(available));
    window.state = WindowState::Matured;
}

/// A single claimant's payout from a matured window.
///
/// Scaled by how much the window recovered. In the ordinary case `realised == owed` and
/// this is the identity.
pub fn payout_for_claim(
    window: &UnbondWindow,
    claim_owed: Uint128,
) -> Result<Uint128, ContractError> {
    let realised = window.scrt_realised.unwrap_or(window.scrt_owed);

    if realised == window.scrt_owed {
        return Ok(claim_owed);
    }
    if window.scrt_owed.is_zero() {
        return Ok(Uint128::zero());
    }

    // Rounds down, so the window can never pay out more than it took in.
    Ok(claim_owed.multiply_ratio(realised, window.scrt_owed))
}

/// Whether a window has paid everything it is going to.
pub fn is_drained(window: &UnbondWindow) -> bool {
    window.scrt_claimed >= window.payable()
}

/// Reject an unbonding window length that would need more entry slots than the protocol
/// allows itself.
pub fn validate_window_length(
    unbonding_period_secs: u64,
    window_secs: u64,
    ceiling: u8,
) -> Result<(), ContractError> {
    let needed = math::required_entry_slots(unbonding_period_secs, window_secs);
    if needed > u32::from(ceiling) {
        return Err(ContractError::WindowTooShort {
            got: window_secs,
            entries: needed,
            max: ceiling,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = 86_400;
    const UNBONDING: u64 = 21 * DAY;
    const WINDOW: u64 = 5 * DAY;

    fn used_window(owed: u128) -> UnbondWindow {
        let mut w = open(0, 1_000, WINDOW);
        w.shares_burned = Uint128::new(owed);
        w.scrt_owed = Uint128::new(owed);
        w
    }

    #[test]
    fn a_fresh_window_accepts_requests_and_has_no_maturity_yet() {
        let w = open(7, 1_000, WINDOW);
        assert_eq!(w.state, WindowState::Open);
        assert_eq!(w.closes_at, 1_000 + WINDOW);
        assert_eq!(
            w.matures_at, 0,
            "maturity is unknown until the window closes"
        );
        assert!(assert_open(&w).is_ok());
    }

    #[test]
    fn a_window_cannot_be_closed_early() {
        let w = open(0, 1_000, WINDOW);
        let err = assert_closable(&w, 1_000 + WINDOW - 1).unwrap_err();
        assert!(
            matches!(err, ContractError::WindowNotClosed { .. }),
            "got {err:?}"
        );
        assert!(assert_closable(&w, 1_000 + WINDOW).is_ok());
    }

    #[test]
    fn an_empty_window_settles_without_touching_the_staking_module() {
        // Issuing a zero-value undelegation every window would burn an entry slot on
        // every validator for nothing — the precise resource batching exists to save.
        let mut w = open(0, 1_000, WINDOW);
        assert_eq!(close(&mut w, 2_000, UNBONDING), Closure::Empty);
        assert_eq!(w.state, WindowState::Settled);
        assert_eq!(w.matures_at, 0);
    }

    #[test]
    fn a_used_window_starts_its_unbonding_period_from_the_closing_time() {
        let mut w = used_window(5_000);
        assert_eq!(close(&mut w, 2_000, UNBONDING), Closure::Unbonding);
        assert_eq!(w.state, WindowState::Unbonding);
        assert_eq!(w.matures_at, 2_000 + UNBONDING);
    }

    #[test]
    fn maturity_is_only_reached_after_the_full_period() {
        let mut w = used_window(5_000);
        close(&mut w, 2_000, UNBONDING);
        assert!(!is_mature(&w, 2_000 + UNBONDING - 1));
        assert!(is_mature(&w, 2_000 + UNBONDING));
    }

    #[test]
    fn an_open_window_is_never_mature() {
        let w = used_window(5_000);
        assert!(!is_mature(&w, u64::MAX));
    }

    #[test]
    fn a_fully_funded_window_pays_every_claim_in_full() {
        let mut w = used_window(1_000);
        close(&mut w, 2_000, UNBONDING);
        mature(&mut w, Uint128::new(1_000));

        assert_eq!(w.scrt_realised, Some(Uint128::new(1_000)));
        assert_eq!(
            payout_for_claim(&w, Uint128::new(400)).unwrap(),
            Uint128::new(400)
        );
    }

    #[test]
    fn extra_balance_does_not_inflate_what_a_window_pays_out() {
        // The contract also holds undeployed principal belonging to remaining holders.
        // A window must never pay more than it was owed just because the contract is
        // holding other people's money.
        let mut w = used_window(1_000);
        close(&mut w, 2_000, UNBONDING);
        mature(&mut w, Uint128::new(9_999));

        assert_eq!(w.scrt_realised, Some(Uint128::new(1_000)));
        assert_eq!(
            payout_for_claim(&w, Uint128::new(400)).unwrap(),
            Uint128::new(400)
        );
    }

    #[test]
    fn a_slashed_unbonding_is_shared_pro_rata_across_the_window() {
        // 1000 owed, only 900 came back: everyone in the window takes 10%.
        let mut w = used_window(1_000);
        close(&mut w, 2_000, UNBONDING);
        mature(&mut w, Uint128::new(900));

        assert_eq!(
            payout_for_claim(&w, Uint128::new(400)).unwrap(),
            Uint128::new(360)
        );
        assert_eq!(
            payout_for_claim(&w, Uint128::new(600)).unwrap(),
            Uint128::new(540)
        );
    }

    #[test]
    fn a_shortfall_never_pays_out_more_than_arrived() {
        // Rounding must not let the sum of claims exceed what the window received.
        let mut w = used_window(1_000);
        close(&mut w, 2_000, UNBONDING);
        mature(&mut w, Uint128::new(333));

        let claims = [333u128, 333, 334];
        let total: Uint128 = claims
            .iter()
            .map(|c| payout_for_claim(&w, Uint128::new(*c)).unwrap())
            .sum();

        assert!(
            total <= Uint128::new(333),
            "claims summed to {total} against 333 received"
        );
    }

    #[test]
    fn a_window_that_recovered_nothing_pays_nothing() {
        let mut w = used_window(1_000);
        close(&mut w, 2_000, UNBONDING);
        mature(&mut w, Uint128::zero());

        assert_eq!(
            payout_for_claim(&w, Uint128::new(400)).unwrap(),
            Uint128::zero()
        );
        assert!(is_drained(&w));
    }

    #[test]
    fn a_window_is_drained_only_once_everything_payable_is_paid() {
        let mut w = used_window(1_000);
        close(&mut w, 2_000, UNBONDING);
        mature(&mut w, Uint128::new(1_000));

        assert!(!is_drained(&w));
        w.scrt_claimed = Uint128::new(999);
        assert!(!is_drained(&w));
        w.scrt_claimed = Uint128::new(1_000);
        assert!(is_drained(&w));
    }

    #[test]
    fn a_short_window_is_rejected_against_the_protocol_ceiling() {
        assert!(validate_window_length(UNBONDING, 5 * DAY, 6).is_ok());

        let err = validate_window_length(UNBONDING, 4 * DAY, 6).unwrap_err();
        assert!(
            matches!(err, ContractError::WindowTooShort { entries: 7, .. }),
            "got {err:?}"
        );
    }
}
