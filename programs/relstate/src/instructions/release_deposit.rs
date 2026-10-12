use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::payout::close_with_deduction;

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
        token::authority = lease.tenant
    )]
    pub tenant_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = landlord
    )]
    pub landlord_ata: Box<InterfaceAccount<'info, TokenAccount>>,
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
    pub token_program: Interface<'info, TokenInterface>,
}

/// Ends a fully paid lease. `deduction == 0` returns the deposit on the spot; anything more is a
/// *proposal* that the tenant has to answer, and only while dispute rounds are left.
///
/// The asymmetry is the whole point: before this, the landlord alone decided what to keep and the
/// tenant's only protection was the landlord doing nothing (`claim_deposit`). Now a deduction
/// moves no money at all — the lease enters `Disputed` and the money stays in the vault until the
/// tenant accepts, the tenant's window runs out, or both sides sign a number. See
/// `settle_dispute.rs` and the transition table in `docs/contracts/program-interface.md`.
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
    let now = Clock::get()?.unix_timestamp;
    require!(now >= lease.end_ts(), ErrorCode::LeaseNotEnded);
    require!(
        deduction <= lease.deposit_amount,
        ErrorCode::DeductionTooLarge
    );

    // Nobody disputes getting everything back, so a full return still finalizes immediately —
    // which also keeps it the landlord's way out of a lease whose deduction the tenant rejected.
    if deduction == 0 {
        return close_with_deduction(
            &ctx.accounts.token_program,
            &mut ctx.accounts.lease,
            &ctx.accounts.mint,
            &ctx.accounts.vault,
            &ctx.accounts.tenant_ata,
            &ctx.accounts.landlord_ata,
            &mut ctx.accounts.tenant_profile,
            &mut ctx.accounts.landlord_profile,
            0,
        );
    }

    // `MAX_DISPUTE_ROUNDS` proposals per lease, no more. A landlord who could re-open one forever
    // would simply do it again whenever the resumed claim clock came due, and the deposit would
    // never be reachable. Two strikes and the number stops being either party's to pick: the
    // tenant's last rejection escalates to `Mediation` and an appraiser decides it.
    require!(
        lease.may_propose_deduction(),
        ErrorCode::DisputeRoundsExhausted
    );

    let lease = &mut ctx.accounts.lease;
    lease.status = Status::Disputed;
    lease.proposed_deduction = deduction;
    lease.disputed_at = now;
    emit!(DepositDisputed {
        lease: lease.key(),
        proposed_deduction: deduction,
        answer_by: lease.dispute_deadline(),
    });
    Ok(())
}