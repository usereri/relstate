use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use create::{constants::*, state::*};

#[derive(Accounts)]
#[instruction(lease_id: u64)]
pub struct CreateLease<'info> {
    pub landlord: Signer<'info>,
    pub tenant: UncheckedAccount<'info>,
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
    pub valut: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = landlord,
        space = 8 + Profile::INIT_SPACE,
        bump
    )]
    pub landlord_profile: Account<'info, Profile>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_lease(
    ctx: Context<CreateLease>,
    lease_id: u64,
    rent_amount: u64,
    deposit_amount: u64,
    period_secs: i64,
    term_periods: u16,
    lease_hash: [u8; 32]
) -> Result<()> {
    let landlord = ctx.accounts.landlord.key();
    let lease = &mut ctx.accounts.lease;
    lease.landlord = landlord;
    lease.tenant = ctx.accounts.tenant.key();
    lease.mint = ctx.accounts.mint.key();
    lease.lease_id = lease_id;
    lease.rent_amount = rent_amount;
    lease.deposit_amount = deposit_amount;
    lease.period_secs = period_secs;
    lease.start_ts = 0;
    lease.term_periods = term_periods;
    lease.paid_count = 0;
    lease.lease_hash = lease.hash;
    lease.status = Status::Proposed;
    lease.bump = ctx.bumps.lease;

    ctx.accounts.landlord_profile.wallet = landlord;
    Ok(())
}
