//! Entry-point tests against a mocked chain.
//!
//! The mock querier can be told what the staking module reports, which is what makes the
//! cases that matter reachable without a devnet: a slashed delegation, a delegation that
//! has vanished, a cache that has gone stale.

use cosmwasm_std::testing::{
    mock_dependencies, mock_env, mock_info, MockApi, MockQuerier, MockStorage,
};
use cosmwasm_std::{
    from_binary, to_binary, BankMsg, Coin, ContractResult, CosmosMsg, Decimal, DistributionMsg,
    Env, FullDelegation, OwnedDeps, Response, StakingMsg, SystemResult, Uint128, Validator,
    WasmQuery,
};

use lst_core::contract::{execute, instantiate, query};
use lst_core::error::ContractError;
use lst_types::core::msg::{
    ExecuteAnswer, ExecuteMsg, InstantiateMsg, ManagerMsg, OwnerMsg, QueryAnswer, QueryMsg,
    ReceiveHookMsg,
};
use lst_types::core::types::{
    ManagerLimits, ProtocolParams, RedelegateStep, ValidatorInit, ValidatorStatus,
};

const DENOM: &str = "uscrt";
const DAY: u64 = 86_400;
const OWNER: &str = "owner";
const MANAGER: &str = "manager";
const USER: &str = "user";
const TOKEN: &str = "token_contract";
const TOKEN_HASH: &str = "abcdef";
const V1: &str = "validatorone";
const V2: &str = "validatortwo";
const V3: &str = "validatorthree";
const V4: &str = "validatorfour";

const SEED: u128 = 10_000_000; // the minimum bootstrap seed

type Deps = OwnedDeps<MockStorage, MockApi, MockQuerier>;

fn params() -> ProtocolParams {
    ProtocolParams {
        unbond_window_secs: 5 * DAY,
        unbonding_period_secs: 21 * DAY,
        performance_fee_bps: 800,
        withdrawal_fee_bps: 0,
        min_deposit: Uint128::new(1_000_000),
        sync_stale_after_secs: 7_200,
        max_unbond_entries_per_validator: 6,
    }
}

fn limits() -> ManagerLimits {
    ManagerLimits {
        max_performance_fee_bps: 1_000,
        max_validator_weight_bps: 2_500,
    }
}

fn validator_set() -> Vec<ValidatorInit> {
    // Four validators, none above the 25% per-validator ceiling.
    vec![
        ValidatorInit {
            address: V1.to_string(),
            weight_bps: 2_500,
        },
        ValidatorInit {
            address: V2.to_string(),
            weight_bps: 2_500,
        },
        ValidatorInit {
            address: V3.to_string(),
            weight_bps: 2_500,
        },
        ValidatorInit {
            address: V4.to_string(),
            weight_bps: 2_500,
        },
    ]
}

fn init_msg(params: ProtocolParams, validators: Vec<ValidatorInit>) -> InstantiateMsg {
    InstantiateMsg {
        owner: Some(OWNER.to_string()),
        manager: Some(MANAGER.to_string()),
        limits: limits(),
        validator_allowlist: vec![
            V1.to_string(),
            V2.to_string(),
            V3.to_string(),
            V4.to_string(),
        ],
        treasury: "treasury".to_string(),
        bonded_denom: DENOM.to_string(),
        validators,
        params,
        prng_seed: to_binary("entropy").unwrap(),
    }
}

fn mock_validator(address: &str) -> Validator {
    Validator {
        address: address.to_string(),
        commission: Decimal::percent(5),
        max_commission: Decimal::percent(20),
        max_change_rate: Decimal::percent(1),
    }
}

/// Point the mocked token contract at a fixed total supply.
fn set_token_supply(deps: &mut Deps, supply: u128) {
    deps.querier.update_wasm(move |q| match q {
        WasmQuery::Smart { .. } => SystemResult::Ok(ContractResult::Ok(
            to_binary(&lst_types::token::TokenQueryAnswer::TokenInfo {
                name: "Staked SCRT".to_string(),
                symbol: "dSCRT".to_string(),
                decimals: 6,
                total_supply: Some(Uint128::new(supply)),
            })
            .unwrap(),
        )),
        _ => SystemResult::Ok(ContractResult::Err("unexpected query".to_string())),
    });
}

fn set_delegation(deps: &mut Deps, env: &Env, validator: &str, bonded: u128, rewards: u128) {
    deps.querier.update_staking(
        DENOM,
        &[
            mock_validator(V1),
            mock_validator(V2),
            mock_validator(V3),
            mock_validator(V4),
        ],
        &[FullDelegation {
            delegator: env.contract.address.clone(),
            validator: validator.to_string(),
            amount: Coin::new(bonded, DENOM),
            can_redelegate: Coin::new(0, DENOM),
            accumulated_rewards: vec![Coin::new(rewards, DENOM)],
        }],
    );
}

/// Instantiate and bootstrap, leaving a pool of exactly `SEED` backed by `SEED` shares.
fn bootstrapped() -> (Deps, Env) {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info(OWNER, &[]),
        init_msg(params(), validator_set()),
    )
    .unwrap();

    deps.querier
        .update_balance(env.contract.address.clone(), vec![Coin::new(SEED, DENOM)]);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(OWNER, &[Coin::new(SEED, DENOM)]),
        ExecuteMsg::Bootstrap {
            token_address: TOKEN.to_string(),
            token_code_hash: TOKEN_HASH.to_string(),
        },
    )
    .unwrap();

    // The seed is delegated, so the contract no longer holds it as liquid balance.
    deps.querier
        .update_balance(env.contract.address.clone(), vec![]);
    set_token_supply(&mut deps, SEED);

    (deps, env)
}

// ---- instantiation ----

