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

use lst_core::contract::{execute, instantiate, migrate, query};
use lst_core::error::ContractError;
use lst_types::core::msg::{
    ExecuteAnswer, ExecuteMsg, InstantiateMsg, ManagerMsg, MigrateMsg, QueryAnswer, QueryMsg,
    ReceiveHookMsg,
};
use lst_types::core::types::{
    ManagerLimits, ProtocolParams, RedelegateStep, ValidatorInit, WindowState,
};

const DENOM: &str = "uscrt";
const DAY: u64 = 86_400;
const DEPLOYER: &str = "deployer";
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
    set_delegations(deps, env, &[(validator, bonded, rewards)]);
}

/// State what the staking module reports, replacing whatever it said before.
///
/// Anything not listed reads as no delegation at all, which is how a test says the chain
/// disagrees with the contract's cache.
fn set_delegations(deps: &mut Deps, env: &Env, entries: &[(&str, u128, u128)]) {
    let delegations: Vec<FullDelegation> = entries
        .iter()
        .map(|(validator, bonded, rewards)| FullDelegation {
            delegator: env.contract.address.clone(),
            validator: validator.to_string(),
            amount: Coin::new(*bonded, DENOM),
            can_redelegate: Coin::new(0, DENOM),
            accumulated_rewards: vec![Coin::new(*rewards, DENOM)],
        })
        .collect();

    deps.querier.update_staking(
        DENOM,
        &[
            mock_validator(V1),
            mock_validator(V2),
            mock_validator(V3),
            mock_validator(V4),
        ],
        &delegations,
    );
}

/// Make the mocked staking module agree with what the contract believes it delegated.
///
/// Deposits and withdrawals re-read their delegations before pricing, so a test that
/// deposits and then withdraws has to model the delegation actually landing — the old
/// fixtures let the cached total grow arithmetically and never checked it against a
/// staking module at all, which is exactly the fiction the contract no longer accepts.
///
/// Tests that want the chain to *disagree* — a slashing — call `set_delegations`
/// afterwards to say so explicitly.
fn chain_confirms_delegations(deps: &mut Deps, env: &Env) {
    let answer: QueryAnswer =
        from_binary(&query(deps.as_ref(), env.clone(), QueryMsg::Validators {}).unwrap()).unwrap();
    let entries = match answer {
        QueryAnswer::Validators { validators } => validators,
        other => panic!("unexpected answer {other:?}"),
    };

    let delegations: Vec<FullDelegation> = entries
        .iter()
        .filter(|v| !v.bonded.is_zero())
        .map(|v| FullDelegation {
            delegator: env.contract.address.clone(),
            validator: v.address.clone(),
            amount: Coin::new(v.bonded.u128(), DENOM),
            can_redelegate: Coin::new(0, DENOM),
            accumulated_rewards: vec![Coin::new(v.pending_rewards.u128(), DENOM)],
        })
        .collect();

    deps.querier.update_staking(
        DENOM,
        &[
            mock_validator(V1),
            mock_validator(V2),
            mock_validator(V3),
            mock_validator(V4),
        ],
        &delegations,
    );
}

/// The id of the window currently accepting requests.
fn open_window_id(deps: cosmwasm_std::Deps, env: Env) -> u64 {
    let answer: QueryAnswer = from_binary(
        &query(
            deps,
            env,
            QueryMsg::Windows {
                state: Some(WindowState::Open),
                start_after: None,
                limit: None,
            },
        )
        .unwrap(),
    )
    .unwrap();
    match answer {
        QueryAnswer::Windows { windows } => windows[0].id,
        other => panic!("unexpected answer {other:?}"),
    }
}

/// Occupy every validator's unbonding entry slots, so nothing can be undelegated.
fn fill_entry_slots(deps: &mut Deps) {
    let mut set: Vec<lst_types::core::types::ValidatorEntry> = lst_core::state::VALIDATORS
        .load(deps.as_mut().storage)
        .unwrap();
    for entry in set.iter_mut() {
        entry.active_unbond_entries = 6;
    }
    lst_core::state::VALIDATORS
        .save(deps.as_mut().storage, &set)
        .unwrap();
}

