use anchor_lang::prelude::*;
use solana_instructions_sysvar::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
};
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        confidential_transfer::ConfidentialTransferMint, BaseStateWithExtensions,
        StateWithExtensions,
    },
    state::Mint as MintState,
};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{constants::*, error::ErrorCode, state::*};

// Token-2022 packs an extension instruction as [TokenInstruction, <extension instruction>, data].
// Asserted against the crate's own encoding in the tests at the bottom of this file.
const CONFIDENTIAL_TRANSFER_EXTENSION: u8 = 27; // TokenInstruction::ConfidentialTransferExtension
const CONFIDENTIAL_TRANSFER: u8 = 7; // ConfidentialTransferInstruction::Transfer

#[derive(Accounts)]
pub struct PayRent<'info> {
    pub tenant: Signer<'info>,
    #[account(
        mut,
        has_one = tenant,
        has_one = mint,
        seeds = [LEASE_SEED, lease.landlord.as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump
    )]
    pub lease: Account<'info, Lease>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = tenant
    )]
    pub tenant_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = lease.landlord
    )]
    pub landlord_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, tenant.key().as_ref()],
        bump
    )]
    pub tenant_profile: Account<'info, Profile>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: the instructions sysvar, read to find the confidential transfer that carries the
    /// rent on a confidential mint. Pinned by address, and unused on a public mint.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

pub fn handle_pay_rent(ctx: Context<PayRent>) -> Result<()> {
    let lease = &ctx.accounts.lease;
    require!(
        lease.status == Status::Active,
        ErrorCode::WrongStatus
    );
    require!(
        lease.paid_count < lease.term_periods,
        ErrorCode::TermCompleted
    );

    // no prepaying: period k can only be paid once it is due
    let due = lease.start_ts + lease.paid_count as i64 * lease.period_secs;
    let now = Clock::get()?.unix_timestamp;
    require!(now >= due, ErrorCode::TooEarly);

    // On a confidential mint the rent does not move through this instruction at all: the tenant
    // puts a Token-2022 confidential transfer in the same transaction and the program only
    // checks that it is there and points the right way. See docs/privacy.md.
    let confidential = is_confidential_mint(&ctx.accounts.mint.to_account_info())?;
    if confidential {
        require_confidential_transfer(
            &ctx.accounts.instructions.to_account_info(),
            &ctx.accounts.tenant_ata.key(),
            &ctx.accounts.mint.key(),
            &ctx.accounts.landlord_ata.key(),
        )?;
    } else {
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked{
                    from: ctx.accounts.tenant_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.landlord_ata.to_account_info(),
                    authority: ctx.accounts.tenant.to_account_info(),
                },
            ),
            lease.rent_amount,
            ctx.accounts.mint.decimals,
        )?;
    }

    let on_time = now <= due + lease.grace_secs;

    let profile = &mut ctx.accounts.tenant_profile;
    // The contracted rent, not a verified settled amount: on the confidential path the program
    // cannot see what was actually sent (docs/privacy.md, "What pay_rent can and cannot enforce").
    profile.rent_paid_total += lease.rent_amount;
    if on_time {
        profile.paid_on_time += 1;
    } else {
        profile.paid_late += 1;
    }

    let lease = &mut ctx.accounts.lease;
    lease.paid_count += 1;
    emit!(RentPaid {
        lease: lease.key(),
        period: lease.paid_count,
        on_time,
        confidential,
    });
    Ok(())
}

/// Whether the mint carries Token-2022's `ConfidentialTransferMint` extension. This is what picks
/// the payment path, so a lease denominated in a confidential mint is confidential for its whole
/// life and a classic SPL lease keeps moving public amounts.
fn is_confidential_mint(mint: &AccountInfo) -> Result<bool> {
    if mint.owner != &anchor_spl::token_2022::ID {
        return Ok(false);
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data)
        .map_err(|_| error!(ErrorCode::InvalidMintData))?;
    Ok(state.get_extension::<ConfidentialTransferMint>().is_ok())
}

/// Requires a Token-2022 confidential `Transfer` from `source` to `destination` on `mint` as the
/// instruction directly before this one.
///
/// Directly before, rather than anywhere in the transaction, for two reasons: the transaction is
/// atomic, so a transfer that fails takes this instruction's bookkeeping with it; and pinning the
/// position pairs exactly one transfer with one recorded payment, so a tenant cannot settle two
/// overdue periods with a single transfer.
///
/// The amount is encrypted and is not checked. That gap is covered off-chain by the auditor key
/// (docs/privacy.md).
fn require_confidential_transfer(
    instructions: &AccountInfo,
    source: &Pubkey,
    mint: &Pubkey,
    destination: &Pubkey,
) -> Result<()> {
    let index = load_current_index_checked(instructions)?;
    require!(index > 0, ErrorCode::MissingConfidentialTransfer);
    let transfer = load_instruction_at_checked(index as usize - 1, instructions)
        .map_err(|_| error!(ErrorCode::MissingConfidentialTransfer))?;

    require!(
        is_confidential_transfer_to(&transfer, source, mint, destination),
        ErrorCode::MissingConfidentialTransfer
    );
    Ok(())
}