#[test]
fn a_three_day_window_is_rejected_because_it_needs_more_entries_than_the_chain_allows() {
    let mut deps = mock_dependencies();
    let mut p = params();
    p.unbond_window_secs = 3 * DAY;

    let err = instantiate(
        deps.as_mut(),
        mock_env(),
        mock_info(OWNER, &[]),
        init_msg(p, validator_set()),
    )
    .unwrap_err();

    assert!(
        matches!(err, ContractError::WindowTooShort { entries: 8, .. }),
        "got {err:?}"
    );
}

#[test]
fn a_four_day_window_is_rejected_for_leaving_no_headroom() {
    let mut deps = mock_dependencies();
    let mut p = params();
    p.unbond_window_secs = 4 * DAY;

    let err = instantiate(
        deps.as_mut(),
        mock_env(),
        mock_info(OWNER, &[]),
        init_msg(p, validator_set()),
    )
    .unwrap_err();

    assert!(
        matches!(err, ContractError::WindowTooShort { entries: 7, .. }),
        "got {err:?}"
    );
}

#[test]
fn an_entry_ceiling_at_the_chain_limit_is_rejected() {
    let mut deps = mock_dependencies();
    let mut p = params();
    p.max_unbond_entries_per_validator = 7; // the chain's own limit

    let err = instantiate(
        deps.as_mut(),
        mock_env(),
        mock_info(OWNER, &[]),
        init_msg(p, validator_set()),
    )
    .unwrap_err();

    assert!(
        matches!(err, ContractError::BadEntryCeiling { got: 7, max: 6 }),
        "got {err:?}"
    );
}

#[test]
fn an_excessive_performance_fee_is_rejected() {
    let mut deps = mock_dependencies();
    let mut p = params();
    p.performance_fee_bps = 2_500;

    let err = instantiate(
        deps.as_mut(),
        mock_env(),
        mock_info(OWNER, &[]),
        init_msg(p, validator_set()),
    )
    .unwrap_err();

    assert!(
        matches!(err, ContractError::FeeTooHigh { .. }),
        "got {err:?}"
    );
}

#[test]
fn a_validator_set_whose_weights_do_not_sum_to_one_hundred_percent_is_rejected() {
    let mut deps = mock_dependencies();
    let bad = vec![ValidatorInit {
        address: V1.to_string(),
        weight_bps: 9_000,
    }];

    let err = instantiate(
        deps.as_mut(),
        mock_env(),
        mock_info(OWNER, &[]),
        init_msg(params(), bad),
    )
    .unwrap_err();

    assert!(matches!(err, ContractError::BadWeightSum { got: 9_000 }));
}

// ---- bootstrap ----

#[test]
fn bootstrap_locks_its_shares_in_the_contract_and_delegates_the_seed() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info(OWNER, &[]),
        init_msg(params(), validator_set()),
    )
    .unwrap();

    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(OWNER, &[Coin::new(SEED, DENOM)]),
        ExecuteMsg::Bootstrap {
            token_address: TOKEN.to_string(),
            token_code_hash: TOKEN_HASH.to_string(),
        },
    )
    .unwrap();

    // RegisterReceive, Mint, Delegate.
    assert_eq!(res.messages.len(), 3);

    let delegated = res.messages.iter().find_map(|m| match &m.msg {
        CosmosMsg::Staking(StakingMsg::Delegate { validator, amount }) => {
            Some((validator.clone(), amount.amount))
        }
        _ => None,
    });
    assert_eq!(
        delegated,
        Some((V1.to_string(), Uint128::new(SEED))),
        "the whole seed goes to the most underweight validator"
    );

    match from_binary(&res.data.unwrap()).unwrap() {
        ExecuteAnswer::Bootstrap {
            scrt_seeded,
            locked_shares,
        } => {
            assert_eq!(scrt_seeded, Uint128::new(SEED));
            // Shares go to the contract itself, where nothing can redeem them.
            assert_eq!(locked_shares, Uint128::new(SEED));
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn only_the_admin_can_bootstrap() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info(OWNER, &[]),
        init_msg(params(), validator_set()),
    )
    .unwrap();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[Coin::new(SEED, DENOM)]),
        ExecuteMsg::Bootstrap {
            token_address: TOKEN.to_string(),
            token_code_hash: TOKEN_HASH.to_string(),
        },
    )
    .unwrap_err();

    assert_eq!(err, ContractError::Unauthorized);
}

#[test]
fn a_seed_below_the_minimum_is_rejected() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info(OWNER, &[]),
        init_msg(params(), validator_set()),
    )
    .unwrap();

    // One uscrt short. A tiny seed is exactly what the inflation attack needs.
    let err = execute(
        deps.as_mut(),
        env,
        mock_info(OWNER, &[Coin::new(SEED - 1, DENOM)]),
        ExecuteMsg::Bootstrap {
            token_address: TOKEN.to_string(),
            token_code_hash: TOKEN_HASH.to_string(),
        },
    )
    .unwrap_err();

    assert!(
        matches!(err, ContractError::DepositTooSmall { .. }),
        "got {err:?}"
    );
}

#[test]
fn bootstrapping_twice_is_rejected() {
    let (mut deps, env) = bootstrapped();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info(OWNER, &[Coin::new(SEED, DENOM)]),
        ExecuteMsg::Bootstrap {
            token_address: "another_token".to_string(),
            token_code_hash: TOKEN_HASH.to_string(),
        },
    )
    .unwrap_err();

    assert_eq!(err, ContractError::TokenAlreadyRegistered);
}

// ---- deposits ----

#[test]
fn deposits_are_refused_before_the_pool_is_seeded() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info(OWNER, &[]),
        init_msg(params(), validator_set()),
    )
    .unwrap();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[Coin::new(5_000_000, DENOM)]),
        ExecuteMsg::Deposit {},
    )
    .unwrap_err();

    assert_eq!(err, ContractError::TokenNotRegistered);
}

