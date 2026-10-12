// D2: what happens once the tenant has used the last dispute round and the lease is in
// `Status::Mediation`. The contract, including the state machine and the fee rule, is
// docs/contracts/dispute-mediation.md; this file is its implementation.
//
// The design rule is the one `settle_dispute.rs` states and D2 has to keep: **no state may hold
// the deposit forever, and each party must have a way out that does not depend on the other
// acting.** From `Mediation`:
//
//   * either side can `propose_appraisers` and `pick_appraiser`, and the same pick from both binds
//     an appraiser. Picking from the *other* side's list is how the two converge, which is why a
//     pick is checked against the union of the lists rather than against the signer's own;
//   * once `selection_deadline` has passed, **anyone** can `bind_default_appraiser` — a deadlock
//     is resolved by a third party rather than by waiting;
//   * the bound appraiser can `submit_verdict` inside the verdict window, which pays out and
//     closes the lease;
//   * either party can `expire_mediation` once the verdict window has passed: the lease returns to
//     `Active` with the claim clock resumed, and the tenant takes the whole deposit through
//     `claim_deposit`. That is the default when the oracle stays silent, and it is the same
//     trade-off D1 already documents;
//   * both together can `settle_dispute` at any time (`settle_dispute.rs`), which is the exit that
//     does not wait on the appraiser at all and the one that keeps an appraisal from costing more
//     than the sum in dispute.
//
// Proposing and picking stay open *past* `selection_deadline` as long as nothing is bound. Past it
// the two sides racing `bind_default_appraiser` is strictly more live than barring them: whichever
// transaction lands first binds, and the other fails with `AppraiserAlreadyBound`.
//
// The appraiser is an oracle and the program says so out loud (§10 of the contract doc). What the
// program *can* enforce is who may speak and when, and that is what the checks below are.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::payout::close_with_fee;
use crate::{constants::*, error::ErrorCode, state::*};

/// The landlord or the tenant, and nothing that moves money. `party` is checked against the lease
/// in the handler rather than with `has_one`, because either of the two is allowed and Anchor has
/// no constraint for "one of these".
#[derive(Accounts)]
pub struct ProposeAppraisers<'info> {
    pub party: Signer<'info>,
    #[account(
        seeds = [LEASE_SEED, lease.landlord.as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump
    )]
    pub lease: Account<'info, Lease>,
    #[account(
        mut,
        has_one = lease,
        seeds = [DISPUTE_SEED, lease.key().as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Box<Account<'info, Dispute>>,
    /// The candidates, as registry accounts rather than as a `Vec<Pubkey>` argument. Each is
    /// pinned to its own seeds, so the account cannot be anything but the registry's entry for
    /// `appraiser_x.wallet`, and `active` is checked here rather than in the handler.
    ///
    /// This is the whole anti-sockpuppet mechanism: Anchor's checks are the lookup.
    #[account(
        seeds = [APPRAISER_SEED, appraiser_one.wallet.as_ref()],
        bump = appraiser_one.bump,
        constraint = appraiser_one.active @ ErrorCode::AppraiserInactive
    )]
    pub appraiser_one: Box<Account<'info, Appraiser>>,
    #[account(
        seeds = [APPRAISER_SEED, appraiser_two.wallet.as_ref()],
        bump = appraiser_two.bump,
        constraint = appraiser_two.active @ ErrorCode::AppraiserInactive
    )]
    pub appraiser_two: Option<Box<Account<'info, Appraiser>>>,
    #[account(
        seeds = [APPRAISER_SEED, appraiser_three.wallet.as_ref()],
        bump = appraiser_three.bump,
        constraint = appraiser_three.active @ ErrorCode::AppraiserInactive
    )]
    pub appraiser_three: Option<Box<Account<'info, Appraiser>>>,
}

