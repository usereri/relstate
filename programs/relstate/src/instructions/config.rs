use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

/// Claims the one config account for the signer. There is a single config PDA per deployment, so
/// this succeeds exactly once per network: whoever deploys the program should run it immediately.
/// A second call fails in Anchor's `init` (the account already exists).
pub fn handle_init_config(ctx: Context<InitConfig>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.bump = ctx.bumps.config;
    config.mints = Vec::new();
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin @ ErrorCode::NotAdmin,
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,
}

/// Adds or removes a mint leases may be denominated in. Idempotent either way.
pub fn handle_set_mint_allowed(
    ctx: Context<UpdateConfig>,
    mint: Pubkey,
    allowed: bool,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    match (allowed, config.mints.iter().position(|m| m == &mint)) {
        (true, None) => {
            require!(
                config.mints.len() < MAX_ALLOWED_MINTS,
                ErrorCode::MintListFull
            );
            config.mints.push(mint);
        }
        (false, Some(i)) => {
            config.mints.remove(i);
        }
        // already in the wanted state
        (true, Some(_)) | (false, None) => {}
    }
    Ok(())
}

/// Hands the config to another key. The config PDA is fixed per deployment, so without this a
/// network whose config was claimed by the wrong wallet could never be handed to the backend.
pub fn handle_set_admin(ctx: Context<UpdateConfig>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.config.admin = new_admin;
    Ok(())
}