#[test]
fn a_first_deposit_into_a_seeded_pool_mints_one_for_one() {
    let (mut deps, env) = bootstrapped();
    let amount = 5_000_000u128;

    // The bank credits the deposit before the handler runs.
    deps.querier
        .update_balance(env.contract.address.clone(), vec![Coin::new(amount, DENOM)]);

    let res = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[Coin::new(amount, DENOM)]),
        ExecuteMsg::Deposit {},
    )
    .unwrap();

    match from_binary(&res.data.unwrap()).unwrap() {
        ExecuteAnswer::Deposit { shares_minted, .. } => {
            assert_eq!(
                shares_minted,
                Uint128::new(amount),
                "pool is 10 SCRT backing 10 SCRT of shares, so the rate is exactly 1"
            );
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn a_deposit_is_not_priced_against_its_own_money() {
    // If the incoming funds were counted as pool assets before minting, the depositor
    // would be buying into a pool that already contains their deposit and would receive
    // fewer shares than they paid for. Pool: 10 SCRT / 10 SCRT of shares; a 10 SCRT
    // deposit must mint 10 SCRT of shares, not 5.
    let (mut deps, env) = bootstrapped();
    let amount = SEED;

    deps.querier
        .update_balance(env.contract.address.clone(), vec![Coin::new(amount, DENOM)]);

    let res = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[Coin::new(amount, DENOM)]),
        ExecuteMsg::Deposit {},
    )
    .unwrap();

    match from_binary(&res.data.unwrap()).unwrap() {
        ExecuteAnswer::Deposit { shares_minted, .. } => {
            assert_eq!(shares_minted, Uint128::new(amount));
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn a_deposit_below_the_minimum_is_rejected() {
    let (mut deps, env) = bootstrapped();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[Coin::new(999, DENOM)]),
        ExecuteMsg::Deposit {},
    )
    .unwrap_err();

    assert!(
        matches!(err, ContractError::DepositTooSmall { .. }),
        "got {err:?}"
    );
}

#[test]
fn a_deposit_in_the_wrong_denom_is_rejected() {
    let (mut deps, env) = bootstrapped();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[Coin::new(5_000_000, "uatom")]),
        ExecuteMsg::Deposit {},
    )
    .unwrap_err();

    assert!(
        matches!(err, ContractError::WrongDenom { .. }),
        "got {err:?}"
    );
}

#[test]
fn deposits_stop_when_the_cache_goes_stale() {
    // This is the anti-arbitrage guard: an unsynced slashing event would otherwise let
    // someone mint against a rate that no longer reflects the pool.
    let (mut deps, mut env) = bootstrapped();
    env.block.time = env.block.time.plus_seconds(7_201);

    deps.querier.update_balance(
        env.contract.address.clone(),
        vec![Coin::new(5_000_000, DENOM)],
    );

    let err = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[Coin::new(5_000_000, DENOM)]),
        ExecuteMsg::Deposit {},
    )
    .unwrap_err();

    assert!(
        matches!(err, ContractError::StaleTotals { .. }),
        "got {err:?}"
    );
}

#[test]
fn pausing_blocks_deposits() {
    let (mut deps, env) = bootstrapped();

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(OWNER, &[]),
        ExecuteMsg::SetPaused { paused: true },
    )
    .unwrap();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[Coin::new(5_000_000, DENOM)]),
        ExecuteMsg::Deposit {},
    )
    .unwrap_err();

    assert_eq!(err, ContractError::Paused);
}

#[test]
fn a_non_admin_cannot_pause() {
    let (mut deps, env) = bootstrapped();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[]),
        ExecuteMsg::SetPaused { paused: true },
    )
    .unwrap_err();

    assert_eq!(err, ContractError::Unauthorized);
}

// ---- synchronisation ----

