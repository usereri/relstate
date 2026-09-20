use anchor_lang::prelude::*;

use crate::constants::{MAX_BLURB, MAX_CITY, MAX_PHOTO, MAX_TITLE, RENT_HEADROOM_PCT};

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

// An apartment a landlord offers. Independent of leases: the lease it leads to is proposed separately.
#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub landlord: Pubkey,
    pub listing_id: u64,
    pub rent_amount: u64,
    // the standard deposit, before any good-standing discount
    pub deposit_amount: u64,
    pub region: [u8; 2],
    pub bump: u8,
    #[max_len(MAX_TITLE)]
    pub title: String,
    #[max_len(MAX_CITY)]
    pub city: String,
    #[max_len(MAX_BLURB)]
    pub blurb: String,
    // image URL, or a path served by the app such as /listings/flat.jpg
    #[max_len(MAX_PHOTO)]
    pub photo: String,
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
