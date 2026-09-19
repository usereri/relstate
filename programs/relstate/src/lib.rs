pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("5J52oGfo7BjC529vizEaM96QtxVFD4Kbv22Tw8aXa1Ar");

#[program]
pub mod relstate {
    use super::*;

    pub fn create_lease(
        ctx: Context<CreateLease>,
        lease_id: u64,
        rent_amount: u64,
        deposit_amount: u64,
        period_secs: i64,
        grace_secs: i64,
        term_periods: u16,
        lease_hash: [u8; 32],
    ) -> Result<()> {
        crate::instructions::create_lease::handle_create_lease(
            ctx,
            lease_id,
            rent_amount,
            deposit_amount,
            period_secs,
            grace_secs,
            term_periods,
            lease_hash,
        )
    }

    pub fn fund_deposit(ctx: Context<FundDeposit>) -> Result<()> {
        crate::instructions::fund_deposit::handle_fund_deposit(ctx)
    }

    pub fn pay_rent(ctx: Context<PayRent>) -> Result<()> {
        crate::instructions::pay_rent::handle_pay_rent(ctx)
    }

    pub fn release_deposit(ctx: Context<ReleaseDeposit>, deduction: u64) -> Result<()> {
        crate::instructions::release_deposit::handle_release_deposit(ctx, deduction)
    }
}