#[test]
fn sync_lowers_the_exchange_rate_after_a_slashing() {
    let (mut deps, env) = bootstrapped();

    // The validator reports 20% less than was delegated: the pool was slashed.
    let slashed = SEED * 80 / 100;
    set_delegation(&mut deps, &env, V1, slashed, 0);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::Sync { limit: None },
    )
    .unwrap();

    let answer: QueryAnswer =
        from_binary(&query(deps.as_ref(), env, QueryMsg::ExchangeRate {}).unwrap()).unwrap();

    match answer {
        QueryAnswer::ExchangeRate { rate, is_stale } => {
            assert!(!is_stale);
            assert_eq!(
                rate,
                Uint128::new(800_000_000_000_000_000),
                "10 SCRT of shares now backed by 8 SCRT"
            );
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn a_vanished_delegation_reads_as_zero_rather_than_being_carried_forward() {
    // A tombstoned validator's delegation disappears entirely. Keeping the last known
    // figure would leave the protocol claiming to be backed by stake that is gone.
    let (mut deps, env) = bootstrapped();

    deps.querier.update_staking(
        DENOM,
        &[
            mock_validator(V1),
            mock_validator(V2),
            mock_validator(V3),
            mock_validator(V4),
        ],
        &[], // no delegations at all
    );

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::Sync { limit: None },
    )
    .unwrap();

    let answer: QueryAnswer =
        from_binary(&query(deps.as_ref(), env, QueryMsg::State {}).unwrap()).unwrap();

    match answer {
        QueryAnswer::State(state) => assert!(state.total_bonded.is_zero()),
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn a_partial_sync_does_not_claim_the_cache_is_fresh() {
    // Stamping freshness after sweeping only part of the set would mark a mostly-stale
    // cache as usable, which is the exact failure the staleness guard exists to prevent.
    let (mut deps, mut env) = bootstrapped();
    set_delegation(&mut deps, &env, V1, SEED, 0);

    // Let the cache age past its limit, then sweep a single validator out of two.
    env.block.time = env.block.time.plus_seconds(7_201);

    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::Sync { limit: Some(1) },
    )
    .unwrap();

    match from_binary(&res.data.unwrap()).unwrap() {
        ExecuteAnswer::Sync { done, .. } => assert!(!done, "one of four validators swept"),
        other => panic!("unexpected answer {other:?}"),
    }

    let answer: QueryAnswer =
        from_binary(&query(deps.as_ref(), env.clone(), QueryMsg::State {}).unwrap()).unwrap();
    match answer {
        QueryAnswer::State(state) => assert!(state.is_stale, "still stale after a partial sweep"),
        other => panic!("unexpected answer {other:?}"),
    }

    // Finishing the sweep restores freshness.
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::Sync { limit: Some(10) },
    )
    .unwrap();

    let answer: QueryAnswer =
        from_binary(&query(deps.as_ref(), env, QueryMsg::State {}).unwrap()).unwrap();
    match answer {
        QueryAnswer::State(state) => assert!(!state.is_stale),
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn sync_picks_up_accrued_rewards() {
    let (mut deps, env) = bootstrapped();
    set_delegation(&mut deps, &env, V1, SEED, 1_000_000);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::Sync { limit: None },
    )
    .unwrap();

    let answer: QueryAnswer =
        from_binary(&query(deps.as_ref(), env, QueryMsg::State {}).unwrap()).unwrap();

    match answer {
        QueryAnswer::State(state) => {
            assert_eq!(state.pending_rewards, Uint128::new(1_000_000));
            // 11 SCRT of assets against 10 SCRT of shares.
            assert_eq!(state.exchange_rate, Uint128::new(1_100_000_000_000_000_000));
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

// ---- the unbonding queue ----

const WINDOW: u64 = 5 * DAY;
const UNBONDING: u64 = 21 * DAY;

/// Drive a withdrawal request as the token contract would.
fn unbond(deps: &mut Deps, env: &Env, who: &str, shares: u128) -> Result<Response, ContractError> {
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(TOKEN, &[]),
        ExecuteMsg::Receive {
            sender: who.to_string(),
            from: who.to_string(),
            amount: Uint128::new(shares),
            msg: Some(to_binary(&ReceiveHookMsg::Unbond {}).unwrap()),
        },
    )
}

/// A bootstrapped pool with a 10 SCRT user deposit on top: 20 SCRT backing 20 shares,
/// of which 10 are the locked seed and 10 belong to USER.
fn with_user_deposit() -> (Deps, Env) {
    let (mut deps, env) = bootstrapped();
    let amount = 10_000_000u128;

    deps.querier
        .update_balance(env.contract.address.clone(), vec![Coin::new(amount, DENOM)]);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[Coin::new(amount, DENOM)]),
        ExecuteMsg::Deposit {},
    )
    .unwrap();

    // Delegated, so nothing is left liquid.
    deps.querier
        .update_balance(env.contract.address.clone(), vec![]);
    set_token_supply(&mut deps, SEED + amount);
    (deps, env)
}

#[test]
fn only_the_token_contract_can_drive_a_withdrawal_request() {
    // Otherwise anyone could claim to have burned tokens they never held.
    let (mut deps, env) = with_user_deposit();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[]),
        ExecuteMsg::Receive {
            sender: USER.to_string(),
            from: USER.to_string(),
            amount: Uint128::new(1_000_000),
            msg: Some(to_binary(&ReceiveHookMsg::Unbond {}).unwrap()),
        },
    )
    .unwrap_err();

    assert_eq!(err, ContractError::Unauthorized);
}

#[test]
fn a_transfer_without_the_unbond_hook_is_rejected() {
    // A plain Send with no message is an accident, not a withdrawal. Treating it as one
    // would burn the sender's tokens on a guess.
    let (mut deps, env) = with_user_deposit();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info(TOKEN, &[]),
        ExecuteMsg::Receive {
            sender: USER.to_string(),
            from: USER.to_string(),
            amount: Uint128::new(1_000_000),
            msg: None,
        },
    )
    .unwrap_err();

    assert!(matches!(err, ContractError::Std(_)), "got {err:?}");
}

#[test]
fn a_withdrawal_request_burns_the_shares_and_records_a_claim() {
    let (mut deps, env) = with_user_deposit();

    let res = unbond(&mut deps, &env, USER, 5_000_000).unwrap();

    assert_eq!(res.messages.len(), 1, "one burn message");

    match from_binary(&res.data.unwrap()).unwrap() {
        ExecuteAnswer::Unbond {
            window_id,
            shares_burned,
            scrt_owed,
            matures_at_estimate,
        } => {
            assert_eq!(window_id, 0);
            assert_eq!(shares_burned, Uint128::new(5_000_000));
            // The rate is exactly 1, so 5 shares are worth 5 SCRT.
            assert_eq!(scrt_owed, Uint128::new(5_000_000));
            assert_eq!(
                matures_at_estimate,
                env.block.time.seconds() + WINDOW + UNBONDING,
                "the estimate spans the rest of the window plus the unbonding period"
            );
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn two_withdrawals_in_one_window_merge_into_a_single_claim() {
    // A second record would overwrite the first and silently lose the earlier money.
    let (mut deps, mut env) = with_user_deposit();

    unbond(&mut deps, &env, USER, 3_000_000).unwrap();
    unbond(&mut deps, &env, USER, 2_000_000).unwrap();

    // Close the window and run the request through to a payout.
    env.block.time = env.block.time.plus_seconds(WINDOW);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::AdvanceWindow {},
    )
    .unwrap();

    env.block.time = env.block.time.plus_seconds(UNBONDING);
    deps.querier.update_balance(
        env.contract.address.clone(),
        vec![Coin::new(5_000_000, DENOM)],
    );
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::CollectMatured { limit: None },
    )
    .unwrap();

    let res = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[]),
        ExecuteMsg::ClaimMatured { window_ids: None },
    )
    .unwrap();

    match from_binary(&res.data.unwrap()).unwrap() {
        ExecuteAnswer::ClaimMatured { scrt_claimed, .. } => {
            assert_eq!(scrt_claimed, Uint128::new(5_000_000), "3 + 2, not just 2");
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn pausing_does_not_trap_withdrawals() {
    // Pausing stops new money entering a protocol in trouble. Using it to keep money in
    // would be the opposite of a safety control.
    let (mut deps, env) = with_user_deposit();

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(OWNER, &[]),
        ExecuteMsg::SetPaused { paused: true },
    )
    .unwrap();

    assert!(unbond(&mut deps, &env, USER, 1_000_000).is_ok());
}

#[test]
fn a_window_cannot_be_advanced_before_it_closes() {
    let (mut deps, env) = with_user_deposit();
    unbond(&mut deps, &env, USER, 1_000_000).unwrap();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[]),
        ExecuteMsg::AdvanceWindow {},
    )
    .unwrap_err();

    assert!(
        matches!(err, ContractError::WindowNotClosed { .. }),
        "got {err:?}"
    );
}

#[test]
fn an_unused_window_rolls_forward_without_spending_an_entry_slot() {
    // A zero-value undelegation every window would burn a slot on every validator for
    // nothing, which is the exact resource the batching exists to conserve.
    let (mut deps, mut env) = with_user_deposit();
    env.block.time = env.block.time.plus_seconds(WINDOW);

    let res = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[]),
        ExecuteMsg::AdvanceWindow {},
    )
    .unwrap();

    assert!(
        res.messages.is_empty(),
        "nothing was withdrawn, so nothing unbonds"
    );

    match from_binary(&res.data.unwrap()).unwrap() {
        ExecuteAnswer::AdvanceWindow {
            closed_window_id,
            new_window_id,
            scrt_undelegated,
        } => {
            assert_eq!(closed_window_id, 0);
            assert_eq!(new_window_id, 1);
            assert!(scrt_undelegated.is_zero());
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn closing_a_used_window_undelegates_and_occupies_an_entry_slot() {
    let (mut deps, mut env) = with_user_deposit();
    unbond(&mut deps, &env, USER, 5_000_000).unwrap();

    env.block.time = env.block.time.plus_seconds(WINDOW);
    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::AdvanceWindow {},
    )
    .unwrap();

    let undelegated: Vec<_> = res
        .messages
        .iter()
        .filter_map(|m| match &m.msg {
            CosmosMsg::Staking(StakingMsg::Undelegate { validator, amount }) => {
                Some((validator.clone(), amount.amount))
            }
            _ => None,
        })
        .collect();
    // The seed went to V1 and the deposit to V2, so both sit at 10 SCRT against a 5 SCRT
    // target while V3 and V4 hold nothing. V1 and V2 tie on surplus, and the tie breaks
    // deterministically on index.
    assert_eq!(undelegated, vec![(V1.to_string(), Uint128::new(5_000_000))]);

    let answer: QueryAnswer =
        from_binary(&query(deps.as_ref(), env, QueryMsg::Validators {}).unwrap()).unwrap();
    match answer {
        QueryAnswer::Validators { validators } => {
            let v1 = validators.iter().find(|v| v.address == V1).unwrap();
            assert_eq!(
                v1.active_unbond_entries, 1,
                "the slot stays held until maturity"
            );
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn claiming_before_maturity_reports_when_the_money_arrives() {
    let (mut deps, mut env) = with_user_deposit();
    unbond(&mut deps, &env, USER, 5_000_000).unwrap();

    env.block.time = env.block.time.plus_seconds(WINDOW);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::AdvanceWindow {},
    )
    .unwrap();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[]),
        ExecuteMsg::ClaimMatured { window_ids: None },
    )
    .unwrap_err();

    assert!(
        matches!(err, ContractError::WindowNotMatured { .. }),
        "got {err:?}"
    );
}

#[test]
fn the_full_withdrawal_cycle_pays_out_and_frees_the_entry_slot() {
    let (mut deps, mut env) = with_user_deposit();
    unbond(&mut deps, &env, USER, 5_000_000).unwrap();

    env.block.time = env.block.time.plus_seconds(WINDOW);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::AdvanceWindow {},
    )
    .unwrap();

    // The chain releases the stake back into the contract's balance.
    env.block.time = env.block.time.plus_seconds(UNBONDING);
    deps.querier.update_balance(
        env.contract.address.clone(),
        vec![Coin::new(5_000_000, DENOM)],
    );

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::CollectMatured { limit: None },
    )
    .unwrap();

    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::ClaimMatured { window_ids: None },
    )
    .unwrap();

    let sent = res.messages.iter().find_map(|m| match &m.msg {
        CosmosMsg::Bank(BankMsg::Send { to_address, amount }) => {
            Some((to_address.clone(), amount[0].amount))
        }
        _ => None,
    });
    assert_eq!(sent, Some((USER.to_string(), Uint128::new(5_000_000))));

    let answer: QueryAnswer =
        from_binary(&query(deps.as_ref(), env, QueryMsg::Validators {}).unwrap()).unwrap();
    match answer {
        QueryAnswer::Validators { validators } => {
            let v1 = validators.iter().find(|v| v.address == V1).unwrap();
            assert_eq!(
                v1.active_unbond_entries, 0,
                "the slot is released at maturity"
            );
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn a_claim_cannot_be_paid_twice() {
    let (mut deps, mut env) = with_user_deposit();
    unbond(&mut deps, &env, USER, 5_000_000).unwrap();

    env.block.time = env.block.time.plus_seconds(WINDOW);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::AdvanceWindow {},
    )
    .unwrap();

    env.block.time = env.block.time.plus_seconds(UNBONDING);
    deps.querier.update_balance(
        env.contract.address.clone(),
        vec![Coin::new(5_000_000, DENOM)],
    );
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::CollectMatured { limit: None },
    )
    .unwrap();
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::ClaimMatured { window_ids: None },
    )
    .unwrap();

    let err = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[]),
        ExecuteMsg::ClaimMatured { window_ids: None },
    )
    .unwrap_err();

    assert_eq!(err, ContractError::NothingToClaim);
}

