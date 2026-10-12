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
//     back in full through `claim_deposit`. On the *last* round the rejection goes through
//     `escalate_to_mediation` instead and the lease enters `Status::Mediation`, where an appraiser
//     decides the number (`mediation.rs`);
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
// The trade-off D1 alone did *not* solve — a tenant who rejects gets the whole deposit back, so
// real damage the tenant refuses to pay for had no on-chain remedy — is what D2 answers: the last
// rejection hands the number to an appraiser instead of to the tenant. `mark_default` (unpaid rent
// during the term) and the permanent public record of the rejection are still the landlord's other
// remedies.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::payout::close_with_deduction;
use crate::{constants::*, error::ErrorCode, state::*};

/// Both parties sign a final number. The lease PDA is still the only authority over the vault;
/// the two signatures only authorise the split.
///
/// `dispute` is present only when the lease is in `Mediation`: in `Disputed` there is no such
/// account to pass. The handler enforces that correspondence both ways, so neither state can be
/// settled with the wrong account list.
#[derive(Accounts)]
pub struct SettleDispute<'info> {
    #[account(mut)]
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
    pub lease: Box<Account<'info, Lease>>,
    /// Required in `Mediation`, where it is closed and its rent returned to the tenant who paid
    /// for it; must be absent in `Disputed`.
    #[account(
        mut,
        has_one = lease,
        seeds = [DISPUTE_SEED, lease.key().as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Option<Box<Account<'info, Dispute>>>,
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
    pub tenant_profile: Box<Account<'info, Profile>>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, landlord.key().as_ref()],
        bump
    )]
    pub landlord_profile: Box<Account<'info, Profile>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// The negotiated settlement, and the reason the tenant's rejection is not the end of the story:
/// the two can agree on any figure between nothing and the whole deposit — including one neither
/// of them proposed.
///
/// The amount is unconstrained precisely because both signatures are required: a tenant cannot be
/// charged more than they signed for, and a landlord cannot be paid less.
///
/// Available in `Mediation` as well as `Disputed` (D2): nothing about having escalated should stop
/// the two from agreeing, and it is the exit that does not wait on the appraiser. No fee is paid —
/// the appraiser has not decided anything, and settling before a verdict is exactly what keeps an
/// appraisal from costing more than the amount in dispute.
pub fn handle_settle_dispute(ctx: Context<SettleDispute>, deduction: u64) -> Result<()> {
    let lease = &ctx.accounts.lease;
    require!(
        matches!(lease.status, Status::Disputed | Status::Mediation),
        ErrorCode::WrongStatus
    );
    require!(
        deduction <= lease.deposit_amount,
        ErrorCode::DeductionTooLarge
    );
    // Both ways round, so a `Mediation` lease cannot be settled while leaving its Dispute account
    // behind (orphaned rent, and a stale record of a dispute that is over), and a `Disputed` lease
    // cannot be handed some other lease's account.
    match (lease.status, ctx.accounts.dispute.is_some()) {
        (Status::Mediation, false) => return err!(ErrorCode::DisputeAccountRequired),
        (Status::Disputed, true) => return err!(ErrorCode::UnexpectedDisputeAccount),
        _ => {}
    }

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
    )?;

    // Closed by hand rather than with `close = tenant`, because Anchor's declarative close does
    // not reach inside an Option. The rent goes to the tenant, who paid for the account in
    // `escalate_to_mediation`.
    if let Some(dispute) = &ctx.accounts.dispute {
        dispute.close(ctx.accounts.tenant.to_account_info())?;
    }
    Ok(())
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

