use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{constants::*, error::ErrorCode, state::*};

/// Empties the deposit vault, signed by the lease PDA: `to_tenant` to the tenant,
/// `to_landlord` to the landlord. Callers must make the two add up to the deposit.
pub fn pay_out_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    lease: &Account<'info, Lease>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    tenant_ata: &InterfaceAccount<'info, TokenAccount>,
    landlord_ata: &InterfaceAccount<'info, TokenAccount>,
    to_tenant: u64,
    to_landlord: u64,
) -> Result<()> {
    let lease_id = lease.lease_id.to_le_bytes();
    let seeds: &[&[u8]] = &[LEASE_SEED, lease.landlord.as_ref(), &lease_id, &[lease.bump]];

    for (to, amount) in [(tenant_ata, to_tenant), (landlord_ata, to_landlord)] {
        transfer_checked(
            CpiContext::new_with_signer(
                token_program.key(),
                TransferChecked {
                    from: vault.to_account_info(),
                    mint: mint.to_account_info(),
                    to: to.to_account_info(),
                    authority: lease.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            mint.decimals,
        )?;
    }
    Ok(())
}

/// The one way a lease closes at an agreed deduction: empties the vault (`deposit - deduction` to
/// the tenant, `deduction` to the landlord), writes the deposit outcome to both records and sets
/// `Closed`.
///
/// `release_deposit` and all three dispute exits (`settle_dispute`, `accept_deduction`,
/// `finalize_deduction`) go through here, so the split and the reputation arithmetic cannot drift
/// between them. `claim_deposit` and `mark_default` keep their own bookkeeping, because a forced
/// claim and a seizure are not the same fact about the landlord.
#[allow(clippy::too_many_arguments)]
pub fn close_with_deduction<'info>(
    token_program: &Interface<'info, TokenInterface>,
    lease: &mut Account<'info, Lease>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    tenant_ata: &InterfaceAccount<'info, TokenAccount>,
    landlord_ata: &InterfaceAccount<'info, TokenAccount>,
    tenant_profile: &mut Profile,
    landlord_profile: &mut Profile,
    deduction: u64,
) -> Result<()> {
    let deposit = lease.deposit_amount;
    // Also enforced by every caller, and re-checked here because this is the function that moves
    // the money: a deduction above the deposit would try to pay out more than the vault holds.
    let to_tenant = deposit
        .checked_sub(deduction)
        .ok_or_else(|| error!(ErrorCode::DeductionTooLarge))?;

    pay_out_vault(
        token_program,
        lease,
        mint,
        vault,
        tenant_ata,
        landlord_ata,
        to_tenant,
        deduction,
    )?;

    for profile in [tenant_profile, landlord_profile] {
        profile.leases_completed = profile.leases_completed.saturating_add(1);
        profile.record_deposit_outcome(deposit, deduction)?;
        if deduction == 0 {
            profile.deposits_returned_full = profile.deposits_returned_full.saturating_add(1);
        }
    }

    lease.status = Status::Closed;
    lease.proposed_deduction = 0;
    lease.disputed_at = 0;
    emit!(LeaseClosed {
        lease: lease.key(),
        deduction,
    });
    Ok(())
}
