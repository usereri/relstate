// The appraiser registry: one `Appraiser` PDA per appraisal company, written only by the Config
// admin (docs/contracts/dispute-mediation.md §3).
//
// Why a registry exists at all: without it, "each side nominates three companies" is worthless,
// because a landlord would nominate three keys they control and pick one of their own. Every
// instruction that touches a candidate takes the `Appraiser` account, so Anchor's seed and
// discriminator checks *are* the registry lookup — there is no code path on which an unregistered
// or suspended key reaches a candidate list, a pick, or a verdict.
//
// The admin here is the same Config admin that maintains the mint allowlist. That is a disclosed
// centralisation, in the same trust class as the KYC issuer key: see §10 of the contract doc.
use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RegisterAppraiser<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        has_one = admin @ ErrorCode::NotAdmin,
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = 8 + Appraiser::INIT_SPACE,
        seeds = [APPRAISER_SEED, wallet.as_ref()],
        bump
    )]
    pub appraiser: Account<'info, Appraiser>,
    pub system_program: Program<'info, System>,
}

/// Adds a company to the registry, active from the start. One account per key, so a second call
/// for the same wallet fails inside Anchor's `init` — use `set_appraiser_active` to restore a
/// suspended entry rather than re-registering it.
///
/// Rejects the all-zero pubkey: `Dispute` uses it as "nobody has picked / nothing is bound", so a
/// registered all-zero appraiser would make an unbound dispute indistinguishable from a bound one.
///
/// `fee` is not validated beyond that. It does not need to be: every verdict caps it at
/// `deposit / APPRAISER_FEE_CAP_DIVISOR`, so an entry with an absurd fee is harmless rather than
/// dangerous, and the cap is the number worth reading.
pub fn handle_register_appraiser(
    ctx: Context<RegisterAppraiser>,
    wallet: Pubkey,
    fee: u64,
    name_hash: [u8; 32],
) -> Result<()> {
    require_keys_neq!(wallet, Pubkey::default(), ErrorCode::InvalidAppraiser);

    let appraiser = &mut ctx.accounts.appraiser;
    appraiser.wallet = wallet;
    appraiser.active = true;
    appraiser.is_default = false;
    appraiser.fee = fee;
    appraiser.name_hash = name_hash;
    appraiser.bump = ctx.bumps.appraiser;
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateAppraiser<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin @ ErrorCode::NotAdmin,
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [APPRAISER_SEED, appraiser.wallet.as_ref()],
        bump = appraiser.bump
    )]
    pub appraiser: Account<'info, Appraiser>,
}

/// Suspends or restores an entry. Suspension is not deletion: the record stays, so an appraiser
/// who has already signed verdicts keeps a verifiable history.
///
/// Suspending an appraiser who is bound to a live dispute stops them submitting, and deliberately
/// does **not** strand the deposit: `expire_mediation` and `settle_dispute` are both still open,
/// and the mediation expires to a full refund if nobody acts.
pub fn handle_set_appraiser_active(ctx: Context<UpdateAppraiser>, active: bool) -> Result<()> {
    let appraiser = &mut ctx.accounts.appraiser;
    appraiser.active = active;
    // A suspended entry must not stay the deadlock fallback: `bind_default_appraiser` would then
    // have nothing to bind and the only exits left would be the slow ones.
    if !active {
        appraiser.is_default = false;
    }
    Ok(())
}

/// Flags (or unflags) the appraiser `bind_default_appraiser` may bind when the two sides fail to
/// agree in time. Admin only, and only an active entry can take it.
///
/// **Uniqueness is the admin's job, not the program's.** There is no on-chain index of appraisers
/// to iterate, so this cannot clear the flag on whatever else carries it. Every flagged entry is
/// still admin-chosen and active, so the worst case of flagging several is an unexpected but
/// legitimate appraiser, not a hole. Keep one. See §4 of the contract doc.
pub fn handle_set_default_appraiser(ctx: Context<UpdateAppraiser>, is_default: bool) -> Result<()> {
    let appraiser = &mut ctx.accounts.appraiser;
    if is_default {
        require!(appraiser.active, ErrorCode::AppraiserInactive);
    }
    appraiser.is_default = is_default;
    Ok(())
}
