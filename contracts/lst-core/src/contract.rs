//! Entry points: instantiation, bootstrap, deposits, synchronisation and queries.

use cosmwasm_std::{
    entry_point, to_binary, Addr, Binary, Coin, CosmosMsg, Deps, DepsMut, Env, MessageInfo,
    Response, StakingMsg, StdError, StdResult, Uint128,
};

use lst_types::core::msg::{ExecuteAnswer, ExecuteMsg, InstantiateMsg, QueryAnswer, QueryMsg};
use lst_types::core::types::{
    ContractInfo, ProtocolParams, StateResponse, ValidatorEntry, ValidatorInit, ValidatorStatus,
};
use lst_types::token::{TokenExecuteMsg, TokenQueryAnswer, TokenQueryMsg};
use secret_toolkit::utils::{HandleCallback, Query};

use crate::error::ContractError;
use crate::math::{
    self, PoolTotals, CHAIN_MAX_UNBOND_ENTRIES, MAX_PERFORMANCE_FEE_BPS, RATE_SCALE,
};
use crate::state::{Config, TotalsCache, CONFIG, SYNC_CURSOR, TOTALS, VALIDATORS};
use crate::validators;

/// Validators synchronised per `Sync` call when the caller does not say otherwise.
///
/// Each one costs a staking query, and the block gas limit is the binding constraint, so
/// sweeping a large set has to be spread over several transactions.
const DEFAULT_SYNC_LIMIT: u32 = 5;

/// Smallest accepted bootstrap seed, in uscrt.
///
/// The seed's only job is to be large enough that inflating the exchange rate past it
/// costs more than the rounding dust an attacker could capture.
const MIN_BOOTSTRAP_SEED: u128 = 10_000_000; // 10 SCRT

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    validate_params(&msg.params)?;
    validators::validate_set(&msg.validators)?;

    let admin = optional_addr(deps.as_ref(), msg.admin, &info.sender)?;
    let gov = optional_addr(deps.as_ref(), msg.gov, &info.sender)?;
    let treasury = deps.api.addr_validate(&msg.treasury)?;

    let config = Config {
        admin,
        gov,
        treasury,
        // Bound by `Bootstrap`, which also seeds the pool.
        token: None,
        bonded_denom: msg.bonded_denom,
        params: msg.params,
        paused: false,
    };
    CONFIG.save(deps.storage, &config)?;

    VALIDATORS.save(deps.storage, &initial_validator_set(msg.validators))?;
    SYNC_CURSOR.save(deps.storage, &0)?;
    TOTALS.save(
        deps.storage,
        &TotalsCache {
            last_sync_time: env.block.time.seconds(),
            ..Default::default()
        },
    )?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("admin", config.admin)
        .add_attribute("gov", config.gov))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Bootstrap {
            token_address,
            token_code_hash,
        } => execute_bootstrap(deps, env, info, token_address, token_code_hash),
        ExecuteMsg::Deposit {} => execute_deposit(deps, env, info),
        ExecuteMsg::Sync { limit } => execute_sync(deps, env, limit),
        ExecuteMsg::SetPaused { paused } => execute_set_paused(deps, info, paused),
        _ => Err(ContractError::Std(StdError::generic_err(
            "not implemented yet",
        ))),
    }
}

