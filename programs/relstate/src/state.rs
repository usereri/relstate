use anchor_lang::prelude::*;

use crate::constants::{
    APPRAISER_FEE_CAP_DIVISOR, BPS_FULL, CLAIM_WINDOW_SECS, DISPUTE_WINDOW_SECS, KYC_LEVEL_BASIC,
    MAX_ALLOWED_MINTS, MAX_BLURB, MAX_CANDIDATES, MAX_CITY, MAX_DISPUTE_ROUNDS, MAX_PHOTO,
    MAX_TITLE, RENT_HEADROOM_PCT, SELECTION_WINDOW_SECS, VERDICT_WINDOW_SECS,
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Status {
    Proposed,
    Active,
    Closed,
    Defaulted,
    /// The landlord asked for a deduction and the tenant has not answered yet. No money has moved
    /// and the `claim_deposit` clock is paused; see `settle_dispute.rs` for the ways out.
    Disputed,
    /// The tenant used up the last dispute round, so the number is no longer either party's to
    /// pick: an appraiser the two of them select decides it. The deposit stays in the vault and the
    /// claim clock stays paused. See `mediation.rs` and docs/contracts/dispute-mediation.md.
    ///
    /// **Appended on purpose.** The five variants above keep the discriminants already written to
    /// accounts on devnet, which is what makes this an in-place upgrade rather than a fresh deploy.
    Mediation,
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
    /// When the current dispute **or** mediation started; 0 when the lease is neither.
    /// `DISPUTE_WINDOW_SECS` runs from here while `Disputed`, and `escalate_to_mediation` re-stamps
    /// it so the same field times the `Mediation` stretch. Deliberately the only copy of that
    /// timestamp: `Dispute` does not repeat it, because the claim-pause arithmetic below must have
    /// exactly one source of truth.
    pub disputed_at: i64,
    /// Total seconds this lease has spent inside a dispute, added to the claim deadline. This is
    /// what makes a rejected dispute *resume* the `claim_deposit` clock instead of restarting it,
    /// and it is why a landlord cannot shorten the tenant's claim by opening one.
    pub claim_pause_secs: i64,
    /// How many proposed deductions the tenant has rejected, capped at `MAX_DISPUTE_ROUNDS`. Each
    /// rejection voids that proposal; the landlord may propose again while rounds are left, and
    /// the last rejection escalates to `Status::Mediation` instead. At the cap `release_deposit`
    /// refuses any deduction, which is what stops a landlord re-disputing every time the resumed
    /// claim clock comes due and keeping the deposit out of reach forever. `release_deposit(0)`
    /// works throughout, so a full return is always open.
    ///
    /// **This byte was `dispute_rejected: bool`** in the deployed program, at the same offset
    /// (217) and with the same encoding for 0 and 1, so an existing lease upgrades in place and
    /// reads as 0 or 1 rounds. The upgrade is one-way: a lease that reaches 2 stores `0x02`, which
    /// the old program would reject as an invalid bool. docs/contracts/dispute-mediation.md §8.
    pub dispute_rounds: u8,
}

impl Lease {
    /// End of the paid term: the first instant `release_deposit` is allowed.
    ///
    /// `propose_lease` bounds `term_periods * period_secs` by `MAX_LEASE_SECS`, so for any lease
    /// that exists this cannot overflow. It still saturates rather than panics, so a corrupt
    /// account could never abort an instruction that merely reads the clock.
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

    /// Whether the landlord may still *propose* a deduction. `release_deposit(0)` ignores this —
    /// nobody disputes getting everything back.
    pub fn may_propose_deduction(&self) -> bool {
        self.dispute_rounds < MAX_DISPUTE_ROUNDS
    }

    /// Adds the seconds since `disputed_at` to the paused claim clock and clears the stamp.
    ///
    /// Called on the transition that *ends* a stretch of unavailability — `abandon_dispute` and
    /// `escalate_to_mediation` end the `Disputed` stretch, `expire_mediation` ends the `Mediation`
    /// one — so every stretch is counted exactly once and the tenant waits precisely as long as
    /// they would have if nothing had ever been disputed. Saturating, and a stamp in the future
    /// (an impossible clock) adds nothing rather than subtracting.
    ///
    /// A cleared stamp is a no-op, not `now - 0`. No caller can reach it — every one of them has
    /// already required a status that implies a live stamp — but without the guard a second call
    /// would add the entire Unix epoch to the claim deadline and put the deposit out of reach for
    /// 56 years, which is too large a consequence to leave resting on a status check elsewhere.
    pub fn resume_claim_clock(&mut self, now: i64) {
        if self.disputed_at == 0 {
            return;
        }
        let paused = now.saturating_sub(self.disputed_at).max(0);
        self.claim_pause_secs = self.claim_pause_secs.saturating_add(paused);
        self.disputed_at = 0;
    }
}

/// One appraisal company in the registry, at seeds `[APPRAISER_SEED, wallet]`. Only the Config
/// admin writes these.
///
/// The registry is the whole reason a landlord cannot nominate their own sockpuppet: a key with no
/// account here, or whose account is not `active`, cannot be proposed, picked or bound, because
/// every one of those instructions takes this account and Anchor's seed check proves which key it
/// belongs to.
#[account]
#[derive(InitSpace)]
pub struct Appraiser {
    /// The key that signs verdicts, and the account's own seed.
    pub wallet: Pubkey,
    /// Suspended entries keep their record but cannot be proposed, picked, bound or submit. The
    /// admin suspending an appraiser mid-dispute does not strand the deposit: `expire_mediation`
    /// and `settle_dispute` are still open.
    pub active: bool,
    /// Eligible for `bind_default_appraiser`, the deadlock fallback. The program cannot enforce
    /// that only one entry carries this — there is no on-chain index to iterate — so keeping it
    /// unique is the admin's job. Every flagged entry is still admin-chosen and active, so the
    /// worst case is an unexpected but legitimate appraiser.
    pub is_default: bool,
    /// Base units of the lease mint, capped per lease at `deposit / APPRAISER_FEE_CAP_DIVISOR`.
    /// Mint-agnostic base units against a per-lease mint is a known wart
    /// (docs/contracts/dispute-mediation.md §3); the cap bounds it either way.
    pub fee: u64,
    /// `sha256(company name)`. Keeps strings and the directory off chain while still committing to
    /// a name anyone can verify against `/api/appraisers`. Nothing on chain reads it.
    pub name_hash: [u8; 32],
    pub bump: u8,
}

/// Everything mediation-specific, at seeds `[DISPUTE_SEED, lease]`. Created by
/// `escalate_to_mediation` and closed on every exit, with the rent going back to the tenant who
/// paid for it, so it exists exactly while the lease is in `Mediation`.
///
/// `Lease` gains nothing for mediation: the audited, money-bearing account keeps its 218-byte
/// layout and the new surface is all here.
#[account]
#[derive(InitSpace)]
pub struct Dispute {
    /// Redundant with the seeds; kept so every instruction can assert `has_one = lease`.
    pub lease: Pubkey,
    /// Only `[..landlord_count]` is meaningful; the rest is zero padding.
    pub landlord_candidates: [Pubkey; MAX_CANDIDATES],
    pub tenant_candidates: [Pubkey; MAX_CANDIDATES],
    pub landlord_count: u8,
    pub tenant_count: u8,
    /// All-zero until that side picks. A side may change its pick while nothing is bound.
    pub landlord_pick: Pubkey,
    pub tenant_pick: Pubkey,
    /// The bound appraiser, all-zero until both picks match or the default is bound. Cannot
    /// collide with "unset": `register_appraiser` refuses the all-zero key.
    pub appraiser: Pubkey,
    /// After this, anyone may `bind_default_appraiser`. Proposing and picking stay open past it,
    /// so the two sides can still converge on their own until something is actually bound.
    pub selection_deadline: i64,
    /// After this, either party may `expire_mediation`. Set provisionally at escalation so a
    /// mediation nobody takes part in still expires, then re-based on the binding, because that is
    /// the moment the appraiser acquires the obligation.
    pub verdict_deadline: i64,
    pub bump: u8,
}

impl Dispute {
    pub fn is_bound(&self) -> bool {
        self.appraiser != Pubkey::default()
    }

    /// Whether `key` was nominated by either side. Picking from the *other* side's list is how the
    /// two converge, so the union — not the signer's own list — is what a pick is checked against.
    pub fn was_proposed(&self, key: &Pubkey) -> bool {
        self.landlord_candidates[..self.landlord_count as usize].contains(key)
            || self.tenant_candidates[..self.tenant_count as usize].contains(key)
    }

    /// Both sides named the same appraiser. Guards against the all-zero "has not picked" value
    /// counting as agreement.
    pub fn picks_agree(&self) -> bool {
        self.landlord_pick != Pubkey::default() && self.landlord_pick == self.tenant_pick
    }

    /// Opens the selection phase. The verdict deadline is provisional: binding re-bases it.
    pub fn open(&mut self, lease: Pubkey, now: i64, bump: u8) {
        self.lease = lease;
        self.landlord_candidates = [Pubkey::default(); MAX_CANDIDATES];
        self.tenant_candidates = [Pubkey::default(); MAX_CANDIDATES];
        self.landlord_count = 0;
        self.tenant_count = 0;
        self.landlord_pick = Pubkey::default();
        self.tenant_pick = Pubkey::default();
        self.appraiser = Pubkey::default();
        self.selection_deadline = now.saturating_add(SELECTION_WINDOW_SECS);
        self.verdict_deadline = self.selection_deadline.saturating_add(VERDICT_WINDOW_SECS);
        self.bump = bump;
    }

    /// Binds `appraiser` and gives them the full verdict window from this instant.
    pub fn bind(&mut self, appraiser: Pubkey, now: i64) {
        self.appraiser = appraiser;
        self.verdict_deadline = now.saturating_add(VERDICT_WINDOW_SECS);
    }
}

/// How a verdict splits the deposit three ways.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerdictSplit {
    pub to_tenant: u64,
    pub to_landlord: u64,
    pub to_appraiser: u64,
}

