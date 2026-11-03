use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{constants::*, error::ErrorCode, instructions::attest::enforce_kyc, state::*};

#[derive(Accounts)]
#[instruction(lease_id: u64)]
pub struct ProposeLease<'info> {
    #[account(mut)]
    pub landlord: Signer<'info>,
    /// CHECK: only stored as the counterparty key. It signs later in fund_deposit 
    pub tenant: UncheckedAccount<'info>,
    /// CHECK: the tenant's record PDA, forced by the seeds so the landlord cannot swap in another
    /// account. It may not exist yet (first-time tenant), so it is read by hand in the handler.
    #[account(seeds = [PROFILE_SEED, tenant.key().as_ref()], bump)]
    pub tenant_profile: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: the landlord's attestation PDA, forced by the seeds. Read by hand in the handler
    /// because an unverified wallet has no account here (see `apply`).
    #[account(seeds = [ATTESTATION_SEED, landlord.key().as_ref()], bump)]
    pub attestation: UncheckedAccount<'info>,
    #[account(constraint = config.allows(&mint.key()) @ ErrorCode::MintNotAllowed)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init, 
        payer = landlord,
        space = 8 + Lease::INIT_SPACE,
        seeds = [LEASE_SEED, landlord.key().as_ref(), &lease_id.to_le_bytes()],
        bump
    )]
    pub lease: Account<'info, Lease>,
    #[account(
        init, 
        payer = landlord,
        seeds = [VAULT_SEED, lease.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = lease
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = landlord,
        space = 8 + Profile::INIT_SPACE,
        seeds = [PROFILE_SEED, landlord.key().as_ref()],
        bump
    )]
    pub landlord_profile: Account<'info, Profile>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_propose_lease(
    ctx: Context<ProposeLease>,
    lease_id: u64,
    rent_amount: u64,
    standard_deposit: u64,
    period_secs: i64,
    grace_secs: i64,
    term_periods: u16,
    lease_hash: [u8; 32],
    region: [u8; 2],
) -> Result<()> {
    let landlord = ctx.accounts.landlord.key();
    require_keys_neq!(landlord, ctx.accounts.tenant.key(), ErrorCode::SelfLease);
    require!(rent_amount > 0, ErrorCode::ZeroRent);
    require!(standard_deposit > 0, ErrorCode::ZeroDeposit);
    require!(term_periods > 0, ErrorCode::ZeroTerm);
    require!(period_secs >= MIN_PERIOD_SECS, ErrorCode::PeriodTooShort);
    require!(
        (0..=period_secs).contains(&grace_secs),
        ErrorCode::InvalidGrace
    );
    // Bounds the whole lease from above, so every later `start + k * period` is far from
    // overflowing and a funded deposit can always become releasable or claimable.
    let term_secs = (term_periods as i64)
        .checked_mul(period_secs)
        .ok_or_else(|| error!(ErrorCode::TermTooLong))?;
    require!(term_secs <= MAX_LEASE_SECS, ErrorCode::TermTooLong);

    require!(region.iter().all(u8::is_ascii_uppercase), ErrorCode::InvalidRegion);

    // The landlord is the acting wallet here, so the landlord is who the gate asks about — the
    // tenant is vetted when they apply. Inert while `Config::require_kyc` is false.
    enforce_kyc(
        &ctx.accounts.config,
        &ctx.accounts.attestation.to_account_info(),
        &landlord,
        Clock::get()?.unix_timestamp,
    )?;

    let record = &ctx.accounts.tenant_profile;
    let discount_pct = if record.owner == &crate::ID && !record.data_is_empty() {
        let tenant_profile = Profile::try_deserialize(&mut &record.try_borrow_data()?[..])?;
        if tenant_profile.deserves_discount(rent_amount) { GOOD_STANDING_DISCOUNT_PCT } else { 0 }
    } else {
        0
    };
    let deposit_amount = (standard_deposit as u128 * (100 - discount_pct as u128) / 100) as u64;
    // A discount on a tiny standard deposit can round to nothing; a lease with no deposit has no
    // outcome to record and would only inflate the return-rate denominator.
    require!(deposit_amount > 0, ErrorCode::ZeroDeposit);

    let lease = &mut ctx.accounts.lease;
    lease.landlord = landlord;
    lease.tenant = ctx.accounts.tenant.key();
    lease.mint = ctx.accounts.mint.key();
    lease.lease_id = lease_id;
    lease.rent_amount = rent_amount;
    lease.deposit_amount = deposit_amount;
    lease.period_secs = period_secs;
    lease.grace_secs = grace_secs;
    lease.start_ts = 0;
    lease.term_periods = term_periods;
    lease.paid_count = 0;
    lease.lease_hash = lease_hash;
    lease.region = region;
    lease.discount_pct = discount_pct;
    lease.status = Status::Proposed;
    lease.bump = ctx.bumps.lease;
    // Set explicitly rather than left to the zeroed account, so the dispute state of a fresh
    // lease is a statement in the code and not an accident of `init`.
    lease.proposed_deduction = 0;
    lease.disputed_at = 0;
    lease.claim_pause_secs = 0;
    lease.dispute_rounds = 0;

    ctx.accounts.landlord_profile.wallet = landlord;
    Ok(())
}
