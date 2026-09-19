use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct FundDeposit<'info> {
    #[account(mut)]
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
        seeds = [VAULT_SEED, lease.key().as_ref()], 
        bump
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = tenant
    )]
    pub tenant_ata: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = tenant,
        space = 8 + Profile::INIT_SPACE,
        seeds = [PROFILE_SEED, tenant.key().as_ref()],
        bump
    )]
    pub tenant_profile: Account<'info, Profile>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_fund_deposit(ctx: Context<FundDeposit>) -> Result<()> {
    require!(
        ctx.accounts.lease.status == Status::Proposed,
        ErrorCode::WrongStatus
    );

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.tenant_ata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.tenant.to_account_info(),
            },
        ),
        ctx.accounts.lease.deposit_amount,
        ctx.accounts.mint.decimals,
    )?;

    let lease = &mut ctx.accounts.lease;
    lease.status = Status::Active;
    lease.start_ts = Clock::get()?.unix_timestamp;

    ctx.accounts.tenant_profile.wallet = ctx.accounts.tenant.key();
    Ok(())
}