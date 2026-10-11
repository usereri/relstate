use anchor_lang::prelude::*;

#[constant]
pub const LEASE_SEED: &[u8] = b"lease";

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

#[constant]
pub const LISTING_SEED: &[u8] = b"listing";

#[constant]
pub const APPLICATION_SEED: &[u8] = b"application";

#[constant]
pub const PROFILE_SEED: &[u8] = b"profile";

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

#[constant]
pub const ATTESTATION_SEED: &[u8] = b"attestation";

// KYC levels on an Attestation. 0 is "none" and is never stored: an unverified wallet has no
// account at all, so `attest` refuses level 0 rather than writing a useless record.
#[constant]
pub const KYC_LEVEL_BASIC: u8 = 1;

#[constant]
pub const KYC_LEVEL_ENHANCED: u8 = 2;

#[constant]
pub const GOOD_STANDING_DISCOUNT_PCT: u8 = 50;

// Denominator of every deposit-return rate on a Profile: 10000 bps means the tenant got all of
// the deposit back.
#[constant]
pub const BPS_FULL: u16 = 10_000;

// listing text limits, in bytes (the app mirrors them as MAX_TEXT in lib/config.ts)
pub const MAX_TITLE: usize = 60;
pub const MAX_CITY: usize = 40;
pub const MAX_BLURB: usize = 120;
pub const MAX_PHOTO: usize = 120;

// The discount only applies to a lease whose rent is at most this share of the tenant's typical
// rent (see Profile::typical_rent), so tiny leases cannot buy a discount on big ones
#[constant]
pub const RENT_HEADROOM_PCT: u16 = 150;

// Only a mint the admin has allowed (see Config) can back a lease, so a worthless token cannot
// pay for a Profile. The list lives on chain because the demo needs both the classic test-USDC
// mint and a Token-2022 rUSDC mint, and the latter is created per deployment.
pub const MAX_ALLOWED_MINTS: usize = 8;

// demo allows 1 sec leases, on mainnet minimum 28 days
pub const MIN_PERIOD_SECS: i64 = if cfg!(feature = "demo") {
    1
} else {
    28 * 24 * 60 * 60
};

// 14 days for releasing deposit by landlord before tenant may claim it. Shortened in the demo.
//
// These two are `#[constant]` so they land in the IDL and the app and tests read the value of the
// build they run against instead of mirroring it. The release value is spelled as a literal
// (14 * 24 * 60 * 60) because the IDL stores the expression's text, which the client must parse
// as a number.
#[cfg(feature = "demo")]
#[constant]
pub const CLAIM_WINDOW_SECS: i64 = 3;
#[cfg(not(feature = "demo"))]
#[constant]
pub const CLAIM_WINDOW_SECS: i64 = 1_209_600;

// How long the tenant has to answer a proposed deduction (accept it or reject it) before the
// landlord may finalize it unanswered. Same 14 days as CLAIM_WINDOW_SECS in a real deployment,
// and short enough in the demo build to be shown on stage without waiting.
#[cfg(feature = "demo")]
#[constant]
pub const DISPUTE_WINDOW_SECS: i64 = 5;
#[cfg(not(feature = "demo"))]
#[constant]
pub const DISPUTE_WINDOW_SECS: i64 = 1_209_600;

// Upper bound on term_periods * period_secs. Nothing else bounds a lease from above, and a term
// near i64::MAX would leave a funded deposit unreachable forever (release is "not ended", claim is
// "too early"). Five years in a real deployment; the demo build is generous so local clock jumps
// never trip it.
#[cfg(feature = "demo")]
pub const MAX_LEASE_SECS: i64 = 100 * 365 * 24 * 60 * 60;
#[cfg(not(feature = "demo"))]
pub const MAX_LEASE_SECS: i64 = 5 * 365 * 24 * 60 * 60;
