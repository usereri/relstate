// D2: what happens once the tenant has used the last dispute round and the lease is in
// `Status::Mediation`. The contract, including the state machine and the fee rule, is
// docs/contracts/dispute-mediation.md; this file is its implementation.
//
// The design rule is the one `settle_dispute.rs` states and D2 has to keep: **no state may hold
// the deposit forever, and each party must have a way out that does not depend on the other
// acting.** From `Mediation`:
//
//   * phase 1: either side `propose_appraisers` (companies by name, with a fee) and
//     `pick_appraiser`; the same pick from both agrees the company;
//   * phase 2: one party `propose_appraiser_key(wallet)`, the *other* `confirm_appraiser_key(wallet)`
//     with the same wallet, and only then is an appraiser bound;
//   * all of the above only while `now < selection_deadline`, one deadline for both phases;
//   * the bound wallet can `submit_verdict` inside the verdict window, which pays out and closes the
//     lease;
//   * either party can `expire_mediation` when nothing is bound at `selection_deadline`, or when the
//     bound wallet stays silent past `verdict_deadline`: the lease returns to `Active` with the
//     claim clock resumed and the tenant takes the whole deposit through `claim_deposit`;
//   * both together can `settle_dispute` at any time (`settle_dispute.rs`).
//
// There is no registry, no default appraiser and no admin instruction. Binding needs both parties,
// so a mediation that one of them declines to join expires to the status quo (full refund to the
// tenant); that is stated, not hidden, in §10 of the contract doc.
//
// The appraiser is an oracle and the program says so out loud. What it *can* enforce is who may
// speak and when, and that is what the checks below are.
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
}

/// One proposed company, as the client sends it. Normalised and hashed by `Candidate::new`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CandidateInput {
    pub name: String,
    pub fee: u64,
}

/// Rejects a call that is not for an open selection: wrong status, an appraiser already bound, or
/// the deadline passed. The deadline check is the exact complement of `expire_mediation`'s
/// unbound branch, so a binding can never land once expiry is available (docs §2).
fn require_selection_open(lease: &Lease, dispute: &Dispute, now: i64) -> Result<()> {
    require!(lease.status == Status::Mediation, ErrorCode::WrongStatus);
    require!(!dispute.is_bound(), ErrorCode::AppraiserAlreadyBound);
    require!(dispute.selection_open(now), ErrorCode::SelectionWindowClosed);
    Ok(())
}

