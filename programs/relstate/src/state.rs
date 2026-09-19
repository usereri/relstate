use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Lease {
    pub landlord: Pubkey,
    pub tenant: Pubkey,
    pub mint: Pubkey,
    pub lease_id: u64,
    pub rent_amount: u64,
    pub deposit_amount: u64,
    pub start_ts: u64,
    pub term_periods: u16,
    pub paid_count: u16,
    pub lease_hash: [u8; 32],
    pub status: Status,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Profile {
    pub wallet: Pubkey,
    pub leases_completed: u32,
    pub paid_on_time: u32,
    pub paid_late: u32,
    pub deposits_returned_full: u32,
    pub deposits_withheld: u32,
}

#[event]
pub struct RentPaid {
    pub lease: Pubkey,
    pub period: u16,
    pub on_time: bool,
}

#[event]
pub struct LeaseClosed {
    pub lease: Pubkey,
    pub deduction: u64,
}
