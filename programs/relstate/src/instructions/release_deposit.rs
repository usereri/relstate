use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct ReleaseDesposit<'info> {
    pub landlord: Signer<'info>,
    #[account(
        mut,
        has_one = landlord,
        has_one = mint,
        seeds = [LEASE_SEED, landlord.key().as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump
    )]
    pub lease: Account<'info, Lease>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut, 
        seeds = [VAULT_SEED, lease.key().as_ref()],
        bump
    )]
    pub valut: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = lease.tenant
    )]
    pub tenant_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = landlord
    )]
    pub landlord_ata: Account<'info, TokenAccount>,
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

pub fn handle_release_deposit(ctx: Context<ReleaseDesposit>, deduction: u64) -> Result<()> {
    let lease = &ctx.accounts.lease;
    require!(
        lease.status == Status::Active,
    ErrorCode::WrongStatus
);
    require!(
        lease.paid_count == lease.term_periods, 
        ErrorCode::TermIncomplete
    );
    require!(
        deduction <= lease.deposit_amount, 
        ErrorCode::DeductionTooLarge
    );

    let lease_id - lease.lease_id.to_le_bytes();
    let seeds: &[&[u8]] = &[
        LEASE_SEED,
        ctx.accounts.landlord.key.as_ref(),
        &lease_id,
        &[lease.bump],
    ];
    let to_tenant = lease.deposit_amount - deduction;
    let decimals = ctx.account.mint.decimals;

    for (to, amount) in [
        (ctx.accounts.tenant_ata.to_account_info(), to_tenant),
        (ctx.accounts.landlord_ata.to_account_info(), deduction),
    ] {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                
                TransferChecked {
                    from: ctx.accounts.valut.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to,
                    authority: ctx.accounts.lease.to_account_info(),
                },
            &[seeds],
        ),
        amount,
        decimals
        )?;
    }

    let tenant = &mut ctx.accounts.tenant_profile;
    tenant.leases_completed += 1;
    let landlord = &mut ctx.accounts.landlord_profile;
    landlord.leases_completed += 1;
    if deduciton == 0 {
        tenant.deposits_returned_full += 1;
        landlord.deposits_returned_full += 1;
    } else {
        tenant.deposits_withheld += 1;
        landlord.deposits_withheld += 1;
    }

    let lease = &mut ctx.account.lease;
    lease.status = Status::Closed;
    emit!(LeaseClosed {
        lease: lease.key(),
        deduction,
    });
    Ok(())
}