import { describe, expect, it } from "vitest";
import { apartmentName, apartmentWhere, depositFor, leaseListing } from "../apartment";
import { lease, listing } from "./apartment.fixtures";

describe("depositFor", () => {
  it("no discount: the standard amount, unchanged", () => {
    expect(depositFor(2_000_000, 0)).toBe(2_000_000);
  });

  it("mirrors the program's floor division, not a rounded one", () => {
    // (101 * 50) / 100 = 50.5, and the program casts to u64 (truncates), so 50 — not 51.
    expect(depositFor(101, 50)).toBe(50);
  });
});

describe("leaseListing", () => {
  it("a listing created after the lease was proposed is never its source", () => {
    // Re-listing the flat later must not move an old lease onto the new advert.
    const l = lease({ id: "1000" });
    expect(leaseListing(l, [listing({ id: "2000" })])).toBeNull();
    expect(leaseListing(l, [listing({ id: "1000" })])?.id).toBe("1000");
    expect(leaseListing(l, [listing({ id: "900" })])?.id).toBe("900");
  });

  it("a newer sibling does not make an older, otherwise-unique listing ambiguous", () => {
    const l = lease({ id: "1000" });
    expect(leaseListing(l, [listing({ id: "900", address: "a" }), listing({ id: "5000", address: "b" })])?.address).toBe("a");
  });

  it("KNOWN LIMIT: two older identical listings, one closed, leaves the survivor", () => {
    // Documented in apartment.ts and docs/contracts/program-interface.md: nothing on the lease
    // tells A from B, so after A is closed the lease is labelled B. Pinned so a change here is a
    // decision, not an accident.
    const l = lease({ id: "1000" });
    const a = listing({ id: "100", address: "a", title: "A" });
    const b = listing({ id: "200", address: "b", title: "B" });
    expect(leaseListing(l, [a, b])).toBeNull();
    expect(leaseListing(l, [b])?.title).toBe("B");
  });

  it("matches when landlord, region, rent and discounted deposit all agree", () => {
    const l = listing({ rent: 1_000_000, deposit: 101 });
    const lse = lease({ landlord: l.landlord, region: l.region, rent: l.rent, discountPct: 50, deposit: depositFor(101, 50) });
    expect(leaseListing(lse, [l])).toBe(l);
  });

  it("two candidate listings that both fit: null, because it cannot tell them apart", () => {
    const a = listing({ id: "a" });
    const b = listing({ id: "b" });
    const lse = lease({ landlord: a.landlord, region: a.region, rent: a.rent, deposit: a.deposit });
    expect(leaseListing(lse, [a, b])).toBeNull();
  });

  it("zero listings: null", () => {
    expect(leaseListing(lease(), [])).toBeNull();
    expect(leaseListing(lease(), undefined)).toBeNull();
  });

  it("another landlord's otherwise-identical listing never matches", () => {
    const l = listing({ landlord: "landlord-1" });
    const lse = lease({ landlord: "landlord-2", region: l.region, rent: l.rent, deposit: l.deposit });
    expect(leaseListing(lse, [l])).toBeNull();
  });

  it("a mismatched field (rent, region or deposit) rules the listing out", () => {
    const l = listing();
    expect(leaseListing(lease({ landlord: l.landlord, region: l.region, rent: l.rent + 1, deposit: l.deposit }), [l])).toBeNull();
    expect(leaseListing(lease({ landlord: l.landlord, region: "DE", rent: l.rent, deposit: l.deposit }), [l])).toBeNull();
    expect(leaseListing(lease({ landlord: l.landlord, region: l.region, rent: l.rent, deposit: l.deposit + 1 }), [l])).toBeNull();
  });
});

describe("apartmentName", () => {
  it("the matched listing's title", () => {
    const l = listing({ title: "Sunlit 1-bedroom, Kazimierz" });
    const lse = lease({ landlord: l.landlord, region: l.region, rent: l.rent, deposit: l.deposit });
    expect(apartmentName(lse, [l])).toBe("Sunlit 1-bedroom, Kazimierz");
  });

  it("falls back to 'Apartment in <region>' when no listing matches", () => {
    expect(apartmentName(lease({ region: "PL" }), [])).toBe("Apartment in PL");
  });

  it("falls back even with a matched listing whose title is whitespace-only, rather than rendering blank", () => {
    const l = listing({ title: "   " });
    const lse = lease({ landlord: l.landlord, region: l.region, rent: l.rent, deposit: l.deposit });
    expect(apartmentName(lse, [l])).toBe("Apartment in PL");
  });

  it("falls back to 'This apartment' when the lease itself has no region either", () => {
    expect(apartmentName(lease({ region: "" }), [])).toBe("This apartment");
  });
});

describe("apartmentWhere", () => {
  it("with a resolvable listing: city and region joined", () => {
    const l = listing({ city: "Kraków", region: "PL" });
    const lse = lease({ landlord: l.landlord, region: l.region, rent: l.rent, deposit: l.deposit });
    expect(apartmentWhere(lse, [l])).toBe("Kraków · PL");
  });

  it("without a resolvable listing: just the region", () => {
    expect(apartmentWhere(lease({ region: "PL" }), [])).toBe("PL");
  });
});
