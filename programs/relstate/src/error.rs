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
    #[msg("Rent must be greater than zero")]
    ZeroRent,
    #[msg("Lease needs at least one rent period")]
    ZeroTerm,
    #[msg("Rent period is shorter than the minimum")]
    PeriodTooShort,
    #[msg("Landlord and tenant must be different wallets")]
    SelfLease,
    #[msg("Grace must be between zero and one period")]
    InvalidGrace,
    #[msg("Rent is not overdue long enough to declare a default")]
    NotInDefault,
    #[msg("The landlord still has time to release the deposit")]
    ClaimTooEarly,
    #[msg("Lease hash does not match the proposed lease")]
    LeaseHashMismatch,
    #[msg("This rent period is not due yet")]
    TooEarly,
    #[msg("The lease term has not ended yet")]
    LeaseNotEnded,
    #[msg("Mint is not allowed for leases")]
    MintNotAllowed,
}
