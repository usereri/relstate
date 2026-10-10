use anchor_lang::prelude::*;

use crate::constants::{
    KYC_LEVEL_BASIC, MAX_ALLOWED_MINTS, MAX_BLURB, MAX_CITY, MAX_PHOTO, MAX_TITLE,
    RENT_HEADROOM_PCT,
};

/// Program-wide settings, one account at seeds `[CONFIG_SEED]`. Holds the mints a lease may be
/// denominated in: whoever runs `init_config` on a fresh network becomes the admin that edits it.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub bump: u8,
    #[max_len(MAX_ALLOWED_MINTS)]
    pub mints: Vec<Pubkey>,
    /// The only key `attest` and `revoke` accept as a signer. Deliberately **not** the fee payer
    /// key: a leaked sponsor key must not be able to mint identity (docs/contracts/attestation.md).
    /// All-zero means no issuer has been set, and `require_kyc` cannot be turned on without one.
    pub issuer: Pubkey,
    /// Whether `apply` and `propose_lease` demand a valid attestation from the acting wallet.
    /// False by default, which is what keeps a fresh network (and the test suite) usable before
    /// any KYC exists; the devnet demo deploy turns it on.
    pub require_kyc: bool,
}

impl Config {
    pub fn allows(&self, mint: &Pubkey) -> bool {
        self.mints.contains(mint)
    }
}

/// One wallet's KYC result, written only by the issuer key. Seeds `[ATTESTATION_SEED, wallet]`.
///
/// No personal data lives here and none ever should: the only link back to the applicant is
/// `subject_hash`, which the backend computes as `sha256(applicant_id || salt)` with a salt it
/// never publishes (docs/privacy.md). The chain therefore proves *that* a wallet passed a check
/// at a point in time, and nothing about who it belongs to.
#[account]
#[derive(InitSpace)]
pub struct Attestation {
    pub wallet: Pubkey,
    /// The issuer at the time of signing. Compared against `Config::issuer` on every check, so
    /// rotating the issuer invalidates everything the old key vouched for.
    pub issuer: Pubkey,
    /// 0 none (never stored), 1 basic, 2 enhanced.
    pub level: u8,
    pub verified_at: i64,
    /// Unix seconds; 0 means it never expires. The demo issues one year.
    pub expires_at: i64,
    pub revoked: bool,
    pub subject_hash: [u8; 32],
    pub bump: u8,
}

impl Attestation {
    /// Whether this record clears the gate: the right subject, a current issuer, at least basic
    /// level, not revoked, not expired.
    pub fn is_valid(&self, wallet: &Pubkey, issuer: &Pubkey, now: i64) -> bool {
        self.wallet == *wallet
            && self.issuer == *issuer
            && self.level >= KYC_LEVEL_BASIC
            && !self.revoked
            && (self.expires_at == 0 || self.expires_at > now)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Status {
    Proposed,
    Active,
    Closed,
    Defaulted,
}

#[account]
#[derive(InitSpace)]
pub struct Lease {
    pub landlord: Pubkey,
    pub tenant: Pubkey,
    pub mint: Pubkey,
    pub lease_id: u64,
    pub rent_amount: u64,
    pub deposit_amount: u64,
    pub start_ts: i64,
    pub term_periods: u16,
    pub paid_count: u16,
    pub lease_hash: [u8; 32],
    pub status: Status,
    pub bump: u8,
    pub period_secs: i64,
    // how long after a due date a payment still counts as on time
    pub grace_secs: i64,
    // ISO 3166-1 alpha-2 country of the rented unit, e.g. *b"PL"
    pub region: [u8; 2],
    // good-standing discount applied to this lease's deposit, 0 if none
    pub discount_pct: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub landlord: Pubkey,
    pub listing_id: u64,
    pub rent_amount: u64,
    pub deposit_amount: u64,
    pub region: [u8; 2],
    pub bump: u8,
    #[max_len(MAX_TITLE)]
    pub title: String,
    #[max_len(MAX_CITY)]
    pub city: String,
    #[max_len(MAX_BLURB)]
    pub blurb: String,
    // image URL
    #[max_len(MAX_PHOTO)]
    pub photo: String,
}

#[account]
#[derive(InitSpace)]
pub struct Application {
    pub listing: Pubkey,
    pub landlord: Pubkey,
    pub tenant: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct Profile {
    pub wallet: Pubkey,
    pub leases_completed: u32,
    pub paid_on_time: u32,
    pub paid_late: u32,
    pub deposits_returned_full: u32,
    pub deposit_total: u64,
    pub deducted_total: u64,
    pub defaults: u32,
    pub deposits_claimed: u32,
    pub rent_paid_total: u64,
}

impl Profile {
    pub fn good_standing(&self) -> bool {
        self.leases_completed >= 1 && self.paid_late == 0 && self.defaults == 0
    }

    pub fn typical_rent(&self) -> u64 {
        let payments = self.paid_on_time as u64 + self.paid_late as u64;
        if payments == 0 {
            0
        } else {
            self.rent_paid_total / payments
        }
    }

    pub fn deserves_discount(&self, rent: u64) -> bool {
        self.good_standing()
            && (rent as u128) * 100 <= (self.typical_rent() as u128) * (RENT_HEADROOM_PCT as u128)
    }
}

#[event]
pub struct RentPaid {
    pub lease: Pubkey,
    pub period: u16,
    pub on_time: bool,
    // the amount moved in a Token-2022 confidential transfer, so it is not public
    pub confidential: bool,
}

#[event]
pub struct Attested {
    pub wallet: Pubkey,
    pub level: u8,
    pub expires_at: i64,
}

#[event]
pub struct AttestationRevoked {
    pub wallet: Pubkey,
}

#[event]
pub struct LeaseDefaulted {
    pub lease: Pubkey,
    pub seized: u64,
}

#[event]
pub struct LeaseClosed {
    pub lease: Pubkey,
    pub deduction: u64,
}
