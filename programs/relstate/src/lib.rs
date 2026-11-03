pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("G4iMjveQKXztnGoxigAeWPrb5evT9yt6qaLkgQEp2dXm");

#[program]
pub mod relstate {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>) -> Result<()> {
        crate::instructions::config::handle_init_config(ctx)
    }

    pub fn set_mint_allowed(ctx: Context<SetMintAllowed>, allowed: bool) -> Result<()> {
        crate::instructions::config::handle_set_mint_allowed(ctx, allowed)
    }

    pub fn set_admin(ctx: Context<UpdateConfig>, new_admin: Pubkey) -> Result<()> {
        crate::instructions::config::handle_set_admin(ctx, new_admin)
    }

    pub fn set_issuer(ctx: Context<SetKycConfig>, issuer: Pubkey) -> Result<()> {
        crate::instructions::config::handle_set_issuer(ctx, issuer)
    }

    pub fn set_require_kyc(ctx: Context<SetKycConfig>, required: bool) -> Result<()> {
        crate::instructions::config::handle_set_require_kyc(ctx, required)
    }

    pub fn attest(
        ctx: Context<Attest>,
        level: u8,
        expires_at: i64,
        subject_hash: [u8; 32],
    ) -> Result<()> {
        crate::instructions::attest::handle_attest(ctx, level, expires_at, subject_hash)
    }

    pub fn revoke(ctx: Context<Revoke>) -> Result<()> {
        crate::instructions::attest::handle_revoke(ctx)
    }

    pub fn create_listing(
        ctx: Context<CreateListing>,
        listing_id: u64,
        rent_amount: u64,
        deposit_amount: u64,
        region: [u8; 2],
        title: String,
        city: String,
        blurb: String,
        photo: String,
    ) -> Result<()> {
        crate::instructions::create_listing::handle_create_listing(
            ctx, listing_id, rent_amount, deposit_amount, region, title, city, blurb, photo,
        )
    }

    pub fn apply(ctx: Context<Apply>) -> Result<()> {
        crate::instructions::apply::handle_apply(ctx)
    }

    pub fn close_application(ctx: Context<CloseApplication>) -> Result<()> {
        crate::instructions::close_application::handle_close_application(ctx)
    }

    pub fn close_listing(ctx: Context<CloseListing>) -> Result<()> {
        crate::instructions::close_listing::handle_close_listing(ctx)
    }

    pub fn propose_lease(
        ctx: Context<ProposeLease>,
        lease_id: u64,
        rent_amount: u64,
        standard_deposit: u64,
        period_secs: i64,
        grace_secs: i64,
        term_periods: u16,
        lease_hash: [u8; 32],
        region: [u8; 2],
    ) -> Result<()> {
        crate::instructions::propose_lease::handle_propose_lease(
            ctx,
            lease_id,
            rent_amount,
            standard_deposit,
            period_secs,
            grace_secs,
            term_periods,
            lease_hash,
            region,
        )
    }

    pub fn claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
        crate::instructions::claim_deposit::handle_claim_deposit(ctx)
    }

    pub fn fund_deposit(ctx: Context<FundDeposit>, lease_hash: [u8; 32]) -> Result<()> {
        crate::instructions::fund_deposit::handle_fund_deposit(ctx, lease_hash)
    }

    pub fn pay_rent(ctx: Context<PayRent>) -> Result<()> {
        crate::instructions::pay_rent::handle_pay_rent(ctx)
    }

    pub fn mark_default(ctx: Context<MarkDefault>) -> Result<()> {
        crate::instructions::mark_default::handle_mark_default(ctx)
    }

    pub fn release_deposit(ctx: Context<ReleaseDeposit>, deduction: u64) -> Result<()> {
        crate::instructions::release_deposit::handle_release_deposit(ctx, deduction)
    }

    /// Both parties sign a final deduction and the lease closes on it (D1).
    pub fn settle_dispute(ctx: Context<SettleDispute>, deduction: u64) -> Result<()> {
        crate::instructions::settle_dispute::handle_settle_dispute(ctx, deduction)
    }

    /// Tenant accepts the landlord's proposed deduction as it stands.
    pub fn accept_deduction(ctx: Context<AcceptDeduction>) -> Result<()> {
        crate::instructions::settle_dispute::handle_accept_deduction(ctx)
    }

    /// Tenant rejects the proposed deduction with rounds still to spare; the deposit returns in
    /// full and the landlord may propose once more.
    pub fn abandon_dispute(ctx: Context<AbandonDispute>) -> Result<()> {
        crate::instructions::settle_dispute::handle_abandon_dispute(ctx)
    }

    /// Tenant rejects for the last time: the lease enters `Mediation` and an appraiser decides (D2).
    pub fn escalate_to_mediation(ctx: Context<EscalateToMediation>) -> Result<()> {
        crate::instructions::settle_dispute::handle_escalate_to_mediation(ctx)
    }

    /// Landlord closes an unanswered dispute once the tenant's window has passed.
    pub fn finalize_deduction(ctx: Context<FinalizeDeduction>) -> Result<()> {
        crate::instructions::settle_dispute::handle_finalize_deduction(ctx)
    }

    // ---- D2 appraiser arbitration (docs/contracts/dispute-mediation.md)

    /// Landlord or tenant, phase 1: nominates one to three appraisal companies by name, each with
    /// a fee. Once per side.
    pub fn propose_appraisers(
        ctx: Context<ProposeAppraisers>,
        candidates: Vec<CandidateInput>,
    ) -> Result<()> {
        crate::instructions::mediation::handle_propose_appraisers(ctx, candidates)
    }

    /// Landlord or tenant, phase 1: names one company from either list. Matching picks agree it.
    pub fn pick_appraiser(ctx: Context<PickAppraiser>, name: String) -> Result<()> {
        crate::instructions::mediation::handle_pick_appraiser(ctx, name)
    }

    /// Landlord or tenant, phase 2: proposes the wallet that signs for the agreed company.
    pub fn propose_appraiser_key(ctx: Context<AppraiserKey>, wallet: Pubkey) -> Result<()> {
        crate::instructions::mediation::handle_propose_appraiser_key(ctx, wallet)
    }

    /// The party that did not propose, phase 2: confirms the same wallet and binds it.
    pub fn confirm_appraiser_key(ctx: Context<AppraiserKey>, wallet: Pubkey) -> Result<()> {
        crate::instructions::mediation::handle_confirm_appraiser_key(ctx, wallet)
    }

    /// The bound appraiser decides the deduction; the deposit is split and the lease closes.
    pub fn submit_verdict(ctx: Context<SubmitVerdict>, deduction: u64) -> Result<()> {
        crate::instructions::mediation::handle_submit_verdict(ctx, deduction)
    }

    /// Landlord or tenant: past the selection deadline with nothing bound, or past the verdict
    /// deadline once bound. The lease returns to `Active` and the claim clock resumes.
    pub fn expire_mediation(ctx: Context<ExpireMediation>) -> Result<()> {
        crate::instructions::mediation::handle_expire_mediation(ctx)
    }
}
