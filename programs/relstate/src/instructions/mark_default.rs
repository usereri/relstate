use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::payout::pay_out_vault;
use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct MarkDefault<'info> {
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
    pub token_program: Program<'info, Token>,
}

pub fn handle_mark_default(ctx: Context<MarkDefault>) -> Result<()> {
    let lease = &ctx.accounts.lease;
    require!(lease.status == Status::Active, ErrorCode::WrongStatus);
    require!(lease.paid_count < lease.term_periods, ErrorCode::TermCompleted);

    // the oldest unpaid period must be a full period (plus grace) overdue
    let now = Clock::get()?.unix_timestamp;
    let due = lease.start_ts + lease.paid_count as i64 * lease.period_secs;
    require!(
        now > due + lease.grace_secs + lease.period_secs,
        ErrorCode::NotInDefault
    );

    // The deposit covers the rent owed for every period already due but unpaid
    // (at least one, by the check above); the rest goes back to the tenant.
    let due_periods = ((now - lease.start_ts) / lease.period_secs + 1).min(lease.term_periods as i64);
    let owed = ((due_periods - lease.paid_count as i64) as u64).saturating_mul(lease.rent_amount);
    let seized = owed.min(lease.deposit_amount);

    pay_out_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.lease,
        &ctx.accounts.mint,
        &ctx.accounts.vault,
        &ctx.accounts.tenant_ata,
        &ctx.accounts.landlord_ata,
        lease.deposit_amount - seized,
        seized,
    )?;

    ctx.accounts.tenant_profile.defaults += 1;

    let lease = &mut ctx.accounts.lease;
    lease.status = Status::Defaulted;
    emit!(LeaseDefaulted {
        lease: lease.key(),
        seized,
    });
    Ok(())
}
