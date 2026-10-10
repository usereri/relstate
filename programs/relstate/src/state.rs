use anchor_lang::prelude::*;

use crate::constants::{
    BPS_FULL, CLAIM_WINDOW_SECS, DISPUTE_WINDOW_SECS, KYC_LEVEL_BASIC, MAX_ALLOWED_MINTS,
    MAX_BLURB, MAX_CITY, MAX_PHOTO, MAX_TITLE, RENT_HEADROOM_PCT,
};
use crate::error::ErrorCode;

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
    /// The landlord asked for a deduction and the tenant has not answered yet. No money has moved
    /// and the `claim_deposit` clock is paused; see `settle_dispute.rs` for the ways out.
    Disputed,
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
    /// The deduction the landlord asked for when the lease entered `Disputed`. It is a proposal,
    /// not a decision: no money moves until it is accepted, finalized or settled. Zeroed on every
    /// exit from `Disputed`.
    pub proposed_deduction: u64,
    /// When the dispute opened; 0 when the lease is not disputed. `DISPUTE_WINDOW_SECS` runs from
    /// here.
    pub disputed_at: i64,
    /// Total seconds this lease has spent inside a dispute, added to the claim deadline. This is
    /// what makes a rejected dispute *resume* the `claim_deposit` clock instead of restarting it,
    /// and it is why a landlord cannot shorten the tenant's claim by opening one.
    pub claim_pause_secs: i64,
    /// The tenant rejected a proposed deduction. It voids that proposal and bars another one:
    /// without it a landlord could re-dispute every time the claim came due and keep the deposit
    /// out of reach forever. `release_deposit(0)` still works, so a full return is always open.
    pub dispute_rejected: bool,
}

impl Lease {
    /// End of the paid term: the first instant `release_deposit` is allowed.
    ///
    /// Saturating, so a nonsense `period_secs` on a lease nobody would accept cannot panic the
    /// instructions that read the clock.
    pub fn end_ts(&self) -> i64 {
        self.start_ts
            .saturating_add((self.term_periods as i64).saturating_mul(self.period_secs))
    }

    /// First instant the tenant may take the whole deposit, pushed back by whatever time the
    /// lease spent in a dispute.
    pub fn claim_deadline(&self) -> i64 {
        self.end_ts()
            .saturating_add(CLAIM_WINDOW_SECS)
            .saturating_add(self.claim_pause_secs)
    }

    /// First instant the landlord may finalize a proposed deduction the tenant never answered.
    pub fn dispute_deadline(&self) -> i64 {
        self.disputed_at.saturating_add(DISPUTE_WINDOW_SECS)
    }
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
    /// How much of the most recent closed deposit went back to the tenant, in basis points
    /// (`BPS_FULL` = all of it). 0 also reads as "no deposit outcome yet", which `deposit_events`
    /// tells apart.
    pub last_deposit_return_bps: u16,
    /// How many leases reached a deposit outcome — release, settlement, claim or default. The
    /// denominator behind "returns X% of deposits over N leases", and the confidence in the rate:
    /// one lease at 100% says much less than twenty.
    pub deposit_events: u32,
}

/// Share of a deposit that went back to the tenant, in basis points.
///
/// A zero deposit counts as a full return: nothing was withheld, and the alternative is dividing
/// by zero. `deduction > deposit` is a caller bug, so it is an error rather than a clamp.
pub fn return_bps(deposit: u64, deduction: u64) -> Result<u16> {
    let returned = deposit
        .checked_sub(deduction)
        .ok_or_else(|| error!(ErrorCode::DeductionTooLarge))?;
    if deposit == 0 {
        return Ok(BPS_FULL);
    }
    // u128 because returned * 10000 overflows u64 for a deposit above ~1.8e15 base units, which a
    // 6-decimal mint reaches at 1.8 billion tokens.
    Ok(((returned as u128 * BPS_FULL as u128) / deposit as u128) as u16)
}

