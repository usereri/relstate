use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct PayRent<'info> {
    pub tenant: Signer<'info>,
    #[account(
        mut,
        has_one = tenant,
        has_one = mint, 
        seeds = [LEASE_SEED, lease.landlord.as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump
    )]
    pub lease: Account<'info, Lease>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut, 
        token::mint = mint, 
        token::authority = tenant
    )]
    pub tenant_ata: Account<'info, TokenAccount>,
    #[account(
        mut, 
        token::mint = mint, 
        token::authority = lease.landlord
    )]
    pub landlord_ata: Account<'info, TokenAccount>,
    #[account(
        mut, 
        seeds = [PROFILE_SEED, tenant.key().as_ref()],
        bump
    )]
    pub tenant_profile: Account<'info, Profile>,
    pub token_program: Account<'info, Token>,
}

pub fn handle_pay_rent(ctx: Context<PayRent>) -> Result<()> {
    let lease = &ctx.accounts.lease;
    require!(
        lease.status == Status::Active,
        ErrorCode::WrongStatus
    );

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked{
                from: ctx.account.tenant_ata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.landlord_ata.to_account_info(),
                authority: ctx.accounts.tenant.to_account_info(),
            },
        ),
        lease.rent.amount,
        ctx.accounts.mint.decimals,
    )?;

    let due = lease.start_ts + lease.paid_count as i64 * lease.period_secs;
    let on_time = Clock::get()?.unix_timestamp <= due + lease.period_secs / 10;

    let profile = &mut ctx.account.tenant_profile;
    if on_time {
        profile.paid_on_time += 1;
    } else {
        profile.paid_late += 1;
    }

    let lease = &mut ctx.accounts.lease;
    lease.paid_count += 1;
    emit!(RentPaid {
        lease: lease.key(),
        period: lease.paid_count,
        on_time,
    });
    Ok(())
}