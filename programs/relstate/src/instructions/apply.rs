use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, instructions::attest::enforce_kyc, state::*};

#[derive(Accounts)]
pub struct Apply<'info> {
    #[account(mut)]
    pub tenant: Signer<'info>,
    pub listing: Account<'info, Listing>,
    #[account(
        init,
        payer = tenant,
        space = 8 + Application::INIT_SPACE,
        seeds = [APPLICATION_SEED, listing.key().as_ref(), tenant.key().as_ref()],
        bump
    )]
    pub application: Account<'info, Application>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: the tenant's attestation PDA, forced by the seeds so no other account can stand in
    /// for it. An unverified wallet has nothing here at all, so it is read by hand in the handler
    /// and a missing account is reported as `KycRequired` rather than as a broken account list.
    #[account(seeds = [ATTESTATION_SEED, tenant.key().as_ref()], bump)]
    pub attestation: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_apply(ctx: Context<Apply>) -> Result<()> {
    require_keys_neq!(
        ctx.accounts.tenant.key(),
        ctx.accounts.listing.landlord,
        ErrorCode::SelfLease
    );

    // The acting wallet is the tenant, so the tenant is who needs to be verified. Inert while
    // `Config::require_kyc` is false, which is the default and what the existing suite runs on.
    enforce_kyc(
        &ctx.accounts.config,
        &ctx.accounts.attestation.to_account_info(),
        &ctx.accounts.tenant.key(),
        Clock::get()?.unix_timestamp,
    )?;

    let application = &mut ctx.accounts.application;
    application.listing = ctx.accounts.listing.key();
    application.landlord = ctx.accounts.listing.landlord;
    application.tenant = ctx.accounts.tenant.key();
    Ok(())
}
