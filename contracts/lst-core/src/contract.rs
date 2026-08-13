//! Entry points: instantiation, bootstrap, deposits, synchronisation and queries.

use cosmwasm_std::{
    entry_point, from_binary, to_binary, Addr, BankMsg, Binary, Coin, CosmosMsg, Deps, DepsMut,
    DistributionMsg, Env, MessageInfo, Response, StakingMsg, StdError, StdResult, Storage, Uint128,
};

use lst_types::core::msg::{
    AuthQueryMsg, ExecuteAnswer, ExecuteMsg, InstantiateMsg, ManagerMsg, MigrateMsg, QueryAnswer,
    QueryMsg, ReceiveHookMsg,
};
use lst_types::core::types::{
    ContractInfo, ManagerLimits, ProtocolParams, StateResponse, UnbondWindow, UserClaim,
    ValidatorEntry, ValidatorInit, ValidatorStatus, WindowState,
};
use lst_types::token::{TokenExecuteMsg, TokenQueryAnswer, TokenQueryMsg};
use secret_toolkit::permit::{validate, Permit};
use secret_toolkit::utils::{HandleCallback, Query};

use crate::error::ContractError;
use crate::math::{
    self, PoolTotals, CHAIN_MAX_UNBOND_ENTRIES, MAX_PERFORMANCE_FEE_BPS, MAX_VALIDATOR_WEIGHT_BPS,
    RATE_SCALE,
};
use crate::state::{
    self, ClaimRecord, Config, TotalsCache, ACTIVE_WINDOWS, ALLOWLIST, CONFIG, NEXT_WINDOW_ID,
    OPEN_WINDOW, SYNC_CURSOR, TOTALS, VALIDATORS, WINDOWS,
};
use crate::{validators, windows};

/// Validators synchronised per `Sync` call when the caller does not say otherwise.
///
/// Each one costs a staking query, and the block gas limit is the binding constraint, so
/// sweeping a large set has to be spread over several transactions.
const DEFAULT_SYNC_LIMIT: u32 = 5;

/// Validators compounded per `Compound` call by default.
///
/// Lower than the sync limit: compounding does more per validator — a query, a reward
/// withdrawal and, at the end, a delegation and a mint.
const DEFAULT_COMPOUND_LIMIT: u32 = 3;

/// Smallest accepted bootstrap seed, in uscrt.
///
/// The seed's only job is to be large enough that inflating the exchange rate past it
/// costs more than the rounding dust an attacker could capture.
const MIN_BOOTSTRAP_SEED: u128 = 10_000_000; // 10 SCRT

/// Windows returned by a `Windows` query when the caller does not say otherwise.
const DEFAULT_WINDOW_PAGE: u32 = 30;
/// Ceiling on a single page, so one query cannot be made to walk the whole history.
const MAX_WINDOW_PAGE: u32 = 100;

