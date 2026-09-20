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
    pub token_program: Program<'info, Token>,
}

pub fn handle_pay_rent(ctx: Context<PayRent>) -> Result<()> {
    let lease = &ctx.accounts.lease;
    require!(
        lease.status == Status::Active,
        ErrorCode::WrongStatus
    );
    require!(
        lease.paid_count < lease.term_periods,
        ErrorCode::TermCompleted
    );

    // no prepaying: period k can only be paid once it is due
    let due = lease.start_ts + lease.paid_count as i64 * lease.period_secs;
    let now = Clock::get()?.unix_timestamp;
    require!(now >= due, ErrorCode::TooEarly);

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked{
                from: ctx.accounts.tenant_ata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.landlord_ata.to_account_info(),
                authority: ctx.accounts.tenant.to_account_info(),
            },
        ),
        lease.rent_amount,
        ctx.accounts.mint.decimals,
    )?;

    let on_time = now <= due + lease.grace_secs;

    let profile = &mut ctx.accounts.tenant_profile;
    profile.rent_paid_total += lease.rent_amount;
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