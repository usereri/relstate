use anchor_lang::prelude::*;

use crate::{error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct CloseApplication<'info> {
    pub signer: Signer<'info>,
    #[account(
        mut,
        close = tenant,
        constraint = signer.key() == application.tenant || signer.key() == application.landlord
            @ ErrorCode::NotYourApplication
    )]
    pub application: Account<'info, Application>,
    /// CHECK: the applicant, who paid for the account and gets the rent back
    #[account(mut, address = application.tenant)]
    pub tenant: UncheckedAccount<'info>,
}

pub fn handle_close_application(_ctx: Context<CloseApplication>) -> Result<()> {
    Ok(())
}