/// Storage prefix used by permit validation.
const PERMIT_PREFIX: &str = "permits";

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    validate_params(&msg.params)?;
    validators::validate_set(&msg.validators)?;

    validate_limits(&msg.limits)?;
    validators::validate_managed_weights(
        &msg.validators,
        &msg.validator_allowlist,
        msg.limits.max_validator_weight_bps,
    )?;
    if msg.params.performance_fee_bps > msg.limits.max_performance_fee_bps {
        return Err(ContractError::FeeTooHigh {
            got: msg.params.performance_fee_bps,
            max: msg.limits.max_performance_fee_bps,
        });
    }

    let manager = optional_addr(deps.as_ref(), msg.manager, &info.sender)?;
    let treasury = deps.api.addr_validate(&msg.treasury)?;

    let config = Config {
        manager,
        deployer: Some(info.sender.clone()),
        limits: msg.limits,
        treasury,
        // Bound by `Bootstrap`, which also seeds the pool.
        token: None,
        bonded_denom: msg.bonded_denom,
        params: msg.params,
        paused: false,
    };
    CONFIG.save(deps.storage, &config)?;

    ALLOWLIST.save(deps.storage, &msg.validator_allowlist)?;
    VALIDATORS.save(deps.storage, &initial_validator_set(msg.validators))?;
    SYNC_CURSOR.save(deps.storage, &0)?;
    ACTIVE_WINDOWS.save(deps.storage, &Vec::new())?;

    // A window is open from the first block, so a withdrawal request never has to wait
    // for one to be created.
    let first = windows::open(
        state::next_window_id(deps.storage)?,
        env.block.time.seconds(),
        config.params.unbond_window_secs,
    );
    WINDOWS.insert(deps.storage, &first.id, &first)?;
    OPEN_WINDOW.save(deps.storage, &first.id)?;

    TOTALS.save(
        deps.storage,
        &TotalsCache {
            last_sync_time: env.block.time.seconds(),
            ..Default::default()
        },
    )?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("manager", config.manager))
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
        ExecuteMsg::Receive {
            from, amount, msg, ..
        } => execute_receive(deps, env, info, from, amount, msg),
        ExecuteMsg::ClaimMatured { window_ids } => {
            execute_claim_matured(deps, env, info, window_ids)
        }
        ExecuteMsg::AdvanceWindow {} => execute_advance_window(deps, env),
        ExecuteMsg::CollectMatured { limit } => execute_collect_matured(deps, env, limit),
        ExecuteMsg::Compound { limit } => execute_compound(deps, env, limit),
        ExecuteMsg::Sync { limit } => execute_sync(deps, env, limit),
        ExecuteMsg::SetPaused { paused } => execute_set_paused(deps, info, paused),
        ExecuteMsg::Manager(m) => execute_manager(deps, env, info, m),
    }
}

/// SNIP-20 receiver hook: a user sent dSCRT here to request a withdrawal.
///
/// Deliberately not gated by `paused`. Pausing exists to stop new money entering a
/// protocol in trouble; using it to trap money inside would be the opposite of a safety
/// control.
fn execute_receive(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    from: String,
    amount: Uint128,
    msg: Option<Binary>,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let token = config.token()?.clone();

    // Only the derivative token may drive this. Without the check, anyone could invent a
    // burn of tokens they never held.
    if info.sender != token.address {
        return Err(ContractError::Unauthorized);
    }

    match msg.map(|m| from_binary::<ReceiveHookMsg>(&m)).transpose()? {
        Some(ReceiveHookMsg::Unbond {}) => {}
        None => {
            return Err(ContractError::Std(StdError::generic_err(
                "a withdrawal request must carry the Unbond hook message",
            )))
        }
    }

    if amount.is_zero() {
        return Err(ContractError::ZeroAmount);
    }

    let now = env.block.time.seconds();
    let mut totals = TOTALS.load(deps.storage)?;
    totals.assert_fresh(now, config.params.sync_stale_after_secs)?;

    let pool = pool_totals(deps.as_ref(), &env, &config, &totals, Uint128::zero())?;
    let owed = math::assets_for_shares(amount, &pool)?;
    if owed.is_zero() {
        return Err(ContractError::ZeroShares);
    }

    let window_id = OPEN_WINDOW.load(deps.storage)?;
    let mut window = load_window(deps.as_ref(), window_id)?;
    windows::assert_open(&window)?;

    window.shares_burned += amount;
    window.scrt_owed += owed;
    WINDOWS.insert(deps.storage, &window_id, &window)?;

    let claimant = deps.api.addr_validate(&from)?;
    record_claim(deps.storage, &claimant, window_id, amount, owed)?;

    // The shares are gone from circulation now; the SCRT they priced becomes a liability
    // and stops backing the remaining supply.
    totals.total_supply = totals.total_supply.saturating_sub(amount);
    totals.scrt_owed_open += owed;
    TOTALS.save(deps.storage, &totals)?;

    let burn = TokenExecuteMsg::Burn {
        amount,
        memo: None,
        padding: None,
    }
    .to_cosmos_msg(token.code_hash, token.address.to_string(), None)?;

    Ok(Response::new()
        .add_message(burn)
        .add_attribute("action", "unbond")
        .set_data(to_binary(&ExecuteAnswer::Unbond {
            window_id,
            shares_burned: amount,
            scrt_owed: owed,
            matures_at_estimate: window
                .closes_at
                .saturating_add(config.params.unbonding_period_secs),
        })?))
}