/// The most the appraiser can be paid out of a deposit of this size, whatever their registry entry
/// says. Integer division, so a deposit below the divisor caps the fee at zero.
pub fn appraiser_fee_cap(deposit: u64) -> u64 {
    deposit / APPRAISER_FEE_CAP_DIVISOR
}

/// "Loser pays", out of the deposit and nothing else — the reason D2 needs no second escrow and no
/// stake posted before the appraisal starts.
///
/// The landlord "won" when the verdict awards them more than half the deposit, and then the fee
/// comes out of the tenant's refund; otherwise it comes out of the landlord's share, and only what
/// that share cannot cover falls back on the tenant. The three shares always add up to exactly the
/// deposit, so the vault drains to zero on every verdict.
///
/// **The wart to disclose rather than hide:** at `deduction == 0` the tenant has won completely and
/// still pays the whole fee, because the landlord's share is zero and the fee can only be taken
/// from the deposit. Only a dual fee escrow fixes that, and that is a second custody path
/// (docs/contracts/dispute-mediation.md §6).
pub fn verdict_split(deposit: u64, deduction: u64, registry_fee: u64) -> Result<VerdictSplit> {
    let refund = deposit
        .checked_sub(deduction)
        .ok_or_else(|| error!(ErrorCode::DeductionTooLarge))?;
    let fee = registry_fee.min(appraiser_fee_cap(deposit));

    // u128 so a deposit above i64::MAX cannot wrap the comparison into the wrong branch.
    let landlord_won = (deduction as u128) * 2 > deposit as u128;

    let split = if landlord_won {
        // Clamped to the refund: a fee larger than what is left over must not eat into the
        // landlord's award, which the appraiser has just decided they are owed.
        let paid = fee.min(refund);
        VerdictSplit {
            to_tenant: refund - paid,
            to_landlord: deduction,
            to_appraiser: paid,
        }
    } else {
        let from_landlord = fee.min(deduction);
        let from_tenant = fee - from_landlord;
        VerdictSplit {
            // Cannot underflow: `2*deduction <= deposit` gives `refund >= deduction`, and
            // `from_tenant` is at most `fee - deduction` with `fee <= deposit / 10`. Checked
            // anyway, because this function decides where real money goes.
            to_tenant: refund
                .checked_sub(from_tenant)
                .ok_or_else(|| error!(ErrorCode::MathOverflow))?,
            to_landlord: deduction - from_landlord,
            to_appraiser: fee,
        }
    };

    // The invariant the whole instruction rests on, re-derived rather than trusted: whatever the
    // branches above did, the vault must end empty and nothing may be conjured.
    require!(
        split
            .to_tenant
            .checked_add(split.to_landlord)
            .and_then(|s| s.checked_add(split.to_appraiser))
            == Some(deposit),
        ErrorCode::MathOverflow
    );
    Ok(split)
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
    /// These counters are cosmetic and the deposit is real, so this must never be the reason a
    /// payout fails: every addition saturates, and the only error left is `deduction > deposit`,
    /// which every caller has already ruled out. A lease with no deposit has no outcome to record
    /// (it is also refused at `propose_lease`), so it is a no-op rather than a free "full return".
    ///
    /// Deliberately does **not** touch `deposits_returned_full`: a deposit the tenant had to take
    /// with `claim_deposit` came back in full without the landlord ever choosing to return it, so
    /// only the instructions where a party actually acted credit that counter.
    pub fn record_deposit_outcome(&mut self, deposit: u64, deduction: u64) -> Result<()> {
        if deposit == 0 {
            return Ok(());
        }
        self.last_deposit_return_bps = return_bps(deposit, deduction)?;
        self.deposit_total = self.deposit_total.saturating_add(deposit);
        self.deducted_total = self.deducted_total.saturating_add(deduction);
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
    /// How many rejections this lease has now had. At `MAX_DISPUTE_ROUNDS` the landlord can no
    /// longer propose a deduction, which is why this is on the event the app listens to.
    pub dispute_rounds: u8,
}

/// The tenant used the last dispute round: the number is now an appraiser's to decide.
#[event]
pub struct MediationOpened {
    pub lease: Pubkey,
    pub dispute: Pubkey,
    pub selection_deadline: i64,
    /// Provisional — binding an appraiser re-bases it on the binding.
    pub verdict_deadline: i64,
}

/// One side nominated its candidates. The keys are on the `Dispute` account; the event carries
/// only who acted and how many, so the app knows to refetch.
#[event]
pub struct AppraisersProposed {
    pub lease: Pubkey,
    pub party: Pubkey,
    pub count: u8,
}

#[event]
pub struct AppraiserPicked {
    pub lease: Pubkey,
    pub party: Pubkey,
    pub pick: Pubkey,
}

/// An appraiser is bound and the verdict window has started.
#[event]
pub struct AppraiserBound {
    pub lease: Pubkey,
    pub appraiser: Pubkey,
    /// True when the selection window ran out and the registry default was bound instead of the
    /// two sides agreeing.
    pub by_default: bool,
    pub verdict_deadline: i64,
}

/// The appraiser decided. `LeaseClosed` is emitted alongside it by the shared payout path.
#[event]
pub struct MediationVerdict {
    pub lease: Pubkey,
    pub appraiser: Pubkey,
    pub deduction: u64,
    pub fee_paid: u64,
}

/// Nobody submitted a verdict in time. The lease is `Active` again and the deposit comes back to
/// the tenant through the resumed claim clock.
#[event]
pub struct MediationExpired {
    pub lease: Pubkey,
    pub claim_deadline: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Layout change-detector. These sizes have no migration (docs/contracts/program-interface.md
    /// §5: a layout change needs a fresh deploy), and the backend's rent-dust sizing for a new
    /// wallet's Application and Profile has to follow them. Changing a struct must fail here,
    /// loudly, rather than as an upgrade that bricks existing accounts.
    #[test]
    fn account_sizes_the_backend_rent_dust_depends_on() {
        assert_eq!(8 + Application::INIT_SPACE, 104);
        assert_eq!(8 + Profile::INIT_SPACE, 94);
        // D2 invariant 6: `dispute_rejected: bool` became `dispute_rounds: u8` at the same offset,
        // so this must NOT have moved. A change here means the devnet upgrade is no longer in
        // place and every existing lease would stop deserialising.
        assert_eq!(8 + Lease::INIT_SPACE, 218);
        assert_eq!(8 + Appraiser::INIT_SPACE, 83);
        assert_eq!(8 + Dispute::INIT_SPACE, 347);
    }

    /// D2 invariant 6, the half a layout test cannot show: that the *bytes* the deployed program
    /// wrote still mean what the new struct says they mean.
    ///
    /// Builds a Lease the way the current program would, serialises it, patches byte 217 — where
    /// `dispute_rejected` sat and `dispute_rounds` now sits — to Borsh's `false`/`true`, and
    /// deserialises it back with the new definition.
    #[test]
    fn a_lease_written_by_the_deployed_program_upgrades_in_place() {
        const ROUNDS_OFFSET: usize = 217 - 8; // 8 = the account discriminator, absent from the struct bytes
        let original = lease();
        let mut bytes = Vec::new();
        original.serialize(&mut bytes).unwrap();
        assert_eq!(bytes.len(), Lease::INIT_SPACE);
        assert_eq!(bytes.len(), ROUNDS_OFFSET + 1, "dispute_rounds is the last byte");

        // 0x00 is how the old program encoded `dispute_rejected: false`
        bytes[ROUNDS_OFFSET] = 0;
        let fresh = Lease::deserialize(&mut bytes.as_slice()).unwrap();
        assert_eq!(fresh.dispute_rounds, 0);
        assert!(fresh.may_propose_deduction());

        // 0x01 is `dispute_rejected: true`. Under MAX_DISPUTE_ROUNDS = 2 that old lease now reads
        // as one round used and the landlord may propose once more: the new rule applied to an old
        // lease, which docs/contracts/dispute-mediation.md §8 records as intended.
        bytes[ROUNDS_OFFSET] = 1;
        let rejected_once = Lease::deserialize(&mut bytes.as_slice()).unwrap();
        assert_eq!(rejected_once.dispute_rounds, 1);
        assert_eq!(rejected_once.may_propose_deduction(), MAX_DISPUTE_ROUNDS > 1);

        // and nothing before byte 217 moved
        assert_eq!(
            (fresh.landlord, fresh.tenant, fresh.deposit_amount, fresh.status, fresh.claim_pause_secs),
            (original.landlord, original.tenant, original.deposit_amount, Status::Active, original.claim_pause_secs)
        );
    }

    /// The upgrade is one-way, and this is why: `0x02` is not a valid bool, so the old program
    /// would refuse a lease that reached the second round. Rolling back over one would strand it.
    #[test]
    fn a_lease_at_the_round_cap_cannot_be_read_as_the_old_bool() {
        assert_eq!(MAX_DISPUTE_ROUNDS, 2);
        let mut lease = lease();
        lease.dispute_rounds = MAX_DISPUTE_ROUNDS;
        let mut bytes = Vec::new();
        lease.serialize(&mut bytes).unwrap();
        assert_eq!(bytes[217 - 8], 2);
        assert!(bool::deserialize(&mut &bytes[217 - 8..]).is_err());
    }

    /// `Status::Mediation` had to be appended, or every account on devnet would read as the wrong
    /// status after the upgrade.
    #[test]
    fn status_discriminants_did_not_move() {
        for (status, want) in [
            (Status::Proposed, 0u8),
            (Status::Active, 1),
            (Status::Closed, 2),
            (Status::Defaulted, 3),
            (Status::Disputed, 4),
            (Status::Mediation, 5),
        ] {
            let mut bytes = Vec::new();
            status.serialize(&mut bytes).unwrap();
            assert_eq!(bytes, vec![want], "{status:?} moved");
        }
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

    /// F3: the cosmetic counters must never block a payout, even when saturated.
    #[test]
    fn record_deposit_outcome_saturates_instead_of_failing_near_u64_max() {
        let mut p = profile();
        p.deposit_total = u64::MAX - 1;
        p.deducted_total = u64::MAX;
        p.deposit_events = u32::MAX;
        assert!(p.record_deposit_outcome(2_000, 500).is_ok());
        assert_eq!(
            (p.deposit_total, p.deducted_total, p.deposit_events, p.last_deposit_return_bps),
            (u64::MAX, u64::MAX, u32::MAX, 7_500)
        );
    }

    /// F2 defence in depth: no deposit, no outcome, so no free "full return" event.
    #[test]
    fn a_zero_deposit_records_nothing() {
        let mut p = profile();
        p.last_deposit_return_bps = 1_234;
        p.record_deposit_outcome(0, 0).unwrap();
        assert_eq!(
            (p.deposit_events, p.deposit_total, p.last_deposit_return_bps),
            (0, 0, 1_234)
        );
    }

    fn lease() -> Lease {
        Lease {
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
            dispute_rounds: 0,
        }
    }

    #[test]
    fn claim_deadline_moves_with_time_spent_disputed() {
        let mut l = lease();
        assert_eq!(l.end_ts(), 1_300);
        let base = l.claim_deadline();
        assert_eq!(base, 1_300 + CLAIM_WINDOW_SECS);
        l.claim_pause_secs = 25;
        assert_eq!(l.claim_deadline(), base + 25);
        l.disputed_at = 5_000;
        assert_eq!(l.dispute_deadline(), 5_000 + DISPUTE_WINDOW_SECS);
    }

    /// D2 invariant 5. Two stretches of unavailability — the `Disputed` one and the `Mediation`
    /// one — each counted once, on the transition that ends it.
    #[test]
    fn each_stretch_of_unavailability_is_added_to_the_claim_clock_exactly_once() {
        let mut l = lease();

        // Disputed from t=2_000 to t=2_040
        l.disputed_at = 2_000;
        l.resume_claim_clock(2_040);
        assert_eq!((l.claim_pause_secs, l.disputed_at), (40, 0));

        // escalation re-stamps it; Mediation from t=2_040 to t=2_140
        l.disputed_at = 2_040;
        l.resume_claim_clock(2_140);
        assert_eq!((l.claim_pause_secs, l.disputed_at), (140, 0));

        // A second resume with the stamp already cleared must not count "now" as pause time; that
        // would hand the landlord an unbounded delay for free.
        l.resume_claim_clock(9_999);
        assert_eq!(l.claim_pause_secs, 140);

        // and a clock that went backwards subtracts nothing
        l.disputed_at = 5_000;
        l.resume_claim_clock(4_000);
        assert_eq!(l.claim_pause_secs, 140);
    }

    #[test]
    fn may_propose_deduction_runs_out_at_the_round_cap() {
        let mut l = lease();
        for rounds in 0..MAX_DISPUTE_ROUNDS {
            l.dispute_rounds = rounds;
            assert!(l.may_propose_deduction(), "round {rounds} should still allow a proposal");
        }
        l.dispute_rounds = MAX_DISPUTE_ROUNDS;
        assert!(!l.may_propose_deduction());
    }

    fn dispute() -> Dispute {
        let mut d = Dispute {
            lease: Pubkey::new_unique(),
            landlord_candidates: [Pubkey::default(); MAX_CANDIDATES],
            tenant_candidates: [Pubkey::default(); MAX_CANDIDATES],
            landlord_count: 0,
            tenant_count: 0,
            landlord_pick: Pubkey::default(),
            tenant_pick: Pubkey::default(),
            appraiser: Pubkey::default(),
            selection_deadline: 0,
            verdict_deadline: 0,
            bump: 0,
        };
        d.open(d.lease, 1_000, 7);
        d
    }

    #[test]
    fn open_sets_both_deadlines_so_an_untouched_mediation_still_expires() {
        let d = dispute();
        assert_eq!(d.selection_deadline, 1_000 + SELECTION_WINDOW_SECS);
        assert_eq!(
            d.verdict_deadline,
            1_000 + SELECTION_WINDOW_SECS + VERDICT_WINDOW_SECS
        );
        assert!(!d.is_bound());
        assert!(!d.picks_agree());
    }

    #[test]
    fn binding_re_bases_the_verdict_window_on_the_binding() {
        let mut d = dispute();
        let appraiser = Pubkey::new_unique();
        d.bind(appraiser, 1_005);
        assert!(d.is_bound());
        assert_eq!(d.verdict_deadline, 1_005 + VERDICT_WINDOW_SECS);
    }

    /// A pick is checked against the *union* of both lists, which is what lets the two sides
    /// converge, and padding past `*_count` must never count as a nomination.
    #[test]
    fn was_proposed_covers_the_union_and_ignores_the_padding() {
        let mut d = dispute();
        let (a, b, outsider) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        d.landlord_candidates[0] = a;
        d.landlord_count = 1;
        d.tenant_candidates[0] = b;
        d.tenant_count = 1;
        // written but not counted: a side that proposed one must not be able to smuggle a second
        d.tenant_candidates[1] = outsider;

        assert!(d.was_proposed(&a));
        assert!(d.was_proposed(&b));
        assert!(!d.was_proposed(&outsider));
        assert!(!d.was_proposed(&Pubkey::default()));
    }

    /// The all-zero "has not picked" value must never read as agreement, or an unbound dispute
    /// would bind nobody and look bound.
    #[test]
    fn two_sides_that_have_not_picked_do_not_agree() {
        let mut d = dispute();
        assert!(!d.picks_agree());

        let pick = Pubkey::new_unique();
        d.landlord_pick = pick;
        assert!(!d.picks_agree());
        d.tenant_pick = Pubkey::new_unique();
        assert!(!d.picks_agree());
        d.tenant_pick = pick;
        assert!(d.picks_agree());
    }

    // ---- the fee rule (docs/contracts/dispute-mediation.md §6)

    fn split(deposit: u64, deduction: u64, fee: u64) -> VerdictSplit {
        let s = verdict_split(deposit, deduction, fee).unwrap();
        // D2 invariant 1, asserted on every single case below: the vault drains to exactly the
        // deposit, never more and never less.
        assert_eq!(
            s.to_tenant + s.to_landlord + s.to_appraiser,
            deposit,
            "conservation broken for ({deposit}, {deduction}, {fee})"
        );
        s
    }

    #[test]
    fn the_fee_is_capped_at_a_tenth_of_the_deposit() {
        assert_eq!(appraiser_fee_cap(1_000), 100);
        // integer division: a deposit smaller than the divisor pays no fee at all
        assert_eq!(appraiser_fee_cap(9), 0);
        assert_eq!(appraiser_fee_cap(0), 0);
        // a registry entry asking for more than the cap gets the cap
        assert_eq!(split(1_000, 900, 500).to_appraiser, 100);
        assert_eq!(split(9, 9, 500).to_appraiser, 0);
    }

    #[test]
    fn a_landlord_who_won_leaves_the_fee_to_the_tenant() {
        // 2*600 > 1000, so the landlord won; fee 100 comes out of the tenant's 400
        let s = split(1_000, 600, 100);
        assert_eq!(
            (s.to_tenant, s.to_landlord, s.to_appraiser),
            (300, 600, 100)
        );
    }

    #[test]
    fn a_tenant_who_won_leaves_the_fee_to_the_landlord() {
        // 2*300 <= 1000, so the tenant won; fee 100 comes out of the landlord's 300
        let s = split(1_000, 300, 100);
        assert_eq!(
            (s.to_tenant, s.to_landlord, s.to_appraiser),
            (700, 200, 100)
        );
    }

    /// Exactly half is *not* a landlord win — the comparison is strict, so the tie goes to the
    /// tenant and the landlord's share pays the fee.
    #[test]
    fn exactly_half_the_deposit_counts_as_the_tenant_winning() {
        let s = split(1_000, 500, 100);
        assert_eq!(
            (s.to_tenant, s.to_landlord, s.to_appraiser),
            (500, 400, 100)
        );
    }

    /// The honest wart (§6): a total win for the tenant still costs them the fee, because the
    /// landlord's share is zero and the fee can only come out of the deposit. Pinned as a test so
    /// nobody "fixes" it silently and nobody is surprised by it on stage.
    #[test]
    fn a_zero_deduction_still_takes_the_fee_from_the_tenant() {
        let s = split(1_000, 0, 100);
        assert_eq!((s.to_tenant, s.to_landlord, s.to_appraiser), (900, 0, 100));
    }

    /// The whole deposit to the landlord leaves no refund to take the fee from, so the fee is
    /// reduced rather than eating into the award the appraiser just made.
    #[test]
    fn a_full_deduction_reduces_the_fee_to_what_the_refund_can_cover() {
        let s = split(1_000, 1_000, 100);
        assert_eq!((s.to_tenant, s.to_landlord, s.to_appraiser), (0, 1_000, 0));
        // 50 left over, fee capped at 100, so only 50 is payable
        let s = split(1_000, 950, 100);
        assert_eq!((s.to_tenant, s.to_landlord, s.to_appraiser), (0, 950, 50));
    }

    /// The tenant-won branch where the landlord's share cannot cover the fee: the remainder falls
    /// on the tenant, paid last, and the appraiser is still paid in full.
    #[test]
    fn a_small_award_pays_the_fee_from_both_sides() {
        // deduction 30 < fee 100 (cap 100); landlord pays 30, tenant pays the other 70
        let s = split(1_000, 30, 100);
        assert_eq!((s.to_tenant, s.to_landlord, s.to_appraiser), (900, 0, 100));
    }

    #[test]
    fn verdict_split_refuses_a_deduction_above_the_deposit() {
        assert!(verdict_split(1_000, 1_001, 0).is_err());
    }

    #[test]
    fn verdict_split_does_not_overflow_on_a_huge_deposit() {
        // 2*deduction would wrap u64 here; the comparison is done in u128
        let s = split(u64::MAX, u64::MAX / 2 + 1, 0);
        assert_eq!(s.to_landlord, u64::MAX / 2 + 1);
        let s = split(u64::MAX, u64::MAX, u64::MAX);
        assert_eq!((s.to_tenant, s.to_landlord), (0, u64::MAX));
    }

    #[test]
    fn verdict_split_conserves_across_the_whole_grid() {
        for deposit in [0u64, 1, 2, 3, 9, 10, 11, 100, 999, 1_000] {
            for deduction in 0..=deposit {
                for fee in [0u64, 1, 7, 50, 100, 1_000, u64::MAX] {
                    split(deposit, deduction, fee);
                }
            }
        }
    }
}
