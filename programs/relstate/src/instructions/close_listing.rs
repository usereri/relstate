use anchor_lang::prelude::*;

use crate::{constants::*, state::*};

#[derive(Accounts)]
pub struct CloseListing<'info> {
    #[account(mut)]
    pub landlord: Signer<'info>,
    #[account(
        mut,
        close = landlord,
        has_one = landlord,
        seeds = [LISTING_SEED, landlord.key().as_ref(), &listing.listing_id.to_le_bytes()],
        bump = listing.bump
    )]
    pub listing: Account<'info, Listing>,
}

pub fn handle_close_listing(_ctx: Context<CloseListing>) -> Result<()> {
    Ok(())
}