/// One side nominates one to three registered, active appraisers. Once per side.
///
/// Once per side, because a side that could re-propose would churn the union every time the other
/// picked, and the convergence rule ("same pick from both") would never settle. It costs nothing in
/// liveness: `pick_appraiser` reads the union, so either side can always pick one of the other's,
/// and `bind_default_appraiser` covers the case where nobody nominates anybody.
///
/// Candidates must be distinct **within** a side (`DuplicateCandidate`). Across sides they need
/// not be: an overlap is agreement arriving early.
pub fn handle_propose_appraisers(ctx: Context<ProposeAppraisers>) -> Result<()> {
    let lease = &ctx.accounts.lease;
    require!(lease.status == Status::Mediation, ErrorCode::WrongStatus);
    let is_landlord = mediation_party(lease, &ctx.accounts.party.key())?;

    let dispute = &mut ctx.accounts.dispute;
    // Nothing to nominate for once an appraiser is bound, and silently accepting it would leave a
    // record implying the choice was still open.
    require!(!dispute.is_bound(), ErrorCode::AppraiserAlreadyBound);

    let mut candidates = [Pubkey::default(); MAX_CANDIDATES];
    let mut count = 0usize;
    for entry in [
        Some(&ctx.accounts.appraiser_one),
        ctx.accounts.appraiser_two.as_ref(),
        ctx.accounts.appraiser_three.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        require!(
            !candidates[..count].contains(&entry.wallet),
            ErrorCode::DuplicateCandidate
        );
        require_not_a_party(lease, &entry.wallet)?;
        candidates[count] = entry.wallet;
        count += 1;
    }

    let count = count as u8;
    if is_landlord {
        require!(
            dispute.landlord_count == 0,
            ErrorCode::CandidatesAlreadyProposed
        );
        dispute.landlord_candidates = candidates;
        dispute.landlord_count = count;
    } else {
        require!(
            dispute.tenant_count == 0,
            ErrorCode::CandidatesAlreadyProposed
        );
        dispute.tenant_candidates = candidates;
        dispute.tenant_count = count;
    }

    emit!(AppraisersProposed {
        lease: lease.key(),
        party: ctx.accounts.party.key(),
        count,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct PickAppraiser<'info> {
    pub party: Signer<'info>,
    #[account(
        seeds = [LEASE_SEED, lease.landlord.as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump
    )]
    pub lease: Account<'info, Lease>,
    #[account(
        mut,
        has_one = lease,
        seeds = [DISPUTE_SEED, lease.key().as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Box<Account<'info, Dispute>>,
    /// The pick, as a registry account for the same reason the candidates are: the key is proven
    /// registered and active here, not looked up in the handler. Re-checking `active` at pick time
    /// means an appraiser suspended since the nomination fails now instead of at the verdict.
    #[account(
        seeds = [APPRAISER_SEED, appraiser.wallet.as_ref()],
        bump = appraiser.bump,
        constraint = appraiser.active @ ErrorCode::AppraiserInactive
    )]
    pub appraiser: Box<Account<'info, Appraiser>>,
}

/// One side names the appraiser it wants. When both sides name the same one, that appraiser is
/// bound and the verdict window starts.
///
/// A side may change its pick as long as nothing is bound. The alternative — one pick per side,
/// ever — would let a side that picked badly deadlock the mediation out of pride, and the whole
/// point of the selection phase is that it converges.
///
/// A side that proposed nothing may still pick from the other side's list; that is the cheapest
/// path to agreement and there is no reason to close it.
pub fn handle_pick_appraiser(ctx: Context<PickAppraiser>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let lease = &ctx.accounts.lease;
    require!(lease.status == Status::Mediation, ErrorCode::WrongStatus);
    let is_landlord = mediation_party(lease, &ctx.accounts.party.key())?;
    let pick = ctx.accounts.appraiser.wallet;
    require_not_a_party(lease, &pick)?;

    let dispute = &mut ctx.accounts.dispute;
    require!(!dispute.is_bound(), ErrorCode::AppraiserAlreadyBound);
    // Binding re-bases `verdict_deadline` to now + VERDICT_WINDOW_SECS, so a binding after the
    // provisional deadline would push out an expiry the tenant is already entitled to (S3 F2).
    // Exactly the complement of `expire_mediation`'s `now >= verdict_deadline`: no gap, no overlap.
    require!(
        now < dispute.verdict_deadline,
        ErrorCode::BindingWindowClosed
    );
    // The union of the two lists, so picking the other side's candidate is allowed — and so an
    // appraiser nobody nominated can never be bound by agreement.
    require!(
        dispute.was_proposed(&pick),
        ErrorCode::CandidateNotProposed
    );

    if is_landlord {
        dispute.landlord_pick = pick;
    } else {
        dispute.tenant_pick = pick;
    }
    emit!(AppraiserPicked {
        lease: lease.key(),
        party: ctx.accounts.party.key(),
        pick,
    });

    if dispute.picks_agree() {
        dispute.bind(pick, now);
        emit!(AppraiserBound {
            lease: lease.key(),
            appraiser: pick,
            by_default: false,
            verdict_deadline: dispute.verdict_deadline,
        });
    }
    Ok(())
}