/// Close the open window, issue its undelegations, and open the next one.
fn execute_advance_window(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let now = env.block.time.seconds();

    let closing_id = OPEN_WINDOW.load(deps.storage)?;
    let mut window = load_window(deps.as_ref(), closing_id)?;
    windows::assert_closable(&window, now)?;

    let mut messages: Vec<CosmosMsg> = Vec::new();
    let undelegated = window.scrt_owed;

    if !undelegated.is_zero() {
        let mut set = VALIDATORS.load(deps.storage)?;
        let legs = validators::plan_undelegation(
            &set,
            undelegated,
            config.params.max_unbond_entries_per_validator,
        )?;

        for leg in &legs {
            let entry = &mut set[leg.index];
            entry.bonded = entry.bonded.saturating_sub(leg.amount);
            // The slot stays occupied until this window matures.
            entry.active_unbond_entries = entry.active_unbond_entries.saturating_add(1);
            window.validators_used.push(entry.address.clone());

            messages.push(CosmosMsg::Staking(StakingMsg::Undelegate {
                validator: entry.address.clone(),
                amount: Coin {
                    denom: config.bonded_denom.clone(),
                    amount: leg.amount,
                },
            }));
        }

        VALIDATORS.save(deps.storage, &set)?;

        let mut totals = TOTALS.load(deps.storage)?;
        totals.total_bonded = totals.total_bonded.saturating_sub(undelegated);
        // The liability follows the money: out of the bonded pool, into the staking
        // module's unbonding queue, where it backs neither figure.
        totals.scrt_owed_open = totals.scrt_owed_open.saturating_sub(undelegated);
        totals.scrt_owed_unbonding += undelegated;
        TOTALS.save(deps.storage, &totals)?;
    }

    let closure = windows::close(&mut window, now, config.params.unbonding_period_secs);
    WINDOWS.insert(deps.storage, &closing_id, &window)?;

    if closure == windows::Closure::Unbonding {
        let mut active = ACTIVE_WINDOWS.load(deps.storage)?;
        active.push(closing_id);
        ACTIVE_WINDOWS.save(deps.storage, &active)?;
    }

    let next = windows::open(
        state::next_window_id(deps.storage)?,
        now,
        config.params.unbond_window_secs,
    );
    WINDOWS.insert(deps.storage, &next.id, &next)?;
    OPEN_WINDOW.save(deps.storage, &next.id)?;

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "advance_window")
        .set_data(to_binary(&ExecuteAnswer::AdvanceWindow {
            closed_window_id: closing_id,
            new_window_id: next.id,
            scrt_undelegated: undelegated,
        })?))
}