/// Instantiate and bootstrap, leaving a pool of exactly `SEED` backed by `SEED` shares.
fn bootstrapped() -> (Deps, Env) {
    let mut deps = mock_dependencies();
    let env = mock_env();

    instantiate(
        deps.as_mut(),
        env.clone(),
        mock_info(DEPLOYER, &[]),
        init_msg(params(), validator_set()),
    )
    .unwrap();

    deps.querier
        .update_balance(env.contract.address.clone(), vec![Coin::new(SEED, DENOM)]);

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(DEPLOYER, &[Coin::new(SEED, DENOM)]),
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
    chain_confirms_delegations(&mut deps, &env);

    (deps, env)
}

// ---- instantiation ----

#[test]
fn an_oversized_allowlist_is_rejected_because_users_would_pay_for_it() {
    // Deposits and withdrawals re-read every validator, so the set's size is gas on a
    // user's transaction. Bounding it in code keeps that from being a configuration
    // mistake nobody notices until a deposit costs a fortune.
    let mut deps = mock_dependencies();
    let mut msg = init_msg(params(), validator_set());
    msg.validator_allowlist = (0..=lst_core::math::MAX_VALIDATORS)
        .map(|i| format!("secretvaloper1padding{i:04}"))
        .collect();

    let err = instantiate(deps.as_mut(), mock_env(), mock_info(DEPLOYER, &[]), msg).unwrap_err();

    assert!(
        matches!(
            err,
            ContractError::TooManyValidators { got, max }
                if got == lst_core::math::MAX_VALIDATORS + 1 && max == lst_core::math::MAX_VALIDATORS
        ),
        "got {err:?}"
    );
}

#[test]
fn a_three_day_window_is_rejected_because_it_needs_more_entries_than_the_chain_allows() {
    let mut deps = mock_dependencies();
    let mut p = params();
    p.unbond_window_secs = 3 * DAY;

    let err = instantiate(
        deps.as_mut(),
        mock_env(),
        mock_info(DEPLOYER, &[]),
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
        mock_info(DEPLOYER, &[]),
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
        mock_info(DEPLOYER, &[]),
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
        mock_info(DEPLOYER, &[]),
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
        mock_info(DEPLOYER, &[]),
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
        mock_info(DEPLOYER, &[]),
        init_msg(params(), validator_set()),
    )
    .unwrap();

    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(DEPLOYER, &[Coin::new(SEED, DENOM)]),
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
        mock_info(DEPLOYER, &[]),
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
        mock_info(DEPLOYER, &[]),
        init_msg(params(), validator_set()),
    )
    .unwrap();

    // One uscrt short. A tiny seed is exactly what the inflation attack needs.
    let err = execute(
        deps.as_mut(),
        env,
        mock_info(DEPLOYER, &[Coin::new(SEED - 1, DENOM)]),
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
        mock_info(DEPLOYER, &[Coin::new(SEED, DENOM)]),
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
        mock_info(DEPLOYER, &[]),
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
fn a_deposit_past_the_ceiling_is_refused() {
    // The ceiling bounds how many claims can exist while the code is young. It is checked
    // against the supply the deposit would leave behind, so the one that crosses it is the
    // one refused rather than the one after.
    let (mut deps, env) = bootstrapped();

    let cap = lst_core::math::MAX_TOTAL_SUPPLY;
    // A pool already one SCRT short of the ceiling, priced at parity.
    set_delegations(&mut deps, &env, &[(V1, cap - 1_000_000, 0)]);
    set_token_supply(&mut deps, cap - 1_000_000);

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
        matches!(err, ContractError::CapExceeded { cap: c, .. } if c == Uint128::new(cap)),
        "got {err:?}"
    );
}

#[test]
fn the_ceiling_does_not_move_when_rewards_accrue() {
    // The reason the ceiling counts shares rather than SCRT. Rewards push the pool's
    // assets up every block; if the ceiling were denominated in assets it would be crossed
    // by yield alone and deposits would close permanently, since nothing brings assets
    // back down except withdrawals outrunning the yield.
    let (mut deps, env) = bootstrapped();

    // 50k dSCRT priced at 3 SCRT each: assets of 150k SCRT, half again as much as the
    // share ceiling would allow if it were counted in SCRT, and the supply still under it.
    set_delegations(&mut deps, &env, &[(V1, 150_000_000_000, 0)]);
    set_token_supply(&mut deps, 50_000_000_000);

    deps.querier.update_balance(
        env.contract.address.clone(),
        vec![Coin::new(5_000_000, DENOM)],
    );
    execute(
        deps.as_mut(),
        env,
        mock_info(USER, &[Coin::new(5_000_000, DENOM)]),
        ExecuteMsg::Deposit {},
    )
    .expect("a pool rich in rewards must still accept deposits");
}