/// Callable by **anyone**, on purpose. It needs no authority: the only thing it can do is bind an
/// appraiser the admin designated, after the two sides had their window and failed to agree. Making
/// it the parties' privilege would mean a deadlock could only be broken by one of the two people
/// who are deadlocked.
#[derive(Accounts)]
pub struct BindDefaultAppraiser<'info> {
    pub caller: Signer<'info>,
    #[account(
        seeds = [LEASE_SEED, lease.landlord.as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump
    )]
    pub lease: Account<'info, Lease>,
    #[account(
        mut,
        has_one = lease,
        seeds = [DISPUTE_SEED, lease.key().as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Box<Account<'info, Dispute>>,
    /// Must be the registry's default and still active, PDA-checked, so an open instruction cannot
    /// bind an appraiser of the caller's choosing.
    #[account(
        seeds = [APPRAISER_SEED, appraiser.wallet.as_ref()],
        bump = appraiser.bump,
        constraint = appraiser.active @ ErrorCode::AppraiserInactive,
        constraint = appraiser.is_default @ ErrorCode::AppraiserNotDefault
    )]
    pub appraiser: Box<Account<'info, Appraiser>>,
}

/// The deadlock fallback: after `selection_deadline`, the registry's default appraiser is bound and
/// gets a full verdict window from this moment.
///
/// It does not end the selection phase early — before the deadline it refuses — and it cannot
/// override an agreement, because a bound dispute refuses it.
pub fn handle_bind_default_appraiser(ctx: Context<BindDefaultAppraiser>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let lease = &ctx.accounts.lease;
    require!(lease.status == Status::Mediation, ErrorCode::WrongStatus);

    let appraiser = ctx.accounts.appraiser.wallet;
    require_not_a_party(lease, &appraiser)?;
    let dispute = &mut ctx.accounts.dispute;
    require!(!dispute.is_bound(), ErrorCode::AppraiserAlreadyBound);
    require!(
        now >= dispute.selection_deadline,
        ErrorCode::SelectionWindowOpen
    );
    // Same upper bound as `pick_appraiser`; see there.
    require!(
        now < dispute.verdict_deadline,
        ErrorCode::BindingWindowClosed
    );

    dispute.bind(appraiser, now);
    emit!(AppraiserBound {
        lease: lease.key(),
        appraiser,
        by_default: true,
        verdict_deadline: dispute.verdict_deadline,
    });
    Ok(())
}