/// Bind the derivative token and seed the pool.
fn execute_bootstrap(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    token_address: String,
    token_code_hash: String,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized);
    }
    if config.token.is_some() {
        return Err(ContractError::TokenAlreadyRegistered);
    }

    let seed = exact_funds(&info, &config.bonded_denom)?;
    let minimum = Uint128::new(MIN_BOOTSTRAP_SEED);
    if seed < minimum {
        return Err(ContractError::DepositTooSmall {
            sent: seed,
            min: minimum,
        });
    }

    let token = ContractInfo {
        address: deps.api.addr_validate(&token_address)?,
        code_hash: token_code_hash,
    };
    config.token = Some(token.clone());
    CONFIG.save(deps.storage, &config)?;

    let mut set = VALIDATORS.load(deps.storage)?;
    let idx = validators::select_for_delegation(&set, seed)?;
    set[idx].bonded += seed;
    VALIDATORS.save(deps.storage, &set)?;

    let mut totals = TOTALS.load(deps.storage)?;
    totals.total_bonded += seed;
    // Shares are minted to this contract's own address. Nothing in the protocol ever
    // unbonds them, so the seed is locked for the lifetime of the deployment.
    totals.total_supply += seed;
    totals.last_sync_time = env.block.time.seconds();
    TOTALS.save(deps.storage, &totals)?;

    let messages = vec![
        // Register as a receiver so users can request withdrawals with a SNIP-20 `Send`.
        TokenExecuteMsg::RegisterReceive {
            code_hash: env.contract.code_hash.clone(),
            padding: None,
        }
        .to_cosmos_msg(token.code_hash.clone(), token.address.to_string(), None)?,
        TokenExecuteMsg::Mint {
            recipient: env.contract.address.to_string(),
            amount: seed,
            memo: Some("bootstrap seed, permanently locked".to_string()),
            padding: None,
        }
        .to_cosmos_msg(token.code_hash.clone(), token.address.to_string(), None)?,
        delegate_msg(&set[idx].address, &config.bonded_denom, seed),
    ];

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "bootstrap")
        .set_data(to_binary(&ExecuteAnswer::Bootstrap {
            scrt_seeded: seed,
            locked_shares: seed,
        })?))
}

fn execute_deposit(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if config.paused {
        return Err(ContractError::Paused);
    }
    let token = config.token()?.clone();

    let deposit = exact_funds(&info, &config.bonded_denom)?;
    if deposit < config.params.min_deposit {
        return Err(ContractError::DepositTooSmall {
            sent: deposit,
            min: config.params.min_deposit,
        });
    }

    let now = env.block.time.seconds();
    let totals = TOTALS.load(deps.storage)?;
    totals.assert_fresh(now, config.params.sync_stale_after_secs)?;

    // The deposit is already sitting in the contract's balance by the time this runs, so
    // it has to come back out before pricing — otherwise the depositor would be buying
    // shares in a pool that already contains their own money.
    let pool = pool_totals(deps.as_ref(), &env, &config, &totals, deposit)?;
    let shares = math::shares_for_deposit(deposit, &pool)?;
    if shares.is_zero() {
        return Err(ContractError::ZeroShares);
    }

    let mut set = VALIDATORS.load(deps.storage)?;
    let idx = validators::select_for_delegation(&set, deposit)?;
    set[idx].bonded += deposit;
    VALIDATORS.save(deps.storage, &set)?;

    let mut totals = totals;
    totals.total_bonded += deposit;
    totals.total_supply += shares;
    TOTALS.save(deps.storage, &totals)?;

    let messages = vec![
        TokenExecuteMsg::Mint {
            recipient: info.sender.to_string(),
            amount: shares,
            memo: None,
            padding: None,
        }
        .to_cosmos_msg(token.code_hash, token.address.to_string(), None)?,
        delegate_msg(&set[idx].address, &config.bonded_denom, deposit),
    ];

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "deposit")
        .set_data(to_binary(&ExecuteAnswer::Deposit {
            scrt_deposited: deposit,
            shares_minted: shares,
        })?))
}