/// The shape check itself. `Transfer` always carries source, mint and destination as its first
/// three accounts; everything after them (the instructions sysvar, proof context state accounts,
/// the owner) varies with where the proofs live, so it is not inspected.
fn is_confidential_transfer_to(
    ix: &anchor_lang::solana_program::instruction::Instruction,
    source: &Pubkey,
    mint: &Pubkey,
    destination: &Pubkey,
) -> bool {
    ix.program_id == anchor_spl::token_2022::ID
        && ix.data.len() >= 2
        && ix.data[0] == CONFIDENTIAL_TRANSFER_EXTENSION
        && ix.data[1] == CONFIDENTIAL_TRANSFER
        && ix.accounts.len() >= 3
        && ix.accounts[0].pubkey == *source
        && ix.accounts[1].pubkey == *mint
        && ix.accounts[2].pubkey == *destination
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
    use anchor_spl::token_2022::spl_token_2022::{
        extension::confidential_transfer::instruction::ConfidentialTransferInstruction,
        instruction::TokenInstruction,
    };

    /// The two bytes the matcher looks for are the ones Token-2022 actually writes.
    #[test]
    fn discriminators_match_token_2022() {
        assert_eq!(
            TokenInstruction::ConfidentialTransferExtension.pack(),
            vec![CONFIDENTIAL_TRANSFER_EXTENSION]
        );
        assert_eq!(
            u8::from(ConfidentialTransferInstruction::Transfer),
            CONFIDENTIAL_TRANSFER
        );
    }

    fn keys() -> (Pubkey, Pubkey, Pubkey) {
        (
            Pubkey::new_unique(), // source
            Pubkey::new_unique(), // mint
            Pubkey::new_unique(), // destination
        )
    }

    /// A confidential transfer as Token-2022 builds it, with the proofs inline: the instructions
    /// sysvar and the owner follow the three accounts the matcher reads.
    fn transfer_ix(source: Pubkey, mint: Pubkey, destination: Pubkey) -> Instruction {
        Instruction {
            program_id: anchor_spl::token_2022::ID,
            accounts: vec![
                AccountMeta::new(source, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new(destination, false),
                AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR_ID, false),
                AccountMeta::new_readonly(Pubkey::new_unique(), true),
            ],
            data: {
                let mut data = vec![CONFIDENTIAL_TRANSFER_EXTENSION, CONFIDENTIAL_TRANSFER];
                data.extend_from_slice(&[0u8; 97]); // TransferInstructionData, contents unread
                data
            },
        }
    }

    #[test]
    fn accepts_a_matching_transfer() {
        let (source, mint, destination) = keys();
        assert!(is_confidential_transfer_to(
            &transfer_ix(source, mint, destination),
            &source,
            &mint,
            &destination
        ));
    }

    /// Only the first three accounts are read, so pre-verified proofs (which replace the sysvar
    /// with up to three context state accounts) match just as well.
    #[test]
    fn accepts_a_transfer_with_pre_verified_proofs() {
        let (source, mint, destination) = keys();
        let mut ix = transfer_ix(source, mint, destination);
        ix.accounts.truncate(3);
        ix.accounts.extend((0..4).map(|_| AccountMeta::new_readonly(Pubkey::new_unique(), false)));
        assert!(is_confidential_transfer_to(&ix, &source, &mint, &destination));
    }

    #[test]
    fn rejects_a_transfer_to_someone_else() {
        let (source, mint, destination) = keys();
        let ix = transfer_ix(source, mint, Pubkey::new_unique());
        assert!(!is_confidential_transfer_to(&ix, &source, &mint, &destination));
    }

    #[test]
    fn rejects_a_transfer_from_someone_else() {
        let (source, mint, destination) = keys();
        let ix = transfer_ix(Pubkey::new_unique(), mint, destination);
        assert!(!is_confidential_transfer_to(&ix, &source, &mint, &destination));
    }

    #[test]
    fn rejects_a_transfer_on_another_mint() {
        let (source, mint, destination) = keys();
        let ix = transfer_ix(source, Pubkey::new_unique(), destination);
        assert!(!is_confidential_transfer_to(&ix, &source, &mint, &destination));
    }

    #[test]
    fn rejects_another_token_2022_instruction() {
        let (source, mint, destination) = keys();
        let mut ix = transfer_ix(source, mint, destination);
        // Withdraw, not Transfer: it would move the amount out to a public balance instead.
        ix.data[1] = u8::from(ConfidentialTransferInstruction::Withdraw);
        assert!(!is_confidential_transfer_to(&ix, &source, &mint, &destination));
    }

    #[test]
    fn rejects_a_public_transfer_checked() {
        let (source, mint, destination) = keys();
        let mut ix = transfer_ix(source, mint, destination);
        ix.data = vec![u8::from(12u8), 0, 0, 0, 0, 0, 0, 0, 0, 6]; // TransferChecked
        assert!(!is_confidential_transfer_to(&ix, &source, &mint, &destination));
    }

    #[test]
    fn rejects_the_same_instruction_on_the_classic_token_program() {
        let (source, mint, destination) = keys();
        let mut ix = transfer_ix(source, mint, destination);
        ix.program_id = anchor_spl::token::ID;
        assert!(!is_confidential_transfer_to(&ix, &source, &mint, &destination));
    }

    #[test]
    fn rejects_a_truncated_instruction() {
        let (source, mint, destination) = keys();
        for len in 0..2 {
            let mut ix = transfer_ix(source, mint, destination);
            ix.data.truncate(len);
            assert!(!is_confidential_transfer_to(&ix, &source, &mint, &destination));
        }
        let mut ix = transfer_ix(source, mint, destination);
        ix.accounts.truncate(2);
        assert!(!is_confidential_transfer_to(&ix, &source, &mint, &destination));
    }
}
