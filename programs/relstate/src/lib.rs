pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("5J52oGfo7BjC529vizEaM96QtxVFD4Kbv22Tw8aXa1Ar");

#[program]
pub mod relstate {
    use super::*;

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
}