#[test]
fn the_ceiling_never_blocks_a_withdrawal() {
    // A cap that could trap money would be worse than no cap. Deposits stop; the way out
    // stays open.
    let (mut deps, env) = with_user_deposit();

    set_token_supply(&mut deps, lst_core::math::MAX_TOTAL_SUPPLY + 1_000_000);

    unbond(&mut deps, &env, USER, 1_000_000)
        .expect("being over the ceiling must not stop someone leaving");
}

#[test]
fn a_deposit_prices_against_the_chain_not_against_its_own_cache() {
    // The fixtures mirror what the contract believes into the mocked staking module, so
    // on their own they cannot prove the refresh reads anything at all. This makes the
    // two disagree: the chain says the delegation is worth less than the contract thinks,
    // which is what a slashing looks like, and the depositor must be priced on the
    // chain's number.
    let (mut deps, env) = with_user_deposit();

    // 20 SCRT backing 20 shares. Halve what the chain reports.
    set_delegations(&mut deps, &env, &[(V1, 10_000_000, 0)]);
    deps.querier.update_balance(
        env.contract.address.clone(),
        vec![Coin::new(10_000_000, DENOM)],
    );

    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[Coin::new(10_000_000, DENOM)]),
        ExecuteMsg::Deposit {},
    )
    .unwrap();

    match from_binary(&res.data.unwrap()).unwrap() {
        ExecuteAnswer::Deposit { shares_minted, .. } => {
            // Pool is 10 SCRT against 20 shares, so a share is worth half a SCRT and
            // 10 SCRT buys 20 of them. Pricing off the stale cache would have minted 10.
            assert_eq!(
                shares_minted,
                Uint128::new(20_000_000),
                "the deposit was priced against the cache, not the chain"
            );
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn a_withdrawal_prices_against_the_chain_not_against_its_own_cache() {
    // The same divergence on the way out: a holder leaving a slashed pool must take the
    // loss, or the ones who stayed pay for their exit.
    let (mut deps, env) = with_user_deposit();

    set_delegations(&mut deps, &env, &[(V1, 10_000_000, 0)]);

    let res = unbond(&mut deps, &env, USER, 5_000_000).unwrap();

    match from_binary(&res.data.unwrap()).unwrap() {
        ExecuteAnswer::Unbond { scrt_owed, .. } => {
            assert_eq!(
                scrt_owed,
                Uint128::new(2_500_000),
                "5 shares of a halved pool are worth 2.5 SCRT, not 5"
            );
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn a_deposit_still_works_after_nobody_has_synced_for_hours() {
    // The protocol used to refuse here, which meant an idle keeper took it offline for
    // users. A deposit now re-reads the delegations itself, so age of the cache is
    // irrelevant to whether someone can transact.
    let (mut deps, mut env) = bootstrapped();
    env.block.time = env.block.time.plus_seconds(7_201);

    deps.querier.update_balance(
        env.contract.address.clone(),
        vec![Coin::new(5_000_000, DENOM)],
    );

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[Coin::new(5_000_000, DENOM)]),
        ExecuteMsg::Deposit {},
    )
    .expect("a stale cache must not block a deposit");

    // And the deposit left the cache fresh, so it also repaired what the keeper missed.
    let answer: QueryAnswer =
        from_binary(&query(deps.as_ref(), env.clone(), QueryMsg::State {}).unwrap()).unwrap();
    match answer {
        QueryAnswer::State(state) => {
            assert!(
                !state.is_unattended,
                "the deposit's own refresh should have restored freshness"
            );
            assert_eq!(state.last_sync_time, env.block.time.seconds());
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn pausing_blocks_deposits() {
    let (mut deps, env) = bootstrapped();

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(MANAGER, &[]),
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
        QueryAnswer::ExchangeRate {
            rate,
            is_unattended,
        } => {
            assert!(!is_unattended);
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
        QueryAnswer::State(state) => {
            assert!(state.is_unattended, "still stale after a partial sweep")
        }
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
        QueryAnswer::State(state) => assert!(!state.is_unattended),
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
    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(TOKEN, &[]),
        ExecuteMsg::Receive {
            sender: who.to_string(),
            from: who.to_string(),
            amount: Uint128::new(shares),
            msg: Some(to_binary(&ReceiveHookMsg::Unbond {}).unwrap()),
        },
    );

    if res.is_ok() {
        token_confirms_burn(deps, env);
    }
    res
}

/// Let the mocked token reflect the burn the withdrawal just emitted.
///
/// On chain the burn message settles before the next transaction runs, so a second
/// withdrawal sees a smaller supply. A static mock kept reporting the pre-burn figure,
/// which — now that withdrawals re-read supply instead of trusting their own cache —
/// priced the second withdrawal against shares that no longer existed.
fn token_confirms_burn(deps: &mut Deps, env: &Env) {
    let answer: QueryAnswer =
        from_binary(&query(deps.as_ref(), env.clone(), QueryMsg::State {}).unwrap()).unwrap();
    match answer {
        QueryAnswer::State(state) => set_token_supply(deps, state.total_supply.u128()),
        other => panic!("unexpected answer {other:?}"),
    }
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
    chain_confirms_delegations(&mut deps, &env);
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
        mock_info(MANAGER, &[]),
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
fn a_claim_matures_its_own_window_without_the_keeper() {
    // The failure this closes: unbonding completes, the SCRT is sitting in the contract's
    // balance, and the claimant is told the window has not matured — true only of the
    // bookkeeping, which nobody had run. Money the chain had already released was
    // unreachable until a bot showed up.
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

    // Deliberately no CollectMatured. The claim has to do it.
    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[]),
        ExecuteMsg::ClaimMatured { window_ids: None },
    )
    .expect("a claim must not depend on somebody having run the keeper");

    let sent = res.messages.iter().find_map(|m| match &m.msg {
        CosmosMsg::Bank(BankMsg::Send { to_address, amount }) => {
            Some((to_address.clone(), amount[0].amount))
        }
        _ => None,
    });
    assert_eq!(sent, Some((USER.to_string(), Uint128::new(5_000_000))));
}

#[test]
fn a_deposit_closes_an_overdue_window_on_its_way_past() {
    // Nothing else moves the queue when no keeper runs, and a window that never closes is
    // a withdrawal that never matures.
    let (mut deps, mut env) = with_user_deposit();
    unbond(&mut deps, &env, USER, 5_000_000).unwrap();

    let before = open_window_id(deps.as_ref(), env.clone());
    env.block.time = env.block.time.plus_seconds(WINDOW);

    deps.querier.update_balance(
        env.contract.address.clone(),
        vec![Coin::new(5_000_000, DENOM)],
    );
    let res = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[Coin::new(5_000_000, DENOM)]),
        ExecuteMsg::Deposit {},
    )
    .unwrap();

    assert_ne!(
        open_window_id(deps.as_ref(), env.clone()),
        before,
        "the overdue window should have closed and a fresh one opened"
    );
    assert!(
        res.messages
            .iter()
            .any(|m| matches!(&m.msg, CosmosMsg::Staking(StakingMsg::Undelegate { .. }))),
        "closing the window should have undelegated what it owed"
    );
}

#[test]
fn a_deposit_is_not_refused_when_the_window_cannot_close() {
    // The opportunistic close must never become a reason a deposit fails. With every
    // validator at its entry ceiling there is nowhere to undelegate, and the deposit still
    // has to go through — the window simply waits for a later caller.
    let (mut deps, mut env) = with_user_deposit();
    unbond(&mut deps, &env, USER, 5_000_000).unwrap();

    fill_entry_slots(&mut deps);
    env.block.time = env.block.time.plus_seconds(WINDOW);

    deps.querier.update_balance(
        env.contract.address.clone(),
        vec![Coin::new(5_000_000, DENOM)],
    );
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(USER, &[Coin::new(5_000_000, DENOM)]),
        ExecuteMsg::Deposit {},
    )
    .expect("a full unbonding queue must not block deposits");
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
fn nothing_but_the_manager_holds_authority_over_this_contract() {
    // The point of the design: there is no second key. Everything outside the manager's
    // remit moves only when the network votes in a new code version, so there is simply no
    // message that changes the treasury, the allowlist, the limits or the manager itself.
    let (mut deps, env) = bootstrapped();

    // The deployer's single-use right was spent by Bootstrap and cannot be replayed.
    let err = execute(
        deps.as_mut(),
        env.clone(),
        mock_info(DEPLOYER, &[Coin::new(SEED, DENOM)]),
        ExecuteMsg::Bootstrap {
            token_address: "a_token_the_deployer_controls".to_string(),
            token_code_hash: TOKEN_HASH.to_string(),
        },
    )
    .unwrap_err();
    assert_eq!(err, ContractError::TokenAlreadyRegistered);

    // And the manager cannot pick up what the deployer put down.
    let err = execute(
        deps.as_mut(),
        env,
        mock_info(MANAGER, &[Coin::new(SEED, DENOM)]),
        ExecuteMsg::Bootstrap {
            token_address: "a_token_the_manager_controls".to_string(),
            token_code_hash: TOKEN_HASH.to_string(),
        },
    )
    .unwrap_err();
    assert_eq!(err, ContractError::TokenAlreadyRegistered);
}

#[test]
fn only_the_manager_can_pause() {
    // Pausing blocks deposits only, so the manager holding it cannot trap anyone's funds.
    let (mut deps, env) = bootstrapped();

    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(MANAGER, &[]),
        ExecuteMsg::SetPaused { paused: true },
    )
    .unwrap();

    for who in [DEPLOYER, USER] {
        assert_eq!(
            execute(
                deps.as_mut(),
                env.clone(),
                mock_info(who, &[]),
                ExecuteMsg::SetPaused { paused: true },
            )
            .unwrap_err(),
            ContractError::Unauthorized
        );
    }
}

// ---- private claims ----

/// Claims are private state served only behind a permit.
///
/// The unit-test harness cannot forge a wallet signature, so the query path is exercised
/// end to end on the devnet instead (tests/e2e). What is asserted here is the property
/// that matters for correctness: the claim a user is shown is the amount the window will
/// actually pay, which is not the same as the amount it promised once a slashing has
/// happened.
#[test]
fn a_claim_is_recorded_against_the_window_the_user_joined() {
    let (mut deps, env) = with_user_deposit();
    let res = unbond(&mut deps, &env, USER, 5_000_000).unwrap();

    match from_binary(&res.data.unwrap()).unwrap() {
        ExecuteAnswer::Unbond {
            window_id,
            scrt_owed,
            ..
        } => {
            assert_eq!(window_id, 0);
            assert_eq!(scrt_owed, Uint128::new(5_000_000));
        }
        other => panic!("unexpected answer {other:?}"),
    }
}

#[test]
fn windows_are_public_and_filterable() {
    // Deliberately unauthenticated: the undelegations a window issues are already visible
    // on-chain, so hiding the aggregate would buy no privacy while stopping a user from
    // seeing when the queue is being worked.
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

    let answer: QueryAnswer = from_binary(
        &query(
            deps.as_ref(),
            env.clone(),
            QueryMsg::Windows {
                state: None,
                start_after: None,
                limit: None,
            },
        )
        .unwrap(),
    )
    .unwrap();
    match answer {
        QueryAnswer::Windows { windows } => {
            assert_eq!(
                windows.len(),
                2,
                "the closed one and the freshly opened one"
            );
        }
        other => panic!("unexpected answer {other:?}"),
    }

    let answer: QueryAnswer = from_binary(
        &query(
            deps.as_ref(),
            env,
            QueryMsg::Windows {
                state: Some(WindowState::Unbonding),
                start_after: None,
                limit: None,
            },
        )
        .unwrap(),
    )
    .unwrap();
    match answer {
        QueryAnswer::Windows { windows } => {
            assert_eq!(windows.len(), 1);
            assert_eq!(windows[0].id, 0);
        }
        other => panic!("unexpected answer {other:?}"),
    }
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
fn the_fee_does_not_depend_on_whether_anybody_synced_first() {
    // The bug this pins: the fee used to be priced against the cached totals, and the
    // cache holds `pending_rewards` whenever somebody has synced recently — so the same
    // rewards were counted twice in the denominator and the treasury was quietly paid
    // about half. Running a sync first is free and permissionless, which made the
    // protocol's own fee depend on the order two strangers pressed two buttons.
    let fee_after = |sync_first: bool| {
        let (mut deps, env) = bootstrapped();
        set_delegation(&mut deps, &env, V1, SEED, 1_000_000);

        if sync_first {
            execute(
                deps.as_mut(),
                env.clone(),
                mock_info(USER, &[]),
                ExecuteMsg::Sync { limit: Some(10) },
            )
            .unwrap();
        }

        let res = execute(
            deps.as_mut(),
            env.clone(),
            mock_info(USER, &[]),
            ExecuteMsg::Compound { limit: Some(10) },
        )
        .unwrap();

        match from_binary(&res.data.unwrap()).unwrap() {
            ExecuteAnswer::Compound {
                fee_shares_minted, ..
            } => fee_shares_minted,
            other => panic!("unexpected answer {other:?}"),
        }
    };

    let alone = fee_after(false);
    let after_sync = fee_after(true);

    assert_eq!(
        alone, after_sync,
        "the fee moved because somebody ran a sync first: {alone} against {after_sync}"
    );
    assert_eq!(
        alone,
        Uint128::new(73_260),
        "and it is still the right figure"
    );
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
        mock_info(DEPLOYER, &[]),
        init_msg(p, validator_set()),
    )
    .unwrap();
    deps.querier
        .update_balance(env.contract.address.clone(), vec![Coin::new(SEED, DENOM)]);
    execute(
        deps.as_mut(),
        env.clone(),
        mock_info(DEPLOYER, &[Coin::new(SEED, DENOM)]),
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

/// The migration moves the ceiling, and only the ceiling.
///
/// This is the shape every rule change takes now that the network owns the code: a figure
/// compiled into a version, approved by a vote, applied by a migration nobody can
/// parameterise. So the test is as much about what stays put as what moves — a migration
/// that quietly raised the *fee* while raising the ceiling would be taking money the
/// proposal never mentioned.
#[test]
fn the_migration_raises_the_ceiling_without_touching_the_fee() {
    let (mut deps, env) = bootstrapped();

    manager_msg(
        &mut deps,
        &env,
        MANAGER,
        ManagerMsg::SetPerformanceFee { bps: 1_000 },
    )
    .unwrap();

    // Before: the old ceiling binds.
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

    let before = config_of(&deps, &env);
    migrate(deps.as_mut(), env.clone(), MigrateMsg {}).unwrap();
    let after = config_of(&deps, &env);

    assert_eq!(after.limits.max_performance_fee_bps, 1_500);
    assert_eq!(
        after.params.performance_fee_bps, before.params.performance_fee_bps,
        "the migration must not move the fee itself — that stays the manager's act"
    );
    assert_eq!(after.manager, before.manager, "manager must survive");
    assert_eq!(after.treasury, before.treasury, "treasury must survive");
    assert_eq!(
        after.limits.max_validator_weight_bps, before.limits.max_validator_weight_bps,
        "the other ceiling was not on the ballot"
    );

    // After: the new ceiling binds, and it binds.
    manager_msg(
        &mut deps,
        &env,
        MANAGER,
        ManagerMsg::SetPerformanceFee { bps: 1_500 },
    )
    .unwrap();
    let err = manager_msg(
        &mut deps,
        &env,
        MANAGER,
        ManagerMsg::SetPerformanceFee { bps: 1_501 },
    )
    .unwrap_err();
    assert!(
        matches!(err, ContractError::FeeTooHigh { max: 1_500, .. }),
        "got {err:?}"
    );
}

/// Running it twice is not running it twice as hard.
///
/// A migration can be replayed — a later proposal naming the same code id would do it — so
/// the ceiling must be assigned rather than accumulated.
#[test]
fn migrating_twice_lands_in_the_same_place() {
    let (mut deps, env) = bootstrapped();

    migrate(deps.as_mut(), env.clone(), MigrateMsg {}).unwrap();
    migrate(deps.as_mut(), env.clone(), MigrateMsg {}).unwrap();

    assert_eq!(config_of(&deps, &env).limits.max_performance_fee_bps, 1_500);
}

fn config_of(deps: &Deps, env: &Env) -> lst_types::core::types::ConfigResponse {
    match from_binary(&query(deps.as_ref(), env.clone(), QueryMsg::Config {}).unwrap()).unwrap() {
        QueryAnswer::Config(c) => c,
        other => panic!("expected a config, got {other:?}"),
    }
}
