use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::payout::pay_out_vault;
use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct ClaimDeposit<'info> {
    pub tenant: Signer<'info>,
    #[account(
        mut,
        has_one = tenant,
        has_one = mint,
        seeds = [LEASE_SEED, lease.landlord.as_ref(), &lease.lease_id.to_le_bytes()],
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
        token::authority = tenant
    )]
    pub tenant_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = lease.landlord
    )]
    pub landlord_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, tenant.key().as_ref()],
        bump
    )]
    pub tenant_profile: Account<'info, Profile>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, lease.landlord.as_ref()],
        bump
    )]
    pub landlord_profile: Account<'info, Profile>,
    pub token_program: Program<'info, Token>,
}

/// Escape hatch for a landlord who never calls `release_deposit`: once the term is fully
/// paid and CLAIM_WINDOW_SECS have passed since it ended, the tenant takes the whole deposit.
pub fn handle_claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
    let lease = &ctx.accounts.lease;
    require!(lease.status == Status::Active, ErrorCode::WrongStatus);
    require!(lease.paid_count == lease.term_periods, ErrorCode::TermIncomplete);
    let end = lease.start_ts + lease.term_periods as i64 * lease.period_secs;
    require!(
        Clock::get()?.unix_timestamp >= end + CLAIM_WINDOW_SECS,
        ErrorCode::ClaimTooEarly
    );

    pay_out_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.lease,
        &ctx.accounts.mint,
        &ctx.accounts.vault,
        &ctx.accounts.tenant_ata,
        &ctx.accounts.landlord_ata,
        lease.deposit_amount,
        0,
    )?;

    let tenant = &mut ctx.accounts.tenant_profile;
    tenant.leases_completed += 1;
    tenant.deposits_returned_full += 1;
    tenant.deposit_total += lease.deposit_amount;
    let landlord = &mut ctx.accounts.landlord_profile;
    landlord.leases_completed += 1;
    landlord.deposits_claimed += 1;
    landlord.deposit_total += lease.deposit_amount;

    let lease = &mut ctx.accounts.lease;
    lease.status = Status::Closed;
    emit!(LeaseClosed {
        lease: lease.key(),
        deduction: 0,
    });
    Ok(())
}
