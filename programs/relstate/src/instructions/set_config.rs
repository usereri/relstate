use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct SetConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

// The first call creates the config and makes the signer its admin (call it right after deploy);
// later calls must come from that admin. Replaces every setting at once.
pub fn handle_set_config(
    ctx: Context<SetConfig>,
    treasury: Pubkey,
    fee_bps: u16,
    mints: Vec<Pubkey>,
    attesters: Vec<Pubkey>,
    arbitrators: Vec<Pubkey>,
) -> Result<()> {
    require!(fee_bps <= 10_000, ErrorCode::FeeTooHigh);
    require!(
        mints.len() <= MAX_MINTS
            && attesters.len() <= MAX_ATTESTERS
            && arbitrators.len() <= MAX_ARBITRATORS,
        ErrorCode::ConfigListTooLong
    );

    let config = &mut ctx.accounts.config;
    if config.admin == Pubkey::default() {
        config.admin = ctx.accounts.admin.key();
        config.bump = ctx.bumps.config;
    }
    require_keys_eq!(config.admin, ctx.accounts.admin.key(), ErrorCode::NotAdmin);

    config.treasury = treasury;
    config.fee_bps = fee_bps;
    config.mints = mints;
    config.attesters = attesters;
    config.arbitrators = arbitrators;
    Ok(())
}