/// Mark windows whose unbonding period has elapsed as claimable.
fn execute_collect_matured(
    deps: DepsMut,
    env: Env,
    limit: Option<u32>,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let now = env.block.time.seconds();
    let limit = limit.unwrap_or(DEFAULT_SYNC_LIMIT).max(1) as usize;

    let active = ACTIVE_WINDOWS.load(deps.storage)?;
    let balance = deps
        .querier
        .query_balance(&env.contract.address, &config.bonded_denom)?
        .amount;

    // Money already spoken for by windows that matured earlier is not available to this
    // one. Without this, a shortfall in an old window would be papered over by a newer
    // window's returns and the loss would land on whoever claimed last.
    let mut spoken_for = Uint128::zero();
    for id in &active {
        let w = load_window(deps.as_ref(), *id)?;
        if w.state == WindowState::Matured {
            spoken_for += w.outstanding();
        }
    }

    let mut matured = Vec::new();
    let mut validators_to_release: Vec<String> = Vec::new();
    let mut promised_total = Uint128::zero();
    let mut realised_total = Uint128::zero();

    for id in active.iter().copied() {
        if matured.len() >= limit {
            break;
        }
        let mut window = load_window(deps.as_ref(), id)?;
        if !windows::is_mature(&window, now) {
            continue;
        }

        let available = balance.saturating_sub(spoken_for);
        windows::mature(&mut window, available);

        let realised = window.payable();
        spoken_for += realised;
        promised_total += window.scrt_owed;
        realised_total += realised;

        validators_to_release.extend(window.validators_used.iter().cloned());
        WINDOWS.insert(deps.storage, &id, &window)?;
        matured.push(id);
    }

    if !matured.is_empty() {
        // Entry slots are free again now that the chain has released the stake.
        let mut set = VALIDATORS.load(deps.storage)?;
        for address in &validators_to_release {
            if let Some(entry) = set.iter_mut().find(|v| &v.address == address) {
                entry.active_unbond_entries = entry.active_unbond_entries.saturating_sub(1);
            }
        }
        VALIDATORS.save(deps.storage, &set)?;

        // The liability arrives in the balance and shrinks to what actually came back.
        // Carrying the promised figure forward would leave the contract permanently
        // claiming to owe money the chain never returned.
        let mut totals = TOTALS.load(deps.storage)?;
        totals.scrt_owed_unbonding = totals.scrt_owed_unbonding.saturating_sub(promised_total);
        totals.scrt_owed_matured += realised_total;
        TOTALS.save(deps.storage, &totals)?;
    }

    Ok(Response::new()
        .add_attribute("action", "collect_matured")
        .set_data(to_binary(&ExecuteAnswer::CollectMatured {
            windows_matured: matured,
        })?))
}

/// Pay out a caller's claims against matured windows.
fn execute_claim_matured(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    window_ids: Option<Vec<u64>>,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let claims = state::claims_for(&info.sender);

    let ids = match window_ids {
        Some(ids) => ids,
        None => {
            let index = state::claim_index_for(&info.sender);
            index.iter(deps.storage)?.collect::<StdResult<Vec<u64>>>()?
        }
    };

    let mut paid = Uint128::zero();
    let mut settled = Vec::new();

    for id in ids {
        let Some(mut claim) = claims.get(deps.storage, &id) else {
            continue;
        };
        if claim.claimed {
            continue;
        }

        let mut window = load_window(deps.as_ref(), id)?;
        match window.state {
            WindowState::Matured => {}
            // Silently skipping an immature window would make "claim everything" quietly
            // do nothing; naming the window and its maturity is more use to the caller.
            WindowState::Unbonding => {
                return Err(ContractError::WindowNotMatured {
                    id,
                    matures_at: window.matures_at,
                    now: env.block.time.seconds(),
                })
            }
            _ => continue,
        }

        let payout = windows::payout_for_claim(&window, claim.scrt_owed)?;

        claim.claimed = true;
        claims.insert(deps.storage, &id, &claim)?;

        window.scrt_claimed += payout;
        if windows::is_drained(&window) {
            window.state = WindowState::Settled;
            settled.push(id);
        }
        WINDOWS.insert(deps.storage, &id, &window)?;

        paid += payout;
    }

    if paid.is_zero() {
        return Err(ContractError::NothingToClaim);
    }

    let mut totals = TOTALS.load(deps.storage)?;
    totals.scrt_owed_matured = totals.scrt_owed_matured.saturating_sub(paid);
    TOTALS.save(deps.storage, &totals)?;

    prune_settled_windows(deps, &settled)?;

    Ok(Response::new()
        .add_message(CosmosMsg::Bank(BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: vec![Coin {
                denom: config.bonded_denom,
                amount: paid,
            }],
        }))
        .add_attribute("action", "claim_matured")
        .set_data(to_binary(&ExecuteAnswer::ClaimMatured {
            scrt_claimed: paid,
            windows_settled: settled,
        })?))
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
    match &config.deployer {
        Some(deployer) if deployer == &info.sender => {}
        // Either someone else is calling, or the right has already been spent.
        Some(_) => return Err(ContractError::Unauthorized),
        None => return Err(ContractError::TokenAlreadyRegistered),
    }
    if config.token.is_some() {
        return Err(ContractError::TokenAlreadyRegistered);
    }
    // Spend the right. From here the token address is fixed for the life of the contract.
    config.deployer = None;

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