/// The appraiser signs, and the lease closes on their number.
///
/// `appraiser_record` is the registry entry for the *signer*, so the signer is proven registered
/// and active; `dispute.appraiser == signer` is what proves they are the one this dispute bound.
/// The `Dispute` PDA is seeded by the lease, so a verdict cannot be moved to another lease, and
/// the vault is still signed by the lease PDA alone — the appraiser never gains authority over it.
#[derive(Accounts)]
pub struct SubmitVerdict<'info> {
    pub appraiser: Signer<'info>,
    #[account(
        seeds = [APPRAISER_SEED, appraiser.key().as_ref()],
        bump = appraiser_record.bump,
        constraint = appraiser_record.active @ ErrorCode::AppraiserInactive
    )]
    pub appraiser_record: Box<Account<'info, Appraiser>>,
    #[account(
        mut,
        has_one = mint,
        seeds = [LEASE_SEED, lease.landlord.as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump
    )]
    pub lease: Box<Account<'info, Lease>>,
    /// Closed here, with the rent going back to the tenant who paid for it in
    /// `escalate_to_mediation`. Closing it is also what makes "one verdict per dispute" structural
    /// rather than a flag: there is no account left to submit against.
    #[account(
        mut,
        close = tenant,
        has_one = lease,
        seeds = [DISPUTE_SEED, lease.key().as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Box<Account<'info, Dispute>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, lease.key().as_ref()],
        bump
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The rent destination for the closed `Dispute`, pinned to the lease's tenant so the
    /// appraiser cannot redirect it. Not a signer: the tenant does not have to be present for
    /// their own refund.
    #[account(mut, address = lease.tenant)]
    pub tenant: SystemAccount<'info>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = lease.tenant
    )]
    pub tenant_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = lease.landlord
    )]
    pub landlord_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Where the fee goes. Pinned to the signing appraiser, so a verdict cannot pay the fee
    /// anywhere else.
    #[account(
        mut,
        token::mint = mint,
        token::authority = appraiser
    )]
    pub appraiser_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, lease.tenant.as_ref()],
        bump
    )]
    pub tenant_profile: Box<Account<'info, Profile>>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, lease.landlord.as_ref()],
        bump
    )]
    pub landlord_profile: Box<Account<'info, Profile>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// The verdict: `deduction` of the deposit to the landlord, the rest to the tenant, the appraiser's
/// capped fee out of the losing side's share (`verdict_split`, §6 of the contract doc).
///
/// Only inside the verdict window. A late verdict is refused rather than accepted, because past the
/// deadline the tenant is entitled to `expire_mediation` and a full refund — a verdict that could
/// still land afterwards would make that entitlement a lie. The boundary is a race between the two
/// instructions and either outcome is legitimate; whichever transaction lands first wins.
///
/// One verdict per dispute, enforced structurally: the lease ends `Closed` and the `Dispute`
/// account is closed, so there is nothing left to submit a second verdict against.
pub fn handle_submit_verdict(ctx: Context<SubmitVerdict>, deduction: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let lease = &ctx.accounts.lease;
    require!(lease.status == Status::Mediation, ErrorCode::WrongStatus);
    require!(
        deduction <= lease.deposit_amount,
        ErrorCode::DeductionTooLarge
    );

    // Last line of defence, so the money path does not rely on the three selection instructions
    // having been the only way this appraiser got bound.
    require_not_a_party(lease, &ctx.accounts.appraiser.key())?;

    let dispute = &ctx.accounts.dispute;
    require!(dispute.is_bound(), ErrorCode::AppraiserNotBound);
    require_keys_eq!(
        dispute.appraiser,
        ctx.accounts.appraiser.key(),
        ErrorCode::NotBoundAppraiser
    );
    require!(
        now < dispute.verdict_deadline,
        ErrorCode::VerdictWindowClosed
    );

    let split = close_with_fee(
        &ctx.accounts.token_program,
        &mut ctx.accounts.lease,
        &ctx.accounts.mint,
        &ctx.accounts.vault,
        &ctx.accounts.tenant_ata,
        &ctx.accounts.landlord_ata,
        &mut ctx.accounts.tenant_profile,
        &mut ctx.accounts.landlord_profile,
        deduction,
        Some(&ctx.accounts.appraiser_ata),
        ctx.accounts.appraiser_record.fee,
    )?;

    emit!(MediationVerdict {
        lease: ctx.accounts.lease.key(),
        appraiser: ctx.accounts.appraiser.key(),
        deduction,
        fee_paid: split.to_appraiser,
    });
    Ok(())
}

