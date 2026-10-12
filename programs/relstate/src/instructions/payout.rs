use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{constants::*, error::ErrorCode, state::*};

/// Empties the deposit vault, signed by the lease PDA: `to_tenant` to the tenant,
/// `to_landlord` to the landlord, and — only on an appraiser's verdict — `fee` to a third account.
/// Callers must make the amounts add up to the deposit.
///
/// The lease PDA is the vault's only authority, here and nowhere else. An appraiser signs the
/// *verdict*; they never gain any authority over the vault.
pub fn pay_out_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    lease: &Account<'info, Lease>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    tenant_ata: &InterfaceAccount<'info, TokenAccount>,
    landlord_ata: &InterfaceAccount<'info, TokenAccount>,
    to_tenant: u64,
    to_landlord: u64,
    fee: Option<(&InterfaceAccount<'info, TokenAccount>, u64)>,
) -> Result<()> {
    let lease_id = lease.lease_id.to_le_bytes();
    let seeds: &[&[u8]] = &[LEASE_SEED, lease.landlord.as_ref(), &lease_id, &[lease.bump]];

    let mut legs = vec![(tenant_ata, to_tenant), (landlord_ata, to_landlord)];
    legs.extend(fee);

    for (to, amount) in legs {
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
    close_with_fee(
        token_program,
        lease,
        mint,
        vault,
        tenant_ata,
        landlord_ata,
        tenant_profile,
        landlord_profile,
        deduction,
        None,
        0,
    )
    .map(|_| ())
}

/// `close_with_deduction` with an appraiser's fee taken out of the deposit — the D2 verdict path,
/// and the only caller that passes a fee.
///
/// It is the same function rather than a second one on purpose: `submit_verdict` introduces no new
/// way to move money, so the split arithmetic, the reputation bookkeeping and the `Closed`
/// transition are shared with the four exits that already existed. `verdict_split` decides who
/// pays the fee (docs/contracts/dispute-mediation.md §6) and guarantees the three shares add up to
/// the deposit exactly.
///
/// `deduction` is what goes on both records' reputation, not what the landlord nets: the fee is a
/// cost of the arbitration, not a deduction the landlord won.
#[allow(clippy::too_many_arguments)]
pub fn close_with_fee<'info>(
    token_program: &Interface<'info, TokenInterface>,
    lease: &mut Account<'info, Lease>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    tenant_ata: &InterfaceAccount<'info, TokenAccount>,
    landlord_ata: &InterfaceAccount<'info, TokenAccount>,
    tenant_profile: &mut Profile,
    landlord_profile: &mut Profile,
    deduction: u64,
    fee_ata: Option<&InterfaceAccount<'info, TokenAccount>>,
    registry_fee: u64,
) -> Result<VerdictSplit> {
    let deposit = lease.deposit_amount;
    // Also enforced by every caller, and re-checked here because this is the function that moves
    // the money: a deduction above the deposit would try to pay out more than the vault holds.
    let split = match fee_ata {
        None => {
            let to_tenant = deposit
                .checked_sub(deduction)
                .ok_or_else(|| error!(ErrorCode::DeductionTooLarge))?;
            VerdictSplit {
                to_tenant,
                to_landlord: deduction,
                to_appraiser: 0,
            }
        }
        Some(_) => verdict_split(deposit, deduction, registry_fee)?,
    };

    pay_out_vault(
        token_program,
        lease,
        mint,
        vault,
        tenant_ata,
        landlord_ata,
        split.to_tenant,
        split.to_landlord,
        fee_ata.map(|ata| (ata, split.to_appraiser)),
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
    Ok(split)
}
