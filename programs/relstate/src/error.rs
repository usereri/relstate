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
    #[msg("Region must be two uppercase letters (ISO country code)")]
    InvalidRegion,
    #[msg("Listing text is too long")]
    TextTooLong,
    #[msg("Only the applicant or the landlord can close an application")]
    NotYourApplication,
    #[msg("Only the config admin can change the program settings")]
    NotAdmin,
    #[msg("The allowed-mint list is full")]
    MintListFull,
    #[msg("The mint account could not be read")]
    InvalidMintData,
    #[msg("Paying rent on a confidential mint needs a matching Token-2022 confidential transfer directly before pay_rent")]
    MissingConfidentialTransfer,
    #[msg("A confidential-transfer mint must carry an auditor ElGamal pubkey to be allowed")]
    ConfidentialMintNeedsAuditor,
    #[msg("The mint carries an extension that is not allowed for leases")]
    DisallowedMintExtension,
    #[msg("The new admin must not be the default (all-zero) pubkey")]
    InvalidNewAdmin,
    #[msg("This wallet needs a valid identity attestation (level 1 or higher, not revoked, not expired)")]
    KycRequired,
    #[msg("Only the issuer key in the program config can write or revoke an attestation")]
    NotIssuer,
    #[msg("No attestation issuer is set in the program config")]
    IssuerNotSet,
    #[msg("The issuer must not be the default (all-zero) pubkey")]
    InvalidIssuer,
    #[msg("An attestation must be level 1 (basic) or 2 (enhanced)")]
    InvalidAttestationLevel,
    #[msg("An attestation's expiry must be in the future, or zero for never")]
    AttestationExpiryInPast,
    #[msg("An attestation needs a non-zero subject hash")]
    InvalidSubjectHash,
    #[msg("The tenant still has time to answer the proposed deduction")]
    DisputeWindowOpen,
    #[msg("The window to reject the proposed deduction has passed")]
    DisputeWindowClosed,
    #[msg("The tenant already rejected a deduction on this lease, so the deposit returns in full")]
    DisputeAlreadyRejected,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
