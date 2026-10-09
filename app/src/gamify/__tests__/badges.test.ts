import { describe, expect, it } from "vitest";
import { badgesFor } from "../badges";
import { DISCOUNT_PCT, goodStanding } from "@/lib/chain";
import { profile } from "./fixtures";

const byId = (list: ReturnType<typeof badgesFor>, id: string) => list.find((b) => b.id === id)!;

describe("badgesFor", () => {
  it("tenant gets exactly the five tenant badges", () => {
    expect(badgesFor("tenant", null).map((b) => b.id).sort()).toEqual(
      ["cross-border", "deposit-returned", "discount", "first-rent", "on-time-run"],
    );
  });

  it("landlord gets exactly the four landlord badges and no tenant-only ones", () => {
    const ids = badgesFor("landlord", null).map((b) => b.id);
    expect(ids.sort()).toEqual(["cross-border", "deposit-returned", "first-lease", "no-claims"]);
    for (const tenantOnly of ["first-rent", "on-time-run", "discount"]) expect(ids).not.toContain(tenantOnly);
  });

  it("nothing is earned for a missing profile with no countries, yet every badge is still listed", () => {
    for (const role of ["tenant", "landlord"] as const) {
      const list = badgesFor(role, null);
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((b) => !b.earned)).toBe(true);
    }
  });

  it("first-rent: any payment, late or on time, earns it", () => {
    expect(byId(badgesFor("tenant", profile({ paidLate: 1 })), "first-rent").earned).toBe(true);
    expect(byId(badgesFor("tenant", profile({ paidOnTime: 1 })), "first-rent").earned).toBe(true);
  });

  it("on-time-run: 3 on time and none late is earned", () => {
    expect(byId(badgesFor("tenant", profile({ paidOnTime: 3 })), "on-time-run").earned).toBe(true);
  });

  it("on-time-run: 3 on time with 1 late is not earned, the order is unknowable", () => {
    expect(byId(badgesFor("tenant", profile({ paidOnTime: 3, paidLate: 1 })), "on-time-run").earned).toBe(false);
    expect(byId(badgesFor("tenant", profile({ paidOnTime: 10, paidLate: 1 })), "on-time-run").earned).toBe(false);
  });

  it("on-time-run: 2 on time with 0 late is not earned", () => {
    expect(byId(badgesFor("tenant", profile({ paidOnTime: 2 })), "on-time-run").earned).toBe(false);
  });

  it("deposit-returned follows depositsReturnedFull for both roles", () => {
    for (const role of ["tenant", "landlord"] as const) {
      expect(byId(badgesFor(role, profile()), "deposit-returned").earned).toBe(false);
      expect(byId(badgesFor(role, profile({ depositsReturnedFull: 1 })), "deposit-returned").earned).toBe(true);
    }
  });

  it("cross-border needs 2 or more countries; the earned hint names them", () => {
    for (const role of ["tenant", "landlord"] as const) {
      expect(byId(badgesFor(role, null, []), "cross-border").earned).toBe(false);
      expect(byId(badgesFor(role, null, ["Poland"]), "cross-border").earned).toBe(false);
      const two = byId(badgesFor(role, null, ["Poland", "Spain"]), "cross-border");
      expect(two.earned).toBe(true);
      expect(two.hint).toContain("Poland");
      expect(two.hint).toContain("Spain");
    }
  });

  it("discount tracks goodStanding exactly and its label carries DISCOUNT_PCT", () => {
    const cases = [
      null,
      profile(),
      profile({ leasesCompleted: 1 }),
      profile({ leasesCompleted: 1, paidLate: 1 }),
      profile({ leasesCompleted: 1, defaults: 1 }),
      profile({ leasesCompleted: 2, paidOnTime: 6 }),
    ];
    for (const p of cases) {
      const d = byId(badgesFor("tenant", p), "discount");
      expect(d.earned).toBe(goodStanding(p));
      expect(d.label).toContain(`${DISCOUNT_PCT}%`);
    }
    expect(byId(badgesFor("tenant", profile({ leasesCompleted: 1 })), "discount").earned).toBe(true);
  });

  it("first-lease (landlord) needs a finished lease", () => {
    expect(byId(badgesFor("landlord", profile()), "first-lease").earned).toBe(false);
    expect(byId(badgesFor("landlord", profile({ leasesCompleted: 1 })), "first-lease").earned).toBe(true);
  });

  it("no-claims (landlord) needs a finished lease and is lost on a claimed deposit", () => {
    expect(byId(badgesFor("landlord", profile()), "no-claims").earned).toBe(false);
    expect(byId(badgesFor("landlord", profile({ leasesCompleted: 1 })), "no-claims").earned).toBe(true);
    expect(byId(badgesFor("landlord", profile({ leasesCompleted: 3, depositsClaimed: 1 })), "no-claims").earned).toBe(false);
  });
});
