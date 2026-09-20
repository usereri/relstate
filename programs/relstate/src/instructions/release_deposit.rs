use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::payout::pay_out_vault;

use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct ReleaseDeposit<'info> {
    pub landlord: Signer<'info>,
    #[account(
        mut,
        has_one = landlord,
        has_one = mint,
        seeds = [LEASE_SEED, landlord.key().as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump
    )]
    pub lease: Account<'info, Lease>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        mut, 
        seeds = [VAULT_SEED, lease.key().as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = lease.tenant
    )]
    pub tenant_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = landlord
    )]
    pub landlord_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, lease.tenant.as_ref()],
        bump
    )]
    pub tenant_profile: Account<'info, Profile>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, landlord.key().as_ref()],
        bump
    )]
    pub landlord_profile:Account<'info, Profile>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_release_deposit(ctx: Context<ReleaseDeposit>, deduction: u64) -> Result<()> {
    let lease = &ctx.accounts.lease;
    require!(
        lease.status == Status::Active,
    ErrorCode::WrongStatus
);
    require!(
        lease.paid_count == lease.term_periods, 
        ErrorCode::TermIncomplete
    );
    let end = lease.start_ts + lease.term_periods as i64 * lease.period_secs;
    require!(
        Clock::get()?.unix_timestamp >= end,
        ErrorCode::LeaseNotEnded
    );
    require!(
        deduction <= lease.deposit_amount, 
        ErrorCode::DeductionTooLarge
    );

    pay_out_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.lease,
        &ctx.accounts.mint,
        &ctx.accounts.vault,
        &ctx.accounts.tenant_ata,
        &ctx.accounts.landlord_ata,
        lease.deposit_amount - deduction,
        deduction,
    )?;

    let tenant = &mut ctx.accounts.tenant_profile;
    tenant.leases_completed += 1;
    let landlord = &mut ctx.accounts.landlord_profile;
    landlord.leases_completed += 1;
    for profile in [tenant, landlord] {
        profile.deposit_total += lease.deposit_amount;
        profile.deducted_total += deduction;
        if deduction == 0 {
            profile.deposits_returned_full += 1;
        }
    }

    let lease = &mut ctx.accounts.lease;
    lease.status = Status::Closed;
    emit!(LeaseClosed {
        lease: lease.key(),
        deduction,
    });
    Ok(())
}