impl Profile {
    /// Records one lease's deposit outcome: the lifetime totals the aggregate return rate is
    /// computed from, the most recent rate, and the event count behind both.
    ///
    /// Deliberately does **not** touch `deposits_returned_full`: a deposit the tenant had to take
    /// with `claim_deposit` came back in full without the landlord ever choosing to return it, so
    /// only the instructions where a party actually acted credit that counter.
    pub fn record_deposit_outcome(&mut self, deposit: u64, deduction: u64) -> Result<()> {
        self.last_deposit_return_bps = return_bps(deposit, deduction)?;
        self.deposit_total = self
            .deposit_total
            .checked_add(deposit)
            .ok_or_else(|| error!(ErrorCode::MathOverflow))?;
        self.deducted_total = self
            .deducted_total
            .checked_add(deduction)
            .ok_or_else(|| error!(ErrorCode::MathOverflow))?;
        self.deposit_events = self.deposit_events.saturating_add(1);
        Ok(())
    }

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

/// The landlord proposed a deduction and the lease is waiting on the tenant. No money moved.
#[event]
pub struct DepositDisputed {
    pub lease: Pubkey,
    pub proposed_deduction: u64,
    /// When the tenant's window to answer runs out.
    pub answer_by: i64,
}

/// The tenant rejected the proposal. The deposit now returns in full, through `claim_deposit`
/// once the resumed clock runs out, or sooner if the landlord releases it.
#[event]
pub struct DepositDisputeRejected {
    pub lease: Pubkey,
    pub claim_deadline: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The backend sizes the SOL it grants a new wallet from these (backend/src/treasury.ts,
    /// `APPLICATION_ACCOUNT_SIZE` / `PROFILE_ACCOUNT_SIZE`). A layout change must fail here, not
    /// as a tenant whose first `fund_deposit` runs out of rent.
    #[test]
    fn account_sizes_the_backend_rent_dust_depends_on() {
        assert_eq!(8 + Application::INIT_SPACE, 104);
        assert_eq!(8 + Profile::INIT_SPACE, 94);
        assert_eq!(8 + Lease::INIT_SPACE, 218);
    }

    #[test]
    fn return_bps_covers_full_partial_and_total_deduction() {
        assert_eq!(return_bps(2_000, 0).unwrap(), 10_000);
        assert_eq!(return_bps(2_000, 500).unwrap(), 7_500);
        assert_eq!(return_bps(2_000, 2_000).unwrap(), 0);
        // rounds down, never up
        assert_eq!(return_bps(3, 1).unwrap(), 6_666);
    }

    #[test]
    fn return_bps_of_a_zero_deposit_is_full_and_not_a_division_by_zero() {
        assert_eq!(return_bps(0, 0).unwrap(), 10_000);
        assert!(return_bps(0, 1).is_err());
    }

    #[test]
    fn return_bps_refuses_a_deduction_above_the_deposit() {
        assert!(return_bps(100, 101).is_err());
    }

    #[test]
    fn return_bps_does_not_overflow_on_a_huge_deposit() {
        assert_eq!(return_bps(u64::MAX, 0).unwrap(), 10_000);
        assert_eq!(return_bps(u64::MAX, u64::MAX / 2).unwrap(), 5_000);
    }

    fn profile() -> Profile {
        Profile {
            wallet: Pubkey::new_unique(),
            leases_completed: 0,
            paid_on_time: 0,
            paid_late: 0,
            deposits_returned_full: 0,
            deposit_total: 0,
            deducted_total: 0,
            defaults: 0,
            deposits_claimed: 0,
            rent_paid_total: 0,
            last_deposit_return_bps: 0,
            deposit_events: 0,
        }
    }

    #[test]
    fn record_deposit_outcome_accumulates_and_keeps_the_latest_rate() {
        let mut p = profile();
        p.record_deposit_outcome(2_000, 500).unwrap();
        p.record_deposit_outcome(1_000, 0).unwrap();
        assert_eq!(
            (p.deposit_total, p.deducted_total, p.deposit_events, p.last_deposit_return_bps),
            (3_000, 500, 2, 10_000)
        );
        // never counts as a voluntary full return
        assert_eq!(p.deposits_returned_full, 0);
    }

    #[test]
    fn record_deposit_outcome_overflow_is_an_error_not_a_wrap() {
        let mut p = profile();
        p.deposit_total = u64::MAX;
        assert!(p.record_deposit_outcome(1, 0).is_err());
    }

    #[test]
    fn claim_deadline_moves_with_time_spent_disputed() {
        let mut l = Lease {
            landlord: Pubkey::new_unique(),
            tenant: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            lease_id: 1,
            rent_amount: 1,
            deposit_amount: 1,
            start_ts: 1_000,
            term_periods: 3,
            paid_count: 3,
            lease_hash: [0; 32],
            status: Status::Active,
            bump: 255,
            period_secs: 100,
            grace_secs: 0,
            region: *b"PL",
            discount_pct: 0,
            proposed_deduction: 0,
            disputed_at: 0,
            claim_pause_secs: 0,
            dispute_rejected: false,
        };
        assert_eq!(l.end_ts(), 1_300);
        let base = l.claim_deadline();
        assert_eq!(base, 1_300 + CLAIM_WINDOW_SECS);
        l.claim_pause_secs = 25;
        assert_eq!(l.claim_deadline(), base + 25);
        l.disputed_at = 5_000;
        assert_eq!(l.dispute_deadline(), 5_000 + DISPUTE_WINDOW_SECS);
    }
}
