use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        confidential_transfer::ConfidentialTransferMint,
        default_account_state::DefaultAccountState, non_transferable::NonTransferable,
        pausable::PausableConfig, permanent_delegate::PermanentDelegate,
        transfer_fee::TransferFeeConfig, transfer_hook::TransferHook, BaseStateWithExtensions,
        StateWithExtensions,
    },
    state::{AccountState, Mint as MintState},
};
use anchor_spl::token_interface::Mint;
use spl_pod::optional_keys::OptionalNonZeroElGamalPubkey;

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

#[derive(Accounts)]
pub struct SetMintAllowed<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin @ ErrorCode::NotAdmin,
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,
    /// The mint being allowed or removed. On allow it is inspected for extensions that would
    /// break the escrow arithmetic or disable the confidential-transfer privacy mitigation.
    pub mint: InterfaceAccount<'info, Mint>,
}

/// Adds or removes the mint from the allowlist. Idempotent either way.
///
/// On allow, the mint is validated first (see `validate_mint_allowable`); on removal it is not,
/// so a mint that later turns out to be unwanted can always be taken off the list.
pub fn handle_set_mint_allowed(ctx: Context<SetMintAllowed>, allowed: bool) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();
    if allowed {
        validate_mint_allowable(&ctx.accounts.mint.to_account_info())?;
    }
    let config = &mut ctx.accounts.config;
    match (allowed, config.mints.iter().position(|m| *m == mint_key)) {
        (true, None) => {
            require!(
                config.mints.len() < MAX_ALLOWED_MINTS,
                ErrorCode::MintListFull
            );
            config.mints.push(mint_key);
        }
        (false, Some(i)) => {
            config.mints.remove(i);
        }
        // already in the wanted state
        (true, Some(_)) | (false, None) => {}
    }
    Ok(())
}

/// Guards the allowlist, which is the only thing standing between the program and a mint whose
/// behaviour would break it. The escrow arithmetic assumes transfers move the exact amount and
/// that nothing but the program can move vault funds, and the confidential-rent pitch assumes a
/// rent payment can be decrypted by the auditor. A mint that violates any of those must not be
/// allowed, or the damage only surfaces later (a stuck deposit, an undecryptable payment).
///
/// Runs at setup time, so a bad mint fails the deploy script rather than a live rent payment.
fn validate_mint_allowable(mint: &AccountInfo) -> Result<()> {
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data)
        .map_err(|_| error!(ErrorCode::InvalidMintData))?;

    // A confidential mint with no auditor ElGamal key takes the confidential pay_rent path
    // happily, but nobody except the two counterparties could ever decrypt an amount - the
    // auditor key is the only compensating control for the amount the program cannot see
    // (docs/privacy.md). Reject it here rather than let it silently disable the mitigation.
    if let Ok(ct) = state.get_extension::<ConfidentialTransferMint>() {
        require!(
            ct.auditor_elgamal_pubkey != OptionalNonZeroElGamalPubkey::default(),
            ErrorCode::ConfidentialMintNeedsAuditor
        );
    }

    // Extensions that break the escrow arithmetic or let a third party block or drain the vault:
    //   TransferFeeConfig    - transfers deliver less than they send, so the vault can never pay
    //                          the full deposit back out (release/claim/default all fail).
    //   NonTransferable      - the vault can never be emptied.
    //   PermanentDelegate    - the mint authority can drain the vault directly.
    //   TransferHook         - third-party code gates every payout.
    //   PausableConfig       - transfers, and so payouts, can be paused at will.
    //   DefaultAccountState  - only when frozen: new token accounts (the vault) start frozen.
    let disallowed = state.get_extension::<TransferFeeConfig>().is_ok()
        || state.get_extension::<NonTransferable>().is_ok()
        || state.get_extension::<PermanentDelegate>().is_ok()
        || state.get_extension::<TransferHook>().is_ok()
        || state.get_extension::<PausableConfig>().is_ok()
        || state
            .get_extension::<DefaultAccountState>()
            .map(|d| d.state == AccountState::Frozen as u8)
            .unwrap_or(false);
    require!(!disallowed, ErrorCode::DisallowedMintExtension);

    Ok(())
}

/// Hands the config to another key. The config PDA is fixed per deployment, so without this a
/// network whose config was claimed by the wrong wallet could never be handed to the backend.
///
/// Rejects the default (all-zero) pubkey: there is no keypair behind it, so handing the config to
/// it would freeze the allowlist permanently with no recovery but a new program id. `set_admin`
/// exists precisely as the recovery path, so it must not be able to brick the deployment.
pub fn handle_set_admin(ctx: Context<UpdateConfig>, new_admin: Pubkey) -> Result<()> {
    require_keys_neq!(new_admin, Pubkey::default(), ErrorCode::InvalidNewAdmin);
    ctx.accounts.config.admin = new_admin;
    Ok(())
}