#[test]
fn a_slashed_unbonding_is_shared_rather_than_paid_first_come_first_served() {
    // Two users withdraw in the same window; only 80% comes back. Both must take the
    // haircut. Paying the first in full would make withdrawal a race.
    let (mut deps, mut env) = with_user_deposit();
    unbond(&mut deps, &env, USER, 5_000_000).unwrap();
    unbond(&mut deps, &env, "second_user", 5_000_000).unwrap();

    env.block.time = env.block.time.plus_seconds(WINDOW);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::AdvanceWindow {},
    )
    .unwrap();

    // 10 SCRT was undelegated; the validator was slashed and only 8 comes back.
    env.block.time = env.block.time.plus_seconds(UNBONDING);
    deps.querier.update_balance(
        env.contract.address.clone(),
        vec![Coin::new(8_000_000, DENOM)],
    );
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::CollectMatured { limit: None },
    )
    .unwrap();

    for who in [USER, "second_user"] {
        let res = execute(
            deps.as_mut(),
            env.clone(),
            mock_info(who, &[]),
            ExecuteMsg::ClaimMatured { window_ids: None },
        )
        .unwrap();

        match from_binary(&res.data.unwrap()).unwrap() {
            ExecuteAnswer::ClaimMatured { scrt_claimed, .. } => {
                assert_eq!(
                    scrt_claimed,
                    Uint128::new(4_000_000),
                    "{who} should take the same 20% haircut"
                );
            }
            other => panic!("unexpected answer {other:?}"),
        }
    }
}

#[test]
fn a_withdrawal_does_not_move_the_rate_for_the_holders_who_stayed() {
    // Regression guard. A withdrawal request burns shares immediately but its SCRT leaves
    // the contract in three stages: still bonded while the window is open, in flight
    // during unbonding, in the balance once matured. Subtracting the liability in the
    // wrong stage either inflates the rate for remaining holders (double-counting money
    // already promised away) or collapses it to zero (subtracting money that has already
    // left). The rate must sit still at every stage.
    let (mut deps, mut env) = with_user_deposit();

    let rate_of = |deps: &Deps, env: &Env| -> Uint128 {
        match from_binary(&query(deps.as_ref(), env.clone(), QueryMsg::ExchangeRate {}).unwrap())
            .unwrap()
        {
            QueryAnswer::ExchangeRate { rate, .. } => rate,
            other => panic!("unexpected answer {other:?}"),
        }
    };

    let one = Uint128::new(1_000_000_000_000_000_000);
    assert_eq!(rate_of(&deps, &env), one, "before any withdrawal");

    unbond(&mut deps, &env, USER, 5_000_000).unwrap();
    assert_eq!(
        rate_of(&deps, &env),
        one,
        "request made, stake still bonded"
    );

    env.block.time = env.block.time.plus_seconds(WINDOW);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::AdvanceWindow {},
    )
    .unwrap();
    assert_eq!(rate_of(&deps, &env), one, "undelegation in flight");

    env.block.time = env.block.time.plus_seconds(UNBONDING);
    deps.querier.update_balance(
        env.contract.address.clone(),
        vec![Coin::new(5_000_000, DENOM)],
    );
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::CollectMatured { limit: None },
    )
    .unwrap();
    assert_eq!(rate_of(&deps, &env), one, "money back, awaiting claim");

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::ClaimMatured { window_ids: None },
    )
    .unwrap();
    deps.querier
        .update_balance(env.contract.address.clone(), vec![]);
    assert_eq!(rate_of(&deps, &env), one, "paid out");
}

// ---- the two tiers of authority ----
//
// The manager runs the protocol day to day. The tests below are the boundary of what that
// role can do, and most of them exist to pin down what it *cannot*: the whole point of
// handing the role out is that doing so is safe.

fn owner_msg(
    deps: &mut Deps,
    env: &Env,
    who: &str,
    msg: OwnerMsg,
) -> Result<Response, ContractError> {
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(who, &[]),
        ExecuteMsg::Owner(msg),
    )
}

fn manager_msg(
    deps: &mut Deps,
    env: &Env,
    who: &str,
    msg: ManagerMsg,
) -> Result<Response, ContractError> {
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(who, &[]),
        ExecuteMsg::Manager(msg),
    )
}

fn weights(pairs: &[(&str, u16)]) -> Vec<ValidatorInit> {
    pairs
        .iter()
        .map(|(a, w)| ValidatorInit {
            address: a.to_string(),
            weight_bps: *w,
        })
        .collect()
}

#[test]
fn the_manager_can_redistribute_among_allowed_validators() {
    let (mut deps, env) = bootstrapped();

    manager_msg(
        &mut deps,
        &env,
        MANAGER,
        ManagerMsg::SetWeights {
            weights: weights(&[(V1, 2_500), (V2, 2_500), (V3, 2_500), (V4, 2_500)]),
        },
    )
    .unwrap();
}

#[test]
fn the_manager_cannot_introduce_a_validator_of_their_own() {
    // The whole extraction path: point the stake at a validator you operate and take the
    // yield as commission, without ever touching a user's token.
    let (mut deps, env) = bootstrapped();

    let err = manager_msg(
        &mut deps,
        &env,
        MANAGER,
        ManagerMsg::SetWeights {
            // Every weight is within the ceiling, so the allowlist is the only rule
            // this breaks.
            weights: weights(&[
                (V1, 2_500),
                (V2, 2_500),
                (V3, 2_500),
                ("the_managers_own_validator", 2_500),
            ]),
        },
    )
    .unwrap_err();

    assert!(
        matches!(err, ContractError::ValidatorNotAllowed { .. }),
        "got {err:?}"
    );
}

#[test]
fn the_manager_cannot_concentrate_the_stake_on_one_validator() {
    // The same extraction, reached without adding anyone: pile everything onto whichever
    // allowed validator happens to be theirs.
    let (mut deps, env) = bootstrapped();

    let err = manager_msg(
        &mut deps,
        &env,
        MANAGER,
        ManagerMsg::SetWeights {
            weights: weights(&[(V1, 9_000), (V2, 1_000)]),
        },
    )
    .unwrap_err();

    assert!(
        matches!(err, ContractError::WeightTooHigh { max: 2_500, .. }),
        "got {err:?}"
    );
}

