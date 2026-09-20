use anchor_lang::prelude::*;

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
}

#[event]
pub struct RentPaid {
    pub lease: Pubkey,
    pub period: u16,
    pub on_time: bool,
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