/// Withdraw staking rewards, take the protocol's cut, and restake the rest.
///
/// Permissionless, like `Sync`: the keeper runs it on a schedule, but nothing about it
/// needs to be privileged, and making it privileged would mean a stalled keeper freezes
/// everyone's yield.
///
/// Paginated over the validator set. Each validator costs a staking query, a withdraw and
/// a delegate, and sweeping a large set in one transaction would risk the block gas limit
/// — the failure mode being that compounding stops working exactly when the protocol has
/// grown enough to need it.
fn execute_compound(
    deps: DepsMut,
    env: Env,
    limit: Option<u32>,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut set = VALIDATORS.load(deps.storage)?;
    if set.is_empty() {
        return Err(ContractError::EmptyValidatorSet);
    }

    let cursor = SYNC_CURSOR.may_load(deps.storage)?.unwrap_or(0) as usize;
    let limit = limit.unwrap_or(DEFAULT_COMPOUND_LIMIT).max(1) as usize;
    let end = (cursor + limit).min(set.len());

    let totals_before = TOTALS.load(deps.storage)?;
    let pool_before = pool_totals(
        deps.as_ref(),
        &env,
        &config,
        &totals_before,
        Uint128::zero(),
    )?;

    let mut messages: Vec<CosmosMsg> = Vec::new();
    let mut harvested = Uint128::zero();

    for entry in set.iter_mut().take(end).skip(cursor) {
        // Re-read rather than trusting the cached figure: rewards accrue every block, and
        // withdrawing sends whatever is actually there, not what was cached.
        let delegation = deps
            .querier
            .query_delegation(&env.contract.address, &entry.address)?;

        let rewards = delegation
            .as_ref()
            .and_then(|d| {
                d.accumulated_rewards
                    .iter()
                    .find(|c| c.denom == config.bonded_denom)
            })
            .map(|c| c.amount)
            .unwrap_or_else(Uint128::zero);

        if let Some(d) = &delegation {
            entry.bonded = d.amount.amount;
        }
        entry.pending_rewards = Uint128::zero();

        if rewards.is_zero() {
            continue;
        }

        harvested += rewards;
        messages.push(CosmosMsg::Distribution(
            DistributionMsg::WithdrawDelegatorReward {
                validator: entry.address.clone(),
            },
        ));
    }

    // Restake everything harvested, spread by the same underweight rule deposits use, so
    // compounding pulls the set toward its target weights instead of entrenching drift.
    let mut fee_shares = Uint128::zero();
    if !harvested.is_zero() {
        let target = validators::select_for_delegation(&set, harvested)?;
        set[target].bonded += harvested;

        messages.push(delegate_msg(
            &set[target].address,
            &config.bonded_denom,
            harvested,
        ));

        // The fee is taken as freshly minted shares rather than withdrawn SCRT: the whole
        // reward stays staked and no bank transfer is needed per cycle. Minting must be
        // priced against the pool *before* the rewards land, which is why `pool_before`
        // is captured at the top.
        fee_shares = math::fee_shares_for_rewards(
            harvested,
            config.params.performance_fee_bps,
            &pool_before,
        )?;

        if !fee_shares.is_zero() {
            let token = config.token()?;
            messages.push(
                TokenExecuteMsg::Mint {
                    recipient: config.treasury.to_string(),
                    amount: fee_shares,
                    memo: Some("performance fee".to_string()),
                    padding: None,
                }
                .to_cosmos_msg(
                    token.code_hash.clone(),
                    token.address.to_string(),
                    None,
                )?,
            );
        }
    }

    let done = end >= set.len();
    let processed = (end - cursor) as u32;

    VALIDATORS.save(deps.storage, &set)?;
    SYNC_CURSOR.save(deps.storage, &(if done { 0 } else { end as u32 }))?;

    let mut totals = TOTALS.load(deps.storage)?;
    totals.total_bonded = validators::total_bonded(&set);
    totals.pending_rewards = set
        .iter()
        .fold(Uint128::zero(), |acc, v| acc + v.pending_rewards);
    totals.total_supply += fee_shares;
    if done {
        totals.last_sync_time = env.block.time.seconds();
    }
    TOTALS.save(deps.storage, &totals)?;

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "compound")
        .set_data(to_binary(&ExecuteAnswer::Compound {
            rewards_withdrawn: harvested,
            fee_shares_minted: fee_shares,
            validators_processed: processed,
            done,
        })?))
}