/// Refresh cached totals from on-chain staking queries.
///
/// Permissionless by design: freshness gates deposits and withdrawals, so anyone who
/// wants to transact must be able to restore it without asking permission. The keeper
/// runs it on a schedule; users can unblock themselves if the keeper is down.
fn execute_sync(deps: DepsMut, env: Env, limit: Option<u32>) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut set = VALIDATORS.load(deps.storage)?;

    if set.is_empty() {
        return Err(ContractError::EmptyValidatorSet);
    }

    let cursor = SYNC_CURSOR.may_load(deps.storage)?.unwrap_or(0) as usize;
    let limit = limit.unwrap_or(DEFAULT_SYNC_LIMIT).max(1) as usize;
    let end = (cursor + limit).min(set.len());

    for entry in set.iter_mut().take(end).skip(cursor) {
        // Reading the delegation back, rather than trusting the running total, is what
        // makes slashing visible: a slashed delegation simply reports less than was put
        // in, and the exchange rate follows it down.
        let delegation = deps
            .querier
            .query_delegation(&env.contract.address, &entry.address)?;

        match delegation {
            Some(d) => {
                entry.bonded = d.amount.amount;
                entry.pending_rewards = d
                    .accumulated_rewards
                    .iter()
                    .find(|c| c.denom == config.bonded_denom)
                    .map(|c| c.amount)
                    .unwrap_or_else(Uint128::zero);
            }
            None => {
                // The delegation is gone entirely — the validator was tombstoned, or the
                // stake was fully undelegated elsewhere. Zero is the honest reading.
                entry.bonded = Uint128::zero();
                entry.pending_rewards = Uint128::zero();
            }
        }
    }

    let done = end >= set.len();
    let processed = (end - cursor) as u32;

    let total_bonded = validators::total_bonded(&set);
    let pending_rewards = set
        .iter()
        .fold(Uint128::zero(), |acc, v| acc + v.pending_rewards);

    VALIDATORS.save(deps.storage, &set)?;
    SYNC_CURSOR.save(deps.storage, &(if done { 0 } else { end as u32 }))?;

    let mut totals = TOTALS.load(deps.storage)?;
    totals.total_bonded = total_bonded;
    totals.pending_rewards = pending_rewards;

    if done {
        // Freshness is only claimed once every validator has been re-read. Stamping it
        // after a partial sweep would mark a cache fresh while most of it is still stale.
        if let Some(token) = &config.token {
            totals.total_supply = query_total_supply(deps.as_ref(), token)?;
        }
        totals.last_sync_time = env.block.time.seconds();
    }
    TOTALS.save(deps.storage, &totals)?;

    Ok(Response::new()
        .add_attribute("action", "sync")
        .set_data(to_binary(&ExecuteAnswer::Sync {
            total_bonded,
            validators_processed: processed,
            done,
        })?))
}

fn execute_set_paused(
    deps: DepsMut,
    info: MessageInfo,
    paused: bool,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized);
    }
    config.paused = paused;
    CONFIG.save(deps.storage, &config)?;

    Ok(Response::new()
        .add_attribute("action", "set_paused")
        .add_attribute("paused", paused.to_string()))
}

#[entry_point]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => {
            let config = CONFIG.load(deps.storage)?;
            to_binary(&QueryAnswer::Config(config.into_response()))
        }
        QueryMsg::State {} => to_binary(&QueryAnswer::State(query_state(deps, &env)?)),
        QueryMsg::ExchangeRate {} => {
            let state = query_state(deps, &env)?;
            to_binary(&QueryAnswer::ExchangeRate {
                rate: state.exchange_rate,
                is_stale: state.is_stale,
            })
        }
        QueryMsg::Validators {} => to_binary(&QueryAnswer::Validators {
            validators: VALIDATORS.load(deps.storage)?,
        }),
        _ => Err(StdError::generic_err("not implemented yet")),
    }
}

fn query_state(deps: Deps, env: &Env) -> StdResult<StateResponse> {
    let config = CONFIG.load(deps.storage)?;
    let totals = TOTALS.load(deps.storage)?;
    let now = env.block.time.seconds();

    let pool = pool_totals(deps, env, &config, &totals, Uint128::zero()).map_err(StdError::from)?;
    let rate = math::exchange_rate(&pool).map_err(StdError::from)?;

    Ok(StateResponse {
        total_bonded: totals.total_bonded,
        pending_rewards: totals.pending_rewards,
        liquid_unallocated: pool.liquid_unallocated,
        scrt_owed_to_windows: totals.scrt_owed_to_windows,
        total_supply: totals.total_supply,
        last_sync_time: totals.last_sync_time,
        is_stale: totals.is_stale(now, config.params.sync_stale_after_secs),
        exchange_rate: rate,
    })
}

// ---- helpers ----

