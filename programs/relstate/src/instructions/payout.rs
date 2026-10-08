use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{constants::*, state::*};

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