/// Either party, and it moves no money: the smallest surface for the instruction that unwinds a
/// mediation the oracle never answered.
#[derive(Accounts)]
pub struct ExpireMediation<'info> {
    pub party: Signer<'info>,
    #[account(
        mut,
        seeds = [LEASE_SEED, lease.landlord.as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump
    )]
    pub lease: Account<'info, Lease>,
    #[account(
        mut,
        close = tenant,
        has_one = lease,
        seeds = [DISPUTE_SEED, lease.key().as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Box<Account<'info, Dispute>>,
    /// The rent destination, pinned to the lease's tenant: whichever party calls this, the refund
    /// goes to whoever paid for the account.
    #[account(mut, address = lease.tenant)]
    pub tenant: SystemAccount<'info>,
}

/// The verdict window passed with no verdict, so the mediation is over: the lease returns to
/// `Active` with the claim clock resumed and the tenant takes the whole deposit through
/// `claim_deposit`.
///
/// This is the exit that makes `Mediation` safe to enter. It needs no appraiser, no agreement and
/// no admin — only the clock and one of the two parties — so the deposit cannot be locked by
/// anyone's silence, including the oracle's. The price is the trade-off D1 already records and
/// accepts: with nobody willing to decide, the program decides for the tenant.
///
/// `dispute_rounds` stays at the cap, so the landlord cannot propose a fresh deduction once the
/// lease is `Active` again and start the whole cycle over; `release_deposit(0)` still works.
pub fn handle_expire_mediation(ctx: Context<ExpireMediation>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        ctx.accounts.lease.status == Status::Mediation,
        ErrorCode::WrongStatus
    );
    mediation_party(&ctx.accounts.lease, &ctx.accounts.party.key())?;
    require!(
        now >= ctx.accounts.dispute.verdict_deadline,
        ErrorCode::VerdictWindowOpen
    );

    let lease = &mut ctx.accounts.lease;
    // ends the Mediation stretch: the seconds since `escalate_to_mediation` re-stamped
    // `disputed_at` are added to the claim deadline, so the tenant waits exactly as long as they
    // would have if the landlord had never proposed anything.
    lease.resume_claim_clock(now);
    lease.status = Status::Active;
    lease.proposed_deduction = 0;

    emit!(MediationExpired {
        lease: lease.key(),
        claim_deadline: lease.claim_deadline(),
    });
    Ok(())
}

/// `true` for the landlord, `false` for the tenant, an error for anyone else.
///
/// Anchor's `has_one` cannot express "either of these two", so this is the one authority check in
/// the file that lives in handler code rather than in a constraint. It is called first in every
/// handler that allows either party.
fn mediation_party(lease: &Lease, signer: &Pubkey) -> Result<bool> {
    if *signer == lease.landlord {
        Ok(true)
    } else if *signer == lease.tenant {
        Ok(false)
    } else {
        err!(ErrorCode::NotMediationParty)
    }
}

/// An appraiser must not be a party to the lease they are deciding.
///
/// Nothing above this would have caught it: the registry says who *may* arbitrate and the picks say
/// who *did*, and a landlord whom the admin had registered and who then nominated and picked
/// themselves would pass both. Conservation would still hold — the vault total is fixed, and a
/// three-way split into two accounts one party owns still drains to the deposit — so the money
/// could not be conjured; what they would get is a deduction of their own choosing, which is
/// exactly the unilateral deduction this whole subsystem exists to remove.
///
/// Checked at every entry into a candidate list, a pick and a binding, so such an appraiser can
/// never be bound in the first place and the mediation does not have to limp to its expiry.
fn require_not_a_party(lease: &Lease, appraiser: &Pubkey) -> Result<()> {
    require_keys_neq!(*appraiser, lease.landlord, ErrorCode::NotMediationParty);
    require_keys_neq!(*appraiser, lease.tenant, ErrorCode::NotMediationParty);
    Ok(())
}
