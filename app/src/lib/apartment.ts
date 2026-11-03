// Which apartment a lease is for.
//
// The `Lease` account does not reference its `Listing`: `propose_lease` copies the rent, the
// deposit and the region out of the listing and names no listing account at all
// (docs/contracts/program-interface.md). That is deliberate — a lease outlives the advertisement,
// and `close_listing` must not be able to strand one — but it means the chain cannot answer "what
// is this apartment called", which is the first thing either party wants to read on a lease.
//
// So the name is recovered by matching, and only when the match is unambiguous. Showing the wrong
// apartment on a lease card is worse than showing none, so anything short of exactly one candidate
// falls back to a label built from the lease alone.
//
// What that does and does not guarantee. The candidates are the listings that exist NOW, and
// `close_listing` removes one for good, so the match is only as complete as the landlord's current
// advertisements:
//
//  - Ruled out soundly: a listing created after the lease was proposed cannot be its source, so it
//    never counts (ids are creation timestamps, `chain.newId`). That is why re-listing a flat
//    afterwards does not move an old lease onto the new advert.
//  - NOT ruled out, and not knowable from the chain: a landlord with two listings that agree on
//    region, rent and deposit, who closes the one a lease was proposed on, leaves a single
//    survivor that the lease will be labelled with. Both were visible when the lease was proposed
//    (so it showed the generic label until then); after the close it names the sibling. Nothing on
//    the lease distinguishes them. Fixing it needs a `listing` field on `Lease`, a breaking account
//    change we are not making for a demo (docs/contracts/program-interface.md).
//
// So: unambiguous among the listings that still exist, never ambiguous-resolved, and wrong only in
// that one case. The seeded demo data cannot reach it (every rent differs).
//
// Free of React and of web3.js: pure functions over the two views.
import type { LeaseView, ListingView } from "./chain";

/**
 * The deposit `propose_lease` writes for this listing at this discount.
 *
 * Mirrors the program's `(standard * (100 - pct)) / 100` in u128, so the floor is the same one the
 * chain took — a half-unit difference here would turn a good match into no match.
 */
export const depositFor = (standard: number, discountPct: number): number =>
  discountPct ? Math.floor((standard * (100 - discountPct)) / 100) : standard;

/** Listing and lease ids are both `Date.now()` at creation, so a listing newer than the lease is not its source. */
const createdAfter = (listing: ListingView, lease: LeaseView): boolean => {
  const [a, b] = [Number(listing.id), Number(lease.id)];
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
};

/**
 * The listing a lease was proposed on, or null when it cannot be told apart.
 *
 * Three fields are copied verbatim from the listing (rent, region) or derived from it by a rule we
 * can replay (deposit), so together they identify it among that landlord's listings. Null means
 * either that the listing has since been removed, or that the landlord has two listings this lease
 * could equally have come from.
 */
export function leaseListing(lease: LeaseView, listings: ListingView[] | undefined): ListingView | null {
  const candidates = (listings ?? []).filter(
    (l) =>
      l.landlord === lease.landlord &&
      !createdAfter(l, lease) &&
      l.region === lease.region &&
      l.rent === lease.rent &&
      depositFor(l.deposit, lease.discountPct) === lease.deposit,
  );
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * What to call the apartment, for a header or a list row. Never empty: without a listing to read
 * the title from, the region still says where the place is, which beats a blank where a name
 * belongs.
 */
export function apartmentName(lease: LeaseView, listings: ListingView[] | undefined): string {
  const listing = leaseListing(lease, listings);
  if (listing?.title.trim()) return listing.title.trim();
  return lease.region ? `Apartment in ${lease.region}` : "This apartment";
}

/** Where it is: "Kazimierz, Kraków · PL" from the listing, or just the region without one. */
export function apartmentWhere(lease: LeaseView, listings: ListingView[] | undefined): string {
  const listing = leaseListing(lease, listings);
  return [listing?.city, lease.region].filter((s) => s && s.trim()).join(" · ");
}