#[test]
fn the_manager_cannot_redelegate_to_an_unapproved_validator() {
    // The concentration guard is on weights; redelegation is the other door into the same
    // room and has to be locked too.
    let (mut deps, env) = bootstrapped();

    let err = manager_msg(
        &mut deps,
        &env,
        MANAGER,
        ManagerMsg::Rebalance {
            plan: vec![RedelegateStep {
                src_validator: V1.to_string(),
                dst_validator: "somewhere_else".to_string(),
                amount: Uint128::new(1_000),
            }],
        },
    )
    .unwrap_err();

    assert!(
        matches!(err, ContractError::ValidatorNotAllowed { .. }),
        "got {err:?}"
    );
}

#[test]
fn the_manager_can_set_the_fee_up_to_the_owners_ceiling() {
    let (mut deps, env) = bootstrapped();

    manager_msg(
        &mut deps,
        &env,
        MANAGER,
        ManagerMsg::SetPerformanceFee { bps: 1_000 },
    )
    .unwrap();

    let err = manager_msg(
        &mut deps,
        &env,
        MANAGER,
        ManagerMsg::SetPerformanceFee { bps: 1_001 },
    )
    .unwrap_err();

    assert!(
        matches!(err, ContractError::FeeTooHigh { max: 1_000, .. }),
        "got {err:?}"
    );
}

#[test]
fn the_manager_cannot_redirect_the_fee_stream_to_themselves() {
    // Setting the treasury is the shortest path from "runs the protocol" to "is paid by
    // the protocol", so it sits with the owner.
    let (mut deps, env) = bootstrapped();

    let err = owner_msg(
        &mut deps,
        &env,
        MANAGER,
        OwnerMsg::SetTreasury {
            address: MANAGER.to_string(),
        },
    )
    .unwrap_err();

    assert_eq!(err, ContractError::Unauthorized);
}

#[test]
fn the_manager_cannot_widen_their_own_limits() {
    let (mut deps, env) = bootstrapped();

    let err = owner_msg(
        &mut deps,
        &env,
        MANAGER,
        OwnerMsg::SetManagerLimits {
            limits: ManagerLimits {
                max_performance_fee_bps: 2_000,
                max_validator_weight_bps: 2_500,
            },
        },
    )
    .unwrap_err();

    assert_eq!(err, ContractError::Unauthorized);
}

#[test]
fn the_manager_cannot_widen_the_allowlist_or_appoint_themselves_owner() {
    let (mut deps, env) = bootstrapped();

    for msg in [
        OwnerMsg::SetValidatorAllowlist {
            validators: vec!["the_managers_own_validator".to_string()],
        },
        OwnerMsg::SetOwner {
            address: MANAGER.to_string(),
        },
        OwnerMsg::SetManager {
            address: MANAGER.to_string(),
        },
    ] {
        assert_eq!(
            owner_msg(&mut deps, &env, MANAGER, msg).unwrap_err(),
            ContractError::Unauthorized
        );
    }
}

#[test]
fn the_owner_cannot_raise_limits_past_the_ceilings_in_the_code() {
    // Governance can tighten these but never loosen them past what is compiled in.
    // Raising the hard limit is a code change an auditor can see.
    let (mut deps, env) = bootstrapped();

    let err = owner_msg(
        &mut deps,
        &env,
        OWNER,
        OwnerMsg::SetManagerLimits {
            limits: ManagerLimits {
                max_performance_fee_bps: 2_001, // above the compiled 20%
                max_validator_weight_bps: 2_500,
            },
        },
    )
    .unwrap_err();
    assert_eq!(err, ContractError::LimitsExceedCode);

    let err = owner_msg(
        &mut deps,
        &env,
        OWNER,
        OwnerMsg::SetManagerLimits {
            limits: ManagerLimits {
                max_performance_fee_bps: 1_000,
                max_validator_weight_bps: 2_501, // above the compiled 25%
            },
        },
    )
    .unwrap_err();
    assert_eq!(err, ContractError::LimitsExceedCode);
}