/// One side nominates one to three appraisal companies by name, each with a fee. Once per side.
///
/// Once per side, because a side that could re-propose would churn the union every time the other
/// picked, and the convergence rule would never settle. It costs nothing in liveness: a pick reads
/// the union, so either side can pick one of the other's exactly as spelled.
///
/// Distinct **within** a side by canonical name (`DuplicateCandidate`); across sides they need not
/// be: an overlap is agreement arriving early, and the lower fee then wins.
pub fn handle_propose_appraisers(
    ctx: Context<ProposeAppraisers>,
    candidates: Vec<CandidateInput>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let lease = &ctx.accounts.lease;
    let dispute = &mut ctx.accounts.dispute;
    require_selection_open(lease, dispute, now)?;
    let is_landlord = mediation_party(lease, &ctx.accounts.party.key())?;
    require!(!dispute.name_agreed(), ErrorCode::NameAlreadyAgreed);
    require!(
        (1..=MAX_CANDIDATES).contains(&candidates.len()),
        ErrorCode::NoCandidates
    );

    let cap = appraiser_fee_cap(lease.deposit_amount);
    let mut built = [Candidate::EMPTY; MAX_CANDIDATES];
    for (slot, input) in candidates.iter().enumerate() {
        require!(input.fee <= cap, ErrorCode::FeeAboveCap);
        let candidate = Candidate::new(&input.name, input.fee)?;
        require!(
            !built[..slot].iter().any(|c| c.name_hash == candidate.name_hash),
            ErrorCode::DuplicateCandidate
        );
        built[slot] = candidate;
    }

    let count = candidates.len() as u8;
    if is_landlord {
        require!(
            dispute.landlord_count == 0,
            ErrorCode::CandidatesAlreadyProposed
        );
        dispute.landlord_candidates = built;
        dispute.landlord_count = count;
    } else {
        require!(
            dispute.tenant_count == 0,
            ErrorCode::CandidatesAlreadyProposed
        );
        dispute.tenant_candidates = built;
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
}

/// One side names the company it wants. When both sides name the same one, the company is agreed
/// and so is the fee: the lowest anyone proposed for it.
///
/// A side may change its pick as long as the company is not agreed: one pick per side, ever, would
/// let a side that picked badly deadlock the selection out of pride. A side that proposed nothing
/// may still pick from the other side's list.
pub fn handle_pick_appraiser(ctx: Context<PickAppraiser>, name: String) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let lease = &ctx.accounts.lease;
    let dispute = &mut ctx.accounts.dispute;
    require_selection_open(lease, dispute, now)?;
    let is_landlord = mediation_party(lease, &ctx.accounts.party.key())?;
    require!(!dispute.name_agreed(), ErrorCode::NameAlreadyAgreed);

    // The union of the two lists, so picking the other side's candidate is allowed, and so a
    // company nobody proposed can never be agreed.
    let hash = name_hash(&display_name(&name)?);
    require!(dispute.was_proposed(&hash), ErrorCode::CandidateNotProposed);

    if is_landlord {
        dispute.landlord_pick = hash;
    } else {
        dispute.tenant_pick = hash;
    }
    emit!(AppraiserPicked {
        lease: lease.key(),
        party: ctx.accounts.party.key(),
        name_hash: hash,
    });

    if dispute.picks_agree() {
        // `was_proposed` above makes `lowest_fee` Some; the fallback is unreachable but harmless.
        let fee = dispute.lowest_fee(&hash).unwrap_or(0);
        dispute.agreed_name_hash = hash;
        dispute.agreed_fee = fee;
        emit!(AppraiserNameAgreed {
            lease: lease.key(),
            name_hash: hash,
            fee,
        });
    }
    Ok(())
}

/// Both phase 2 instructions take the same accounts: the lease and its dispute, and a party.
#[derive(Accounts)]
pub struct AppraiserKey<'info> {
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
}

/// Phase 2, first half: a party proposes the wallet that will sign for the agreed company.
///
/// Either party may propose a different wallet until it is confirmed: that is how they switch.
/// `MAX_KEY_PROPOSALS` bounds the ping-pong, so the *last* proposal is final and the other party can
/// always confirm it or let the mediation expire. Nothing here moves a deadline.
pub fn handle_propose_appraiser_key(ctx: Context<AppraiserKey>, wallet: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let lease = &ctx.accounts.lease;
    let dispute = &mut ctx.accounts.dispute;
    require_selection_open(lease, dispute, now)?;
    mediation_party(lease, &ctx.accounts.party.key())?;
    require!(dispute.name_agreed(), ErrorCode::NameNotAgreed);
    require_keys_neq!(wallet, Pubkey::default(), ErrorCode::InvalidAppraiserKey);
    require_not_a_party(lease, &wallet)?;
    require!(
        dispute.key_proposals < MAX_KEY_PROPOSALS,
        ErrorCode::KeyProposalsExhausted
    );

    dispute.proposed_key = wallet;
    dispute.key_proposer = ctx.accounts.party.key();
    dispute.key_proposals += 1;
    emit!(AppraiserKeyProposed {
        lease: lease.key(),
        party: ctx.accounts.party.key(),
        wallet,
        proposals: dispute.key_proposals,
    });
    Ok(())
}