/// The manager: fees and validator distribution, nothing else.
///
/// This is the whole of the contract's mutable authority. Everything outside it moves only
/// when the network votes in a new code version.
fn execute_manager(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: ManagerMsg,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.manager {
        return Err(ContractError::Unauthorized);
    }

    let mut messages: Vec<CosmosMsg> = Vec::new();

    match msg {
        ManagerMsg::SetWeights { weights } => {
            let allowlist = ALLOWLIST.may_load(deps.storage)?.unwrap_or_default();
            validators::validate_managed_weights(
                &weights,
                &allowlist,
                config.limits.max_validator_weight_bps,
            )?;

            let mut set = VALIDATORS.load(deps.storage)?;
            validators::apply_weights(&mut set, &weights);
            VALIDATORS.save(deps.storage, &set)?;
        }

        ManagerMsg::SetPerformanceFee { bps } => {
            if bps > config.limits.max_performance_fee_bps {
                return Err(ContractError::FeeTooHigh {
                    got: bps,
                    max: config.limits.max_performance_fee_bps,
                });
            }
            config.params.performance_fee_bps = bps;
            CONFIG.save(deps.storage, &config)?;
        }

        ManagerMsg::Rebalance { plan } => {
            let mut set = VALIDATORS.load(deps.storage)?;
            let allowlist = ALLOWLIST.may_load(deps.storage)?.unwrap_or_default();

            for step in &plan {
                // Redelegating *to* somewhere off the allowlist would route stake to a
                // validator the network never approved — the same escape the weight check
                // closes, reached by a different door.
                if !allowlist.iter().any(|a| a == &step.dst_validator) {
                    return Err(ContractError::ValidatorNotAllowed {
                        address: step.dst_validator.clone(),
                    });
                }

                let src = set
                    .iter()
                    .position(|v| v.address == step.src_validator)
                    .ok_or_else(|| ContractError::UnknownValidator {
                        address: step.src_validator.clone(),
                    })?;

                if set[src].bonded < step.amount {
                    return Err(ContractError::InsufficientBalance {
                        needed: step.amount,
                        available: set[src].bonded,
                    });
                }
                set[src].bonded -= step.amount;

                match set.iter().position(|v| v.address == step.dst_validator) {
                    Some(dst) => set[dst].bonded += step.amount,
                    None => {
                        return Err(ContractError::UnknownValidator {
                            address: step.dst_validator.clone(),
                        })
                    }
                }

                messages.push(CosmosMsg::Staking(StakingMsg::Redelegate {
                    src_validator: step.src_validator.clone(),
                    dst_validator: step.dst_validator.clone(),
                    amount: Coin {
                        denom: config.bonded_denom.clone(),
                        amount: step.amount,
                    },
                }));
            }

            VALIDATORS.save(deps.storage, &set)?;
        }
    }

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "manager")
        .set_data(to_binary(&ExecuteAnswer::Ok {})?))
}

