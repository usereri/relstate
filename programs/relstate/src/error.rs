use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Lease is not in the required status")]
    WrongStatus,
    #[msg("All rent periods are already paid")]
    TermCompleted,
    #[msg("Rent periods are still unpaid")]
    TermIncomplete,
    #[msg("Deduction is larger than deposit")]
    DeductionTooLarge,
}