/// Phase 2, second half: the party that did **not** propose confirms the same wallet, and the
/// appraiser is bound.
///
/// Takes the wallet as an argument rather than confirming "whatever is proposed", so a proposer
/// who swaps the key in the slot the other party is confirming cannot bind a wallet the confirmer
/// never looked at: that confirmation fails with `KeyMismatch`.
///
/// `now < selection_deadline` is the same guard as every selection instruction, the exact
/// complement of the unbound `expire_mediation`: no confirmation lands once expiry is available, so
/// a lapsed mediation cannot be re-armed (the S3 F2 failure of revision 1).
pub fn handle_confirm_appraiser_key(ctx: Context<AppraiserKey>, wallet: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let lease = &ctx.accounts.lease;
    let dispute = &mut ctx.accounts.dispute;
    require_selection_open(lease, dispute, now)?;
    mediation_party(lease, &ctx.accounts.party.key())?;
    require!(
        dispute.proposed_key != Pubkey::default(),
        ErrorCode::NoKeyProposed
    );
    require_keys_neq!(
        ctx.accounts.party.key(),
        dispute.key_proposer,
        ErrorCode::CannotConfirmOwnProposal
    );
    require_keys_eq!(wallet, dispute.proposed_key, ErrorCode::KeyMismatch);
    // Checked again on the step that binds, so the guarantee does not rest on the proposal.
    require_not_a_party(lease, &wallet)?;

    dispute.bind(wallet, now);
    emit!(AppraiserBound {
        lease: lease.key(),
        appraiser: wallet,
        name_hash: dispute.agreed_name_hash,
        fee: dispute.agreed_fee,
        verdict_deadline: dispute.verdict_deadline,
    });
    Ok(())
}

/// The appraiser signs, and the lease closes on their number.
///
/// `dispute.appraiser == signer` is what proves they are the wallet both parties bound. The
/// `Dispute` PDA is seeded by the lease, so a verdict cannot be moved to another lease, and the
/// vault is still signed by the lease PDA alone — the appraiser never gains authority over it.
#[derive(Accounts)]
pub struct SubmitVerdict<'info> {
    pub appraiser: Signer<'info>,
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
    /// anywhere else. Must already exist: the client puts an idempotent create-associated-token-
    /// account instruction, paid by the sponsor, before `submit_verdict` in the same transaction
    /// (docs §4). A missing one fails here, loudly, and nothing moves.
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
        ctx.accounts.dispute.agreed_fee,
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

/// The mediation is over without a verdict, so the lease returns to `Active` with the claim clock
/// resumed and the tenant takes the whole deposit through `claim_deposit`.
///
/// Allowed when **nothing is bound** and `selection_deadline` has passed, or when an appraiser is
/// bound and `verdict_deadline` has passed. Each is the exact complement of the guard that closes
/// the matching action (selection, resp. `submit_verdict`), so at every instant exactly one of the
/// two is open and a binding can never re-arm a lapsed mediation (docs §2).
///
/// This is the exit that makes `Mediation` safe to enter. It needs no appraiser, no agreement and
/// no admin — only the clock and one of the two parties — so the deposit cannot be locked by
/// anyone's silence, the oracle's or either party's. The price is the trade-off D1 already records
/// and accepts: with nobody willing to decide, the program decides for the tenant.
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
    let dispute = &ctx.accounts.dispute;
    if dispute.is_bound() {
        require!(now >= dispute.verdict_deadline, ErrorCode::VerdictWindowOpen);
    } else {
        require!(now >= dispute.selection_deadline, ErrorCode::SelectionWindowOpen);
    }

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

/// An appraiser's wallet must not be a party to the lease they are deciding.
///
/// A name cannot be checked against the parties, so this is checked on the wallet. Conservation
/// would hold without it — the vault total is fixed — but a party who could sign the verdict would
/// choose their own deduction, which is exactly the unilateral deduction this subsystem exists to
/// remove. Checked at the key proposal, the confirmation and the verdict, so such a wallet can
/// never be bound in the first place.
fn require_not_a_party(lease: &Lease, appraiser: &Pubkey) -> Result<()> {
    require_keys_neq!(*appraiser, lease.landlord, ErrorCode::NotMediationParty);
    require_keys_neq!(*appraiser, lease.tenant, ErrorCode::NotMediationParty);
    Ok(())
}