/// Reject manager limits that exceed what the code itself permits.
///
/// Governance can tighten these but never loosen them past the compiled ceilings. Raising
/// the hard limits requires shipping new code, which is a visible, reviewable event rather
/// than a parameter flip.
fn validate_limits(limits: &ManagerLimits) -> Result<(), ContractError> {
    if limits.max_performance_fee_bps > MAX_PERFORMANCE_FEE_BPS
        || limits.max_validator_weight_bps > MAX_VALIDATOR_WEIGHT_BPS
        || limits.max_validator_weight_bps == 0
    {
        return Err(ContractError::LimitsExceedCode);
    }
    Ok(())
}

fn execute_set_paused(
    deps: DepsMut,
    info: MessageInfo,
    paused: bool,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    // Pausing blocks deposits only. A rogue manager can turn away new money but cannot
    // trap anyone's funds, and the network answers that by voting in a version naming a
    // different manager.
    if info.sender != config.manager {
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
            let allowlist = ALLOWLIST.may_load(deps.storage)?.unwrap_or_default();
            to_binary(&QueryAnswer::Config(config.into_response(allowlist)))
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
        QueryMsg::Windows {
            state,
            start_after,
            limit,
        } => to_binary(&QueryAnswer::Windows {
            windows: query_windows(deps, state, start_after, limit)?,
        }),
        QueryMsg::WithPermit { permit, query } => {
            let account = permit_signer(deps, &env, &permit)?;
            match query {
                AuthQueryMsg::PendingClaims {} => to_binary(&query_pending_claims(deps, &account)?),
            }
        }
    }
}

/// Resolve a SNIP-24 permit to the address that signed it.
fn permit_signer(deps: Deps, env: &Env, permit: &Permit) -> StdResult<Addr> {
    let signer = validate(
        deps,
        PERMIT_PREFIX,
        permit,
        env.contract.address.to_string(),
        None,
    )?;
    deps.api.addr_validate(&signer)
}

/// A caller's claims, newest window first.
///
/// Private state: claims reveal that an address is leaving and how much it is taking, which
/// is exactly the sort of thing the derivative token's privacy exists to hide. Served only
/// behind a viewing key or a permit.
fn query_pending_claims(deps: Deps, account: &Addr) -> StdResult<QueryAnswer> {
    let claims = state::claims_for(account);
    let index = state::claim_index_for(account);
    let mut out = Vec::new();
    let mut total_owed = Uint128::zero();
    let mut claimable_now = Uint128::zero();

    for id in index.iter(deps.storage)?.collect::<StdResult<Vec<u64>>>()? {
        let Some(claim) = claims.get(deps.storage, &id) else {
            continue;
        };
        let Some(window) = WINDOWS.get(deps.storage, &id) else {
            continue;
        };

        // Report what the claim will actually pay, not what it was promised: a window that
        // came back short after a slashing pays pro-rata, and a user should see that
        // before they come to collect rather than after.
        let payable =
            windows::payout_for_claim(&window, claim.scrt_owed).map_err(StdError::from)?;

        if !claim.claimed {
            total_owed += payable;
            if window.state == WindowState::Matured {
                claimable_now += payable;
            }
        }

        out.push(UserClaim {
            window_id: id,
            shares_burned: claim.shares_burned,
            scrt_owed: payable,
            matures_at: window.matures_at,
            state: window.state,
            claimed: claim.claimed,
        });
    }

    out.sort_by_key(|c| std::cmp::Reverse(c.window_id));

    Ok(QueryAnswer::PendingClaims {
        claims: out,
        total_owed,
        total_claimable_now: claimable_now,
    })
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
        liquid_unallocated: pool.liquid.saturating_sub(totals.scrt_owed_matured),
        scrt_owed_to_windows: totals.owed_total(),
        total_supply: totals.total_supply,
        last_sync_time: totals.last_sync_time,
        is_stale: totals.is_stale(now, config.params.sync_stale_after_secs),
        exchange_rate: rate,
    })
}

