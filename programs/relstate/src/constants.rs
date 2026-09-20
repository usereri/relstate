use anchor_lang::prelude::*;

#[constant]
pub const LEASE_SEED: &[u8] = b"lease";

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

#[constant]
pub const LISTING_SEED: &[u8] = b"listing";

#[constant]
pub const PROFILE_SEED: &[u8] = b"profile";

#[constant]
pub const GOOD_STANDING_DISCOUNT_PCT: u8 = 50;

// listing text limits, in bytes (the app mirrors them as MAX_TEXT in lib/config.ts)
pub const MAX_TITLE: usize = 60;
pub const MAX_CITY: usize = 40;
pub const MAX_BLURB: usize = 120;
pub const MAX_PHOTO: usize = 120;

// The discount only applies to a lease whose rent is at most this share of the tenant's typical
// rent (see Profile::typical_rent), so tiny leases cannot buy a discount on big ones
#[constant]
pub const RENT_HEADROOM_PCT: u16 = 150;

// For demo only devnet's USDC can back a lease, so a worthless token can't pay a Profile
pub const ALLOWED_MINT: Pubkey = pubkey!("CpzHPiiCaJ6LUTcSXgcptmjr8fyto3GAxH48b1FJbYDQ");

// demo allows 1 sec leases, on mainnet minimum 28 days
pub const MIN_PERIOD_SECS: i64 = if cfg!(feature = "demo") {
    1
} else {
    28 * 24 * 60 * 60
};

// 14 days for releasing deposit by landlord before tenant may claim it. Shortened in the demo
pub const CLAIM_WINDOW_SECS: i64 = if cfg!(feature = "demo") {
    10
} else {
    14 * 24 * 60 * 60
};
