import type { LeaseView, ListingView } from "../chain";

export const listing = (over: Partial<ListingView> = {}): ListingView => ({
  address: "listing-addr",
  id: "1",
  landlord: "landlord-1",
  rent: 1_000_000,
  deposit: 2_000_000,
  region: "PL",
  title: "Sunlit 1-bedroom, Kazimierz",
  city: "Kraków",
  blurb: "",
  photo: "",
  ...over,
});

export const lease = (over: Partial<LeaseView> = {}): LeaseView => ({
  address: "lease-addr",
  id: "1",
  landlord: "landlord-1",
  tenant: "tenant-1",
  mint: "mint-1",
  rent: 1_000_000,
  deposit: 2_000_000,
  startTs: 0,
  termPeriods: 3,
  paidCount: 0,
  periodSecs: 45,
  graceSecs: 20,
  hashHex: "",
  region: "PL",
  discountPct: 0,
  status: "active",
  proposedDeduction: 0,
  disputedAt: 0,
  claimPauseSecs: 0,
  disputeRounds: 0,
  ...over,
});
