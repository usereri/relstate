use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{constants::*, error::ErrorCode, state::*};

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
    #[account(address = ALLOWED_MINT @ ErrorCode::MintNotAllowed)]
    pub mint: Account<'info, Mint>,
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
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = landlord,
        space = 8 + Profile::INIT_SPACE,
        seeds = [PROFILE_SEED, landlord.key().as_ref()],
        bump
    )]
    pub landlord_profile: Account<'info, Profile>,
    pub token_program: Program<'info, Token>,
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
    require!(term_periods > 0, ErrorCode::ZeroTerm);
    require!(period_secs >= MIN_PERIOD_SECS, ErrorCode::PeriodTooShort);
    require!(
        (0..=period_secs).contains(&grace_secs),
        ErrorCode::InvalidGrace
    );

    require!(region.iter().all(u8::is_ascii_uppercase), ErrorCode::InvalidRegion);

    let record = &ctx.accounts.tenant_profile;
    let discount_pct = if record.owner == &crate::ID && !record.data_is_empty() {
        let tenant_profile = Profile::try_deserialize(&mut &record.try_borrow_data()?[..])?;
        if tenant_profile.deserves_discount(rent_amount) { GOOD_STANDING_DISCOUNT_PCT } else { 0 }
    } else {
        0
    };
    let deposit_amount = (standard_deposit as u128 * (100 - discount_pct as u128) / 100) as u64;

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

    ctx.accounts.landlord_profile.wallet = landlord;
    Ok(())
}