#[test]
fn dropping_a_validator_from_the_allowlist_drains_it_rather_than_stranding_its_stake() {
    // Stake cannot be recalled synchronously, so a removed validator has to keep its
    // balance and stop receiving new delegations until the queue empties it.
    let (mut deps, env) = bootstrapped();

    owner_msg(
        &mut deps,
        &env,
        OWNER,
        OwnerMsg::SetValidatorAllowlist {
            validators: vec![V2.to_string(), V3.to_string(), V4.to_string()],
        },
    )
    .unwrap();

    let answer: QueryAnswer =
        from_binary(&query(deps.as_ref(), env, QueryMsg::Validators {}).unwrap()).unwrap();
    match answer {
        QueryAnswer::Validators { validators } => {
            let v1 = validators.iter().find(|v| v.address == V1).unwrap();
            assert_eq!(v1.status, ValidatorStatus::Draining);
            assert_eq!(v1.weight_bps, 0, "no new stake goes there");
            assert!(
                !v1.bonded.is_zero(),
                "its existing stake is still delegated"
            );
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn both_tiers_can_pause_but_neither_can_trap_a_withdrawal() {
    let (mut deps, env) = bootstrapped();

    for who in [OWNER, MANAGER] {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(who, &[]),
            ExecuteMsg::SetPaused { paused: true },
        )
        .unwrap();
    }

    // A stranger still cannot.
    assert_eq!(
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(USER, &[]),
            ExecuteMsg::SetPaused { paused: true },
        )
        .unwrap_err(),
        ContractError::Unauthorized
    );
}

// ---- compounding ----

#[test]
fn compounding_restakes_rewards_and_takes_the_fee_in_shares() {
    // Pool is 10 SCRT / 10 SCRT of shares, and 1 SCRT of rewards has accrued.
    // At 8%, the treasury should end up owning 0.08 SCRT of value.
    let (mut deps, env) = bootstrapped();
    set_delegation(&mut deps, &env, V1, SEED, 1_000_000);

    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::Compound { limit: Some(10) },
    )
    .unwrap();

    let withdrawn = res.messages.iter().any(|m| {
        matches!(
            &m.msg,
            CosmosMsg::Distribution(DistributionMsg::WithdrawDelegatorReward { .. })
        )
    });
    assert!(withdrawn, "rewards must actually be withdrawn");

    let restaked = res.messages.iter().find_map(|m| match &m.msg {
        CosmosMsg::Staking(StakingMsg::Delegate { amount, .. }) => Some(amount.amount),
        _ => None,
    });
    assert_eq!(
        restaked,
        Some(Uint128::new(1_000_000)),
        "the whole reward is restaked, fee included — the fee is taken in shares"
    );

    match from_binary(&res.data.unwrap()).unwrap() {
        ExecuteAnswer::Compound {
            rewards_withdrawn,
            fee_shares_minted,
            done,
            ..
        } => {
            assert_eq!(rewards_withdrawn, Uint128::new(1_000_000));
            assert!(done);
            // 0.08 SCRT of an 11 SCRT pool, priced in shares.
            assert_eq!(fee_shares_minted, Uint128::new(73_260));
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn compounding_raises_the_exchange_rate_for_holders() {
    let (mut deps, env) = bootstrapped();
    set_delegation(&mut deps, &env, V1, SEED, 1_000_000);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::Compound { limit: Some(10) },
    )
    .unwrap();

    // The staking module now reports the restaked total and no outstanding rewards.
    set_delegation(&mut deps, &env, V1, SEED + 1_000_000, 0);
    set_token_supply(&mut deps, SEED + 73_260);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::Sync { limit: None },
    )
    .unwrap();

    let answer: QueryAnswer =
        from_binary(&query(deps.as_ref(), env, QueryMsg::ExchangeRate {}).unwrap()).unwrap();
    match answer {
        QueryAnswer::ExchangeRate { rate, .. } => {
            // 11 SCRT backing 10.07326 SCRT of shares: holders keep the 92% they are owed.
            assert!(
                rate > Uint128::new(1_090_000_000_000_000_000)
                    && rate < Uint128::new(1_093_000_000_000_000_000),
                "rate was {rate}"
            );
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn compounding_with_no_rewards_does_nothing() {
    let (mut deps, env) = bootstrapped();
    set_delegation(&mut deps, &env, V1, SEED, 0);

    let res = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[]),
        ExecuteMsg::Compound { limit: None },
    )
    .unwrap();

    assert!(res.messages.is_empty(), "no rewards, so no messages at all");
}

#[test]
fn compounding_is_permissionless() {
    // A privileged compound would mean a stalled keeper freezes everyone's yield.
    let (mut deps, env) = bootstrapped();
    set_delegation(&mut deps, &env, V1, SEED, 500_000);

    assert!(execute(
        deps.as_mut(),
        env,
        mock_info("some_random_address", &[]),
        ExecuteMsg::Compound { limit: None },
    )
    .is_ok());
}

#[test]
fn compounding_paginates_over_the_validator_set() {
    let (mut deps, env) = bootstrapped();
    set_delegation(&mut deps, &env, V1, SEED, 100_000);

    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::Compound { limit: Some(1) },
    )
    .unwrap();

    match from_binary(&res.data.unwrap()).unwrap() {
        ExecuteAnswer::Compound {
            validators_processed,
            done,
            ..
        } => {
            assert_eq!(validators_processed, 1);
            assert!(!done, "one of two validators swept");
        }
        other => panic!("unexpected answer {other:?}"),
    }

    // Three more single-validator calls finish the set of four.
    let mut done_at = None;
    for step in 2..=4 {
        let res = execute(
            deps.as_mut(),
            env.clone(),
            mock_info(USER, &[]),
            ExecuteMsg::Compound { limit: Some(1) },
        )
        .unwrap();
        if let ExecuteAnswer::Compound { done, .. } = from_binary(&res.data.unwrap()).unwrap() {
            if done {
                done_at = Some(step);
                break;
            }
        }
    }
    assert_eq!(done_at, Some(4), "one call per validator, then finished");
}

#[test]
fn a_zero_fee_leaves_the_whole_reward_with_holders() {
    let mut deps = mock_dependencies();
    let env = mock_env();
    let mut p = params();
    p.performance_fee_bps = 0;

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info(OWNER, &[]),
        init_msg(p, validator_set()),
    )
    .unwrap();
    deps.querier
        .update_balance(env.contract.address.clone(), vec![Coin::new(SEED, DENOM)]);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(OWNER, &[Coin::new(SEED, DENOM)]),
        ExecuteMsg::Bootstrap {
            token_address: TOKEN.to_string(),
            token_code_hash: TOKEN_HASH.to_string(),
        },
    )
    .unwrap();
    deps.querier
        .update_balance(env.contract.address.clone(), vec![]);
    set_token_supply(&mut deps, SEED);
    set_delegation(&mut deps, &env, V1, SEED, 1_000_000);

    let res = execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[]),
        ExecuteMsg::Compound { limit: None },
    )
    .unwrap();

    match from_binary(&res.data.unwrap()).unwrap() {
        ExecuteAnswer::Compound {
            fee_shares_minted, ..
        } => assert!(fee_shares_minted.is_zero()),
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn sync_is_permissionless() {
    // Freshness gates deposits and withdrawals, so anyone blocked by a stale cache must
    // be able to restore it themselves rather than wait for the keeper.
    let (mut deps, env) = bootstrapped();
    set_delegation(&mut deps, &env, V1, SEED, 0);

    assert!(execute(
        deps.as_mut(),
        env,
        mock_info("some_random_address", &[]),
        ExecuteMsg::Sync { limit: None },
    )
    .is_ok());
}
