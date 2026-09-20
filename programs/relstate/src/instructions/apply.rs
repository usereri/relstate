use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::*};

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
    pub system_program: Program<'info, System>,
}

pub fn handle_apply(ctx: Context<Apply>) -> Result<()> {
    require_keys_neq!(
        ctx.accounts.tenant.key(),
        ctx.accounts.listing.landlord,
        ErrorCode::SelfLease
    );

    let application = &mut ctx.accounts.application;
    application.listing = ctx.accounts.listing.key();
    application.landlord = ctx.accounts.listing.landlord;
    application.tenant = ctx.accounts.tenant.key();
    Ok(())
}