/// The tenant rejects the proposed deduction, inside the window, with dispute rounds still to
/// spare.
///
/// The lease returns to the ended-but-`Active` state it came from and the claim clock *resumes*:
/// the seconds spent disputing are added to the deadline, so the tenant is left with exactly the
/// wait they had before the landlord proposed anything. `claim_deposit` then returns the whole
/// deposit, and the landlord's proposal is void — but the landlord may propose once more, which is
/// the difference from D1, where a rejection ended the argument.
///
/// Only inside the window, because past it the landlord is entitled to finalize; and only while
/// `dispute_rounds + 1 < MAX_DISPUTE_ROUNDS`, because the *last* rejection is
/// `escalate_to_mediation`, not this. The two together cover every round exactly once, so a tenant
/// can neither skip the escalation nor reject forever. With `MAX_DISPUTE_ROUNDS = 1` this
/// instruction is unreachable by construction and the first rejection escalates — cut line 3 of
/// the D2 plan, at the cost of one constant.
pub fn handle_abandon_dispute(ctx: Context<AbandonDispute>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let lease = &mut ctx.accounts.lease;
    require!(lease.status == Status::Disputed, ErrorCode::WrongStatus);
    require!(now < lease.dispute_deadline(), ErrorCode::DisputeWindowClosed);
    require!(
        lease.dispute_rounds.saturating_add(1) < MAX_DISPUTE_ROUNDS,
        ErrorCode::WrongDisputeRound
    );

    lease.resume_claim_clock(now);
    lease.status = Status::Active;
    lease.proposed_deduction = 0;
    lease.dispute_rounds = lease.dispute_rounds.saturating_add(1);

    emit!(DepositDisputeRejected {
        lease: lease.key(),
        claim_deadline: lease.claim_deadline(),
        dispute_rounds: lease.dispute_rounds,
    });
    Ok(())
}

/// Tenant-only, and the round-2 half of `abandon_dispute`: the same rejection, but it opens
/// `Mediation` instead of returning the lease to the parties.
///
/// It is a separate instruction rather than a branch inside `abandon_dispute` so that the `Dispute`
/// account can be a plain Anchor `init`. With `init_if_needed` on one instruction, a round-1
/// rejection would allocate an account that may never be used and whose rent would be lost if the
/// lease then closed normally.
#[derive(Accounts)]
pub struct EscalateToMediation<'info> {
    #[account(mut)]
    pub tenant: Signer<'info>,
    #[account(
        mut,
        has_one = tenant,
        seeds = [LEASE_SEED, lease.landlord.as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump
    )]
    pub lease: Account<'info, Lease>,
    /// Paid for by the tenant and returned to them on whichever exit ends the mediation.
    #[account(
        init,
        payer = tenant,
        space = 8 + Dispute::INIT_SPACE,
        seeds = [DISPUTE_SEED, lease.key().as_ref()],
        bump
    )]
    pub dispute: Box<Account<'info, Dispute>>,
    pub system_program: Program<'info, System>,
}

/// The tenant rejects for the last time: the number is no longer theirs or the landlord's to pick.
///
/// The `Disputed` stretch is added to the claim clock here, and `disputed_at` is re-stamped to now
/// so the same field times the `Mediation` stretch for `expire_mediation`. The selection
/// deadline is set up front, so a mediation that nobody takes part in still expires rather than
/// sitting forever.
pub fn handle_escalate_to_mediation(ctx: Context<EscalateToMediation>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let lease_key = ctx.accounts.lease.key();
    let lease = &mut ctx.accounts.lease;
    require!(lease.status == Status::Disputed, ErrorCode::WrongStatus);
    require!(now < lease.dispute_deadline(), ErrorCode::DisputeWindowClosed);
    // Exactly the complement of `abandon_dispute`: this is the last round and nothing else.
    require!(
        lease.dispute_rounds.saturating_add(1) == MAX_DISPUTE_ROUNDS,
        ErrorCode::WrongDisputeRound
    );

    // ends the Disputed stretch, then starts the Mediation one on the same field
    lease.resume_claim_clock(now);
    lease.disputed_at = now;
    lease.status = Status::Mediation;
    lease.proposed_deduction = 0;
    lease.dispute_rounds = lease.dispute_rounds.saturating_add(1);

    let dispute = &mut ctx.accounts.dispute;
    dispute.open(lease_key, now, ctx.bumps.dispute);

    emit!(MediationOpened {
        lease: lease_key,
        dispute: dispute.key(),
        selection_deadline: dispute.selection_deadline,
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
