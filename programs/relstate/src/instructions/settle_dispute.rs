// The D1 settlement primitive: what happens after a landlord proposes a deduction the tenant has
// not agreed to (`release_deposit` with `deduction > 0`, which leaves the lease `Disputed`).
//
// The design rule every instruction here obeys: **no state may ever hold the deposit forever, and
// each party must have a way out that does not depend on the other acting.** From `Disputed`:
//
//   * the tenant can `accept_deduction` at any time — it pays exactly what the landlord asked
//     for, so one signature is enough and it needs no deadline;
//   * the tenant can `abandon_dispute` *inside* the window — the proposal is void, the lease goes
//     back to its ended-but-`Active` state with the claim clock resumed, and the deposit comes
//     back in full through `claim_deposit`;
//   * the landlord can `finalize_deduction` *after* the window — silence is taken as agreement;
//   * both together can `settle_dispute(deduction)` at any time, for any number up to the
//     deposit. This is the negotiated middle, and the only path where the amount is free, because
//     it is the only one both parties sign.
//
// So after the window the tenant can still accept and the landlord can still finalize: two
// independent exits, neither needing the counterparty. That is deliberate. If `accept_deduction`
// expired with the window, a landlord who proposed a deduction and then disappeared would strand
// the deposit in the vault with no instruction able to move it.
//
// The trade-off this does *not* solve: a tenant who rejects gets the whole deposit back, so real
// damage the tenant refuses to pay for has no on-chain remedy here. The landlord's remedies are
// `mark_default` for unpaid rent during the term, the permanent record of the rejection, and the
// appraiser flow (D2) on the roadmap.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::payout::close_with_deduction;
use crate::{constants::*, error::ErrorCode, state::*};

/// Both parties sign a final number. The lease PDA is still the only authority over the vault;
/// the two signatures only authorise the split.
#[derive(Accounts)]
pub struct SettleDispute<'info> {
    pub tenant: Signer<'info>,
    pub landlord: Signer<'info>,
    #[account(
        mut,
        has_one = tenant,
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
        token::authority = tenant
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
        seeds = [PROFILE_SEED, tenant.key().as_ref()],
        bump
    )]
    pub tenant_profile: Account<'info, Profile>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, landlord.key().as_ref()],
        bump
    )]
    pub landlord_profile: Account<'info, Profile>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// The negotiated settlement, and the reason the tenant's rejection is not the end of the story:
/// the two can agree on any figure between nothing and the whole deposit — including one neither
/// of them proposed.
///
/// The amount is unconstrained precisely because both signatures are required: a tenant cannot be
/// charged more than they signed for, and a landlord cannot be paid less.
pub fn handle_settle_dispute(ctx: Context<SettleDispute>, deduction: u64) -> Result<()> {
    let lease = &ctx.accounts.lease;
    require!(lease.status == Status::Disputed, ErrorCode::WrongStatus);
    require!(
        deduction <= lease.deposit_amount,
        ErrorCode::DeductionTooLarge
    );

    close_with_deduction(
        &ctx.accounts.token_program,
        &mut ctx.accounts.lease,
        &ctx.accounts.mint,
        &ctx.accounts.vault,
        &ctx.accounts.tenant_ata,
        &ctx.accounts.landlord_ata,
        &mut ctx.accounts.tenant_profile,
        &mut ctx.accounts.landlord_profile,
        deduction,
    )
}

/// Tenant-only. The landlord is not an account here at all: both the landlord's token account and
/// record are pinned to `lease.landlord`, so there is nothing for the tenant to substitute.
#[derive(Accounts)]
pub struct AcceptDeduction<'info> {
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

/// The tenant agrees to the proposal as it stands. One signature is enough because the amount is
/// not the tenant's to pick: it is exactly `lease.proposed_deduction`, which the landlord already
/// signed for in `release_deposit`.
///
/// No deadline, on purpose — see the module comment. A landlord can never be worse off for it.
pub fn handle_accept_deduction(ctx: Context<AcceptDeduction>) -> Result<()> {
    let lease = &ctx.accounts.lease;
    require!(lease.status == Status::Disputed, ErrorCode::WrongStatus);
    let deduction = lease.proposed_deduction;

    close_with_deduction(
        &ctx.accounts.token_program,
        &mut ctx.accounts.lease,
        &ctx.accounts.mint,
        &ctx.accounts.vault,
        &ctx.accounts.tenant_ata,
        &ctx.accounts.landlord_ata,
        &mut ctx.accounts.tenant_profile,
        &mut ctx.accounts.landlord_profile,
        deduction,
    )
}

/// Tenant-only, and it moves no money: no vault, no token accounts, no records. The smallest
/// possible surface for the instruction that unwinds a dispute.
#[derive(Accounts)]
pub struct AbandonDispute<'info> {
    pub tenant: Signer<'info>,
    #[account(
        mut,
        has_one = tenant,
        seeds = [LEASE_SEED, lease.landlord.as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump
    )]
    pub lease: Account<'info, Lease>,
}

/// The tenant rejects the proposed deduction, inside the window.
///
/// The lease returns to the ended-but-`Active` state it came from and the claim clock *resumes*:
/// the seconds spent disputing are added to the deadline, so the tenant is left with exactly the
/// wait they had before the landlord proposed anything. `claim_deposit` then returns the whole
/// deposit, and the landlord's proposal is void.
///
/// Only inside the window, because past it the landlord is entitled to finalize; and only once
/// per lease, which `dispute_rejected` enforces back in `release_deposit`.
pub fn handle_abandon_dispute(ctx: Context<AbandonDispute>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let lease = &mut ctx.accounts.lease;
    require!(lease.status == Status::Disputed, ErrorCode::WrongStatus);
    require!(now < lease.dispute_deadline(), ErrorCode::DisputeWindowClosed);

    let paused = now.saturating_sub(lease.disputed_at).max(0);
    lease.claim_pause_secs = lease.claim_pause_secs.saturating_add(paused);
    lease.status = Status::Active;
    lease.proposed_deduction = 0;
    lease.disputed_at = 0;
    lease.dispute_rejected = true;

    emit!(DepositDisputeRejected {
        lease: lease.key(),
        claim_deadline: lease.claim_deadline(),
    });
    Ok(())
}

/// Landlord-only, and the same account list as `release_deposit`: the tenant does not appear,
/// because their token account and record are pinned to `lease.tenant`.
#[derive(Accounts)]
pub struct FinalizeDeduction<'info> {
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
    pub landlord_profile: Account<'info, Profile>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// The tenant let the whole window pass without accepting or rejecting, so the proposal stands.
///
/// The mirror image of `claim_deposit`: there, a silent landlord loses the deduction; here, a
/// silent tenant loses the argument. Neither side can be made to wait on the other forever.
pub fn handle_finalize_deduction(ctx: Context<FinalizeDeduction>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let lease = &ctx.accounts.lease;
    require!(lease.status == Status::Disputed, ErrorCode::WrongStatus);
    require!(now >= lease.dispute_deadline(), ErrorCode::DisputeWindowOpen);
    let deduction = lease.proposed_deduction;

    close_with_deduction(
        &ctx.accounts.token_program,
        &mut ctx.accounts.lease,
        &ctx.accounts.mint,
        &ctx.accounts.vault,
        &ctx.accounts.tenant_ata,
        &ctx.accounts.landlord_ata,
        &mut ctx.accounts.tenant_profile,
        &mut ctx.accounts.landlord_profile,
        deduction,
    )
}
