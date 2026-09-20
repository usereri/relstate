use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
#[instruction(listing_id: u64)]
pub struct CreateListing<'info> {
    #[account(mut)]
    pub landlord: Signer<'info>,
    #[account(
        init,
        payer = landlord,
        space = 8 + Listing::INIT_SPACE,
        seeds = [LISTING_SEED, landlord.key().as_ref(), &listing_id.to_le_bytes()],
        bump
    )]
    pub listing: Account<'info, Listing>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_listing(
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
    require!(rent_amount > 0, ErrorCode::ZeroRent);
    require!(region.iter().all(u8::is_ascii_uppercase), ErrorCode::InvalidRegion);
    require!(
        title.len() <= MAX_TITLE && city.len() <= MAX_CITY && blurb.len() <= MAX_BLURB && photo.len() <= MAX_PHOTO,
        ErrorCode::TextTooLong
    );

    let listing = &mut ctx.accounts.listing;
    listing.landlord = ctx.accounts.landlord.key();
    listing.listing_id = listing_id;
    listing.rent_amount = rent_amount;
    listing.deposit_amount = deposit_amount;
    listing.region = region;
    listing.bump = ctx.bumps.listing;
    listing.title = title;
    listing.city = city;
    listing.blurb = blurb;
    listing.photo = photo;
    Ok(())
}
