use anchor_lang::prelude::*;

#[constant]
pub const LEASE_SEED: &[u8] = b"lease";

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

#[constant]
pub const PROFILE_SEED: &[u8] = b"profile";

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
