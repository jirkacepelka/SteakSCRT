//! Entry-point tests against a mocked chain.
//!
//! The mock querier can be told what the staking module reports, which is what makes the
//! cases that matter reachable without a devnet: a slashed delegation, a delegation that
//! has vanished, a cache that has gone stale.

use cosmwasm_std::testing::{
    mock_dependencies, mock_env, mock_info, MockApi, MockQuerier, MockStorage,
};
use cosmwasm_std::{
    from_binary, to_binary, Coin, ContractResult, CosmosMsg, Decimal, Env, FullDelegation,
    OwnedDeps, StakingMsg, SystemResult, Uint128, Validator, WasmQuery,
};

use lst_core::contract::{execute, instantiate, query};
use lst_core::error::ContractError;
use lst_types::core::msg::{ExecuteAnswer, ExecuteMsg, InstantiateMsg, QueryAnswer, QueryMsg};
use lst_types::core::types::{ProtocolParams, ValidatorInit};

const DENOM: &str = "uscrt";
const DAY: u64 = 86_400;
const ADMIN: &str = "admin";
const USER: &str = "user";
const TOKEN: &str = "token_contract";
const TOKEN_HASH: &str = "abcdef";
const V1: &str = "validatorone";
const V2: &str = "validatortwo";

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

fn validator_set() -> Vec<ValidatorInit> {
    vec![
        ValidatorInit {
            address: V1.to_string(),
            weight_bps: 6_000,
        },
        ValidatorInit {
            address: V2.to_string(),
            weight_bps: 4_000,
        },
    ]
}

fn init_msg(params: ProtocolParams, validators: Vec<ValidatorInit>) -> InstantiateMsg {
    InstantiateMsg {
        admin: Some(ADMIN.to_string()),
        gov: Some(ADMIN.to_string()),
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
        &[mock_validator(V1), mock_validator(V2)],
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
        mock_info(ADMIN, &[]),
        init_msg(params(), validator_set()),
    )
    .unwrap();

    deps.querier
        .update_balance(env.contract.address.clone(), vec![Coin::new(SEED, DENOM)]);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(ADMIN, &[Coin::new(SEED, DENOM)]),
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
        mock_info(ADMIN, &[]),
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
        mock_info(ADMIN, &[]),
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
        mock_info(ADMIN, &[]),
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
        mock_info(ADMIN, &[]),
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
        mock_info(ADMIN, &[]),
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
        mock_info(ADMIN, &[]),
        init_msg(params(), validator_set()),
    )
    .unwrap();

    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(ADMIN, &[Coin::new(SEED, DENOM)]),
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
        mock_info(ADMIN, &[]),
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
        mock_info(ADMIN, &[]),
        init_msg(params(), validator_set()),
    )
    .unwrap();

    // One uscrt short. A tiny seed is exactly what the inflation attack needs.
    let err = execute(
        deps.as_mut(),
        env,
        mock_info(ADMIN, &[Coin::new(SEED - 1, DENOM)]),
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
        mock_info(ADMIN, &[Coin::new(SEED, DENOM)]),
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
        mock_info(ADMIN, &[]),
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
        mock_info(ADMIN, &[]),
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
        &[mock_validator(V1), mock_validator(V2)],
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
        ExecuteAnswer::Sync { done, .. } => assert!(!done, "one of two validators swept"),
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
        ExecuteMsg::Sync { limit: Some(1) },
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