/// Assemble the pool's totals, reading uncommitted SCRT from the bank module.
///
/// `exclude` is subtracted from the contract's balance: during a deposit the incoming
/// funds are already credited, and pricing against a pool that contains the depositor's
/// own money would hand them shares they did not pay for.
fn pool_totals(
    deps: Deps,
    env: &Env,
    config: &Config,
    totals: &TotalsCache,
    exclude: Uint128,
) -> Result<PoolTotals, ContractError> {
    let balance = deps
        .querier
        .query_balance(&env.contract.address, &config.bonded_denom)?
        .amount;

    // Anything the contract holds beyond what it owes to unbonding windows and what it
    // was just handed is undeployed principal.
    let liquid_unallocated = balance
        .saturating_sub(totals.scrt_owed_to_windows)
        .saturating_sub(exclude);

    Ok(PoolTotals {
        bonded: totals.total_bonded,
        pending_rewards: totals.pending_rewards,
        liquid_unallocated,
        supply: totals.total_supply,
    })
}

fn query_total_supply(deps: Deps, token: &ContractInfo) -> StdResult<Uint128> {
    let answer: TokenQueryAnswer = TokenQueryMsg::TokenInfo {}.query(
        deps.querier,
        token.code_hash.clone(),
        token.address.to_string(),
    )?;

    match answer {
        TokenQueryAnswer::TokenInfo { total_supply, .. } => total_supply.ok_or_else(|| {
            // The token must be instantiated with a public total supply. Without it the
            // exchange rate cannot be computed at all, so failing here is correct — a
            // silent zero would price every later deposit at the bootstrap rate.
            StdError::generic_err(
                "derivative token hides its total supply; it must be instantiated with public_total_supply = true",
            )
        }),
    }
}

fn delegate_msg(validator: &str, denom: &str, amount: Uint128) -> CosmosMsg {
    CosmosMsg::Staking(StakingMsg::Delegate {
        validator: validator.to_string(),
        amount: Coin {
            denom: denom.to_string(),
            amount,
        },
    })
}

/// Require exactly one coin of the staking denom, and return its amount.
fn exact_funds(info: &MessageInfo, denom: &str) -> Result<Uint128, ContractError> {
    match info.funds.as_slice() {
        [coin] if coin.denom == denom && !coin.amount.is_zero() => Ok(coin.amount),
        _ => Err(ContractError::WrongDenom {
            expected: denom.to_string(),
        }),
    }
}

fn optional_addr(deps: Deps, given: Option<String>, fallback: &Addr) -> StdResult<Addr> {
    match given {
        Some(a) => deps.api.addr_validate(&a),
        None => Ok(fallback.clone()),
    }
}

fn initial_validator_set(validators: Vec<ValidatorInit>) -> Vec<ValidatorEntry> {
    validators
        .into_iter()
        .map(|v| ValidatorEntry {
            address: v.address,
            weight_bps: v.weight_bps,
            status: ValidatorStatus::Active,
            bonded: Uint128::zero(),
            pending_rewards: Uint128::zero(),
            active_unbond_entries: 0,
        })
        .collect()
}

/// Reject a parameter set that would make the protocol unsafe to operate.
fn validate_params(params: &ProtocolParams) -> Result<(), ContractError> {
    if params.performance_fee_bps > MAX_PERFORMANCE_FEE_BPS {
        return Err(ContractError::FeeTooHigh {
            got: params.performance_fee_bps,
            max: MAX_PERFORMANCE_FEE_BPS,
        });
    }

    if params.max_unbond_entries_per_validator == 0
        || params.max_unbond_entries_per_validator >= CHAIN_MAX_UNBOND_ENTRIES
    {
        // Equal to the chain's limit is already too high: the protocol needs a slot of
        // slack to redirect an undelegation rather than have the chain reject it.
        return Err(ContractError::BadEntryCeiling {
            got: params.max_unbond_entries_per_validator,
            max: CHAIN_MAX_UNBOND_ENTRIES - 1,
        });
    }

    let needed =
        math::required_entry_slots(params.unbonding_period_secs, params.unbond_window_secs);
    if needed > u32::from(params.max_unbond_entries_per_validator) {
        return Err(ContractError::WindowTooShort {
            got: params.unbond_window_secs,
            entries: needed,
            max: params.max_unbond_entries_per_validator,
        });
    }

    Ok(())
}

/// Convenience constant for callers that want the rate's fixed-point scale.
pub const EXCHANGE_RATE_SCALE: u128 = RATE_SCALE;
