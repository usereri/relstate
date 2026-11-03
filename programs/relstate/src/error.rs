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
    /// Renamed in place from `DisputeAlreadyRejected`, keeping error number 6034: with
    /// `MAX_DISPUTE_ROUNDS = 2` a rejection no longer bars the next proposal, so the old name was
    /// wrong at round 1. See docs/contracts/dispute-mediation.md §8.
    #[msg("No dispute rounds are left on this lease, so the deposit returns in full")]
    DisputeRoundsExhausted,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("The deposit must be greater than zero")]
    ZeroDeposit,
    #[msg("The lease term (periods x period length) is too long")]
    TermTooLong,
    // ---- D2 mediation (docs/contracts/dispute-mediation.md). Appended, so every error number
    // above keeps the value already deployed; 6038 onwards.
    #[msg("Only the landlord or the tenant of this lease can do that")]
    NotMediationParty,
    #[msg("Wrong dispute round for this instruction: reject with abandon_dispute until the last round, then with escalate_to_mediation")]
    WrongDisputeRound,
    #[msg("An appraiser is already bound to this dispute")]
    AppraiserAlreadyBound,
    #[msg("No appraiser is bound to this dispute yet")]
    AppraiserNotBound,
    #[msg("Only the appraiser bound to this dispute can submit the verdict")]
    NotBoundAppraiser,
    #[msg("This side has already proposed its appraisers")]
    CandidatesAlreadyProposed,
    #[msg("The same appraiser company was proposed twice")]
    DuplicateCandidate,
    #[msg("That appraiser company was not proposed by either side")]
    CandidateNotProposed,
    #[msg("Nothing is bound yet and the selection window is still open")]
    SelectionWindowOpen,
    #[msg("The appraiser still has time to submit a verdict")]
    VerdictWindowOpen,
    #[msg("The window for the appraiser's verdict has passed")]
    VerdictWindowClosed,
    #[msg("Settling a lease in mediation needs its dispute account")]
    DisputeAccountRequired,
    #[msg("This lease has no dispute account to pass")]
    UnexpectedDisputeAccount,
    #[msg("The selection window has closed, so the mediation can be expired")]
    SelectionWindowClosed,
    #[msg("An appraiser name must be 1-64 bytes of UTF-8 without control characters")]
    InvalidAppraiserName,
    #[msg("Propose between one and three appraiser candidates")]
    NoCandidates,
    #[msg("The appraiser fee is above a tenth of the deposit")]
    FeeAboveCap,
    #[msg("The appraiser company is already agreed")]
    NameAlreadyAgreed,
    #[msg("The two sides have not agreed on an appraiser company yet")]
    NameNotAgreed,
    #[msg("An appraiser's wallet must not be the default (all-zero) pubkey")]
    InvalidAppraiserKey,
    #[msg("No more appraiser wallet proposals are allowed; confirm the last one or let the mediation expire")]
    KeyProposalsExhausted,
    #[msg("No appraiser wallet has been proposed")]
    NoKeyProposed,
    #[msg("The other party must confirm the appraiser wallet")]
    CannotConfirmOwnProposal,
    #[msg("That is not the appraiser wallet that was proposed")]
    KeyMismatch,
}