/// Windows, oldest first, optionally filtered by state.
///
/// Public and unauthenticated on purpose. A window's size and timing are already visible
/// on-chain — the undelegations it issues are public — so hiding the aggregate would buy
/// no privacy while making it impossible for a user to see when their money is due, or for
/// anyone to check that the queue is being worked.
///
/// Individual claims are a different matter and stay behind a viewing key.
fn query_windows(
    deps: Deps,
    state: Option<WindowState>,
    start_after: Option<u64>,
    limit: Option<u32>,
) -> StdResult<Vec<UnbondWindow>> {
    let limit = limit.unwrap_or(DEFAULT_WINDOW_PAGE).min(MAX_WINDOW_PAGE) as usize;
    let next_id = NEXT_WINDOW_ID.may_load(deps.storage)?.unwrap_or(0);
    let start = start_after.map_or(0, |id| id.saturating_add(1));

    let mut out = Vec::new();
    for id in start..next_id {
        if out.len() >= limit {
            break;
        }
        // A window can be absent if it was pruned; skipping keeps the scan total rather
        // than aborting a page because of a gap.
        let Some(window) = WINDOWS.get(deps.storage, &id) else {
            continue;
        };
        // Spelled out rather than using `is_none_or`, which is newer than this crate's
        // declared MSRV and would not build on the optimizer image's toolchain.
        let wanted = match state {
            Some(filter) => filter == window.state,
            None => true,
        };
        if wanted {
            out.push(window);
        }
    }

    Ok(out)
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

    Ok(PoolTotals {
        bonded: totals.total_bonded,
        pending_rewards: totals.pending_rewards,
        liquid: balance.saturating_sub(exclude),
        owed_backed: totals.owed_backed(),
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

fn load_window(deps: Deps, id: u64) -> Result<UnbondWindow, ContractError> {
    WINDOWS
        .get(deps.storage, &id)
        .ok_or(ContractError::WindowNotOpen { id })
}

/// Add a claim, merging with any the caller already holds against the same window.
///
/// Merging matters: a user who withdraws twice inside one window must end up with one
/// claim for the sum, not a second record that overwrites the first and silently loses
/// their earlier money.
fn record_claim(
    storage: &mut dyn Storage,
    claimant: &Addr,
    window_id: u64,
    shares: Uint128,
    owed: Uint128,
) -> Result<(), ContractError> {
    let claims = state::claims_for(claimant);

    match claims.get(storage, &window_id) {
        Some(mut existing) => {
            existing.shares_burned += shares;
            existing.scrt_owed += owed;
            claims.insert(storage, &window_id, &existing)?;
        }
        None => {
            claims.insert(
                storage,
                &window_id,
                &ClaimRecord {
                    window_id,
                    shares_burned: shares,
                    scrt_owed: owed,
                    claimed: false,
                },
            )?;
            state::claim_index_for(claimant).push(storage, &window_id)?;
        }
    }

    Ok(())
}

/// Drop fully settled windows from the active list so it stays short.
fn prune_settled_windows(deps: DepsMut, settled: &[u64]) -> Result<(), ContractError> {
    if settled.is_empty() {
        return Ok(());
    }
    let mut active = ACTIVE_WINDOWS.load(deps.storage)?;
    active.retain(|id| !settled.contains(id));
    ACTIVE_WINDOWS.save(deps.storage, &active)?;
    Ok(())
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

/// Code upgrade.
///
/// Migration is authorised by the *contract admin*, which is chain-level state rather than
/// anything this contract stores — so who may upgrade is decided outside this code
/// entirely. That is deliberate: it is the one power that can rewrite every other rule,
/// and it should not sit behind a flag the contract itself can flip.
#[entry_point]
pub fn migrate(_deps: DepsMut, _env: Env, _msg: MigrateMsg) -> Result<Response, ContractError> {
    Ok(Response::new().add_attribute("action", "migrate"))
}
