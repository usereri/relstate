use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

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
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, lease.key().as_ref()],
        bump
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = tenant
    )]
    pub tenant_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = lease.landlord
    )]
    pub landlord_ata: Box<InterfaceAccount<'info, TokenAccount>>,
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
    pub token_program: Interface<'info, TokenInterface>,
}

/// Escape hatch for a landlord who never calls `release_deposit`: once the term is fully
/// paid and CLAIM_WINDOW_SECS have passed since it ended, the tenant takes the whole deposit.
///
/// Two things keep this honest next to the dispute flow. A `Disputed` lease is not `Active`, so
/// the status check below is what pauses the clock while a proposed deduction is open — the tenant
/// cannot sit out the window and take everything regardless. And `claim_deadline()` adds back the
/// time the lease spent disputed, so a rejected proposal costs the tenant nothing and buys the
/// landlord no delay.
pub fn handle_claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
    let lease = &ctx.accounts.lease;
    require!(lease.status == Status::Active, ErrorCode::WrongStatus);
    require!(lease.paid_count == lease.term_periods, ErrorCode::TermIncomplete);
    require!(
        Clock::get()?.unix_timestamp >= lease.claim_deadline(),
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

    let deposit = lease.deposit_amount;
    let tenant = &mut ctx.accounts.tenant_profile;
    tenant.leases_completed = tenant.leases_completed.saturating_add(1);
    tenant.deposits_returned_full = tenant.deposits_returned_full.saturating_add(1);
    tenant.record_deposit_outcome(deposit, 0)?;

    let landlord = &mut ctx.accounts.landlord_profile;
    landlord.leases_completed = landlord.leases_completed.saturating_add(1);
    // The landlord's return rate for this lease is 10000 — the tenant did get it all back — but
    // `deposits_claimed` is bumped instead of `deposits_returned_full` and stays a separate,
    // negative signal: this landlord never acted. Read the two side by side (A2 in the plan).
    landlord.deposits_claimed = landlord.deposits_claimed.saturating_add(1);
    landlord.record_deposit_outcome(deposit, 0)?;

    let lease = &mut ctx.accounts.lease;
    lease.status = Status::Closed;
    emit!(LeaseClosed {
        lease: lease.key(),
        deduction: 0,
    });
    Ok(())
}
