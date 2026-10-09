import { describe, expect, it } from "vitest";
import { levelNames, levelOf, standing } from "../levels";
import { profile } from "./fixtures";
import type { Role } from "@/lib/chain";

const roles: Role[] = ["tenant", "landlord"];

const TRUSTED_T = { leasesCompleted: 1, paidOnTime: 3 };
const GOLD_T = { leasesCompleted: 2, paidOnTime: 6, depositsReturnedFull: 1 };
const TRUSTED_L = { leasesCompleted: 2, depositsReturnedFull: 1 };
const GOLD_L = { leasesCompleted: 4, depositsReturnedFull: 3 };

describe("levelNames", () => {
  it("lists four rungs per role, entry level first", () => {
    expect(levelNames("tenant")).toEqual(["Newcomer", "Resident", "Trusted", "Gold"]);
    expect(levelNames("landlord")).toEqual(["Newcomer", "Host", "Trusted", "Gold"]);
  });
});

describe("levelOf", () => {
  it("is 0 for a missing profile and for an all-zero profile, for both roles", () => {
    for (const role of roles) {
      expect(levelOf(null, role)).toBe(0);
      expect(levelOf(profile(), role)).toBe(0);
    }
  });

  it("tenant: the first payment, late or on time, reaches Resident", () => {
    expect(levelOf(profile({ paidOnTime: 1 }), "tenant")).toBe(1);
    expect(levelOf(profile({ paidLate: 1 }), "tenant")).toBe(1);
  });

  it("tenant: Trusted is reached exactly at 1 lease, 3 on time, no defaults", () => {
    expect(levelOf(profile(TRUSTED_T), "tenant")).toBe(2);
    expect(levelOf(profile({ ...TRUSTED_T, leasesCompleted: 0 }), "tenant")).toBe(1);
    expect(levelOf(profile({ ...TRUSTED_T, paidOnTime: 2 }), "tenant")).toBe(1);
    expect(levelOf(profile({ ...TRUSTED_T, defaults: 1 }), "tenant")).toBe(1);
  });

  it("tenant: Gold is reached exactly at its thresholds, one short of any is Trusted", () => {
    expect(levelOf(profile(GOLD_T), "tenant")).toBe(3);
    expect(levelOf(profile({ ...GOLD_T, leasesCompleted: 1 }), "tenant")).toBe(2);
    expect(levelOf(profile({ ...GOLD_T, paidOnTime: 5 }), "tenant")).toBe(2);
    expect(levelOf(profile({ ...GOLD_T, depositsReturnedFull: 0 }), "tenant")).toBe(2);
  });

  it("tenant: a late payment drops Gold to Trusted", () => {
    expect(levelOf(profile({ ...GOLD_T, paidLate: 1 }), "tenant")).toBe(2);
  });

  it("tenant: a default drops Trusted to Resident, and Gold to Resident", () => {
    expect(levelOf(profile({ ...TRUSTED_T, defaults: 1 }), "tenant")).toBe(1);
    expect(levelOf(profile({ ...GOLD_T, defaults: 1 }), "tenant")).toBe(1);
  });

  it("a profile with later-rung counters but no base is not lifted past the lower rung", () => {
    // deposits returned and leases done, but no rent payment ever: still Newcomer
    expect(levelOf(profile({ leasesCompleted: 2, depositsReturnedFull: 1 }), "tenant")).toBe(0);
    // landlord with returned deposits but no finished lease
    expect(levelOf(profile({ depositsReturnedFull: 3 }), "landlord")).toBe(0);
  });

  it("landlord: Host at one finished lease, Trusted at 2 leases + 1 deposit, Gold at 4 + 3", () => {
    expect(levelOf(profile({ leasesCompleted: 1 }), "landlord")).toBe(1);
    expect(levelOf(profile(TRUSTED_L), "landlord")).toBe(2);
    expect(levelOf(profile({ ...TRUSTED_L, leasesCompleted: 1 }), "landlord")).toBe(1);
    expect(levelOf(profile({ ...TRUSTED_L, depositsReturnedFull: 0 }), "landlord")).toBe(1);
    expect(levelOf(profile(GOLD_L), "landlord")).toBe(3);
    expect(levelOf(profile({ ...GOLD_L, leasesCompleted: 3 }), "landlord")).toBe(2);
    expect(levelOf(profile({ ...GOLD_L, depositsReturnedFull: 2 }), "landlord")).toBe(2);
  });

  it("landlord: a deposit claimed by a tenant blocks Trusted and Gold", () => {
    expect(levelOf(profile({ ...TRUSTED_L, depositsClaimed: 1 }), "landlord")).toBe(1);
    expect(levelOf(profile({ ...GOLD_L, depositsClaimed: 1 }), "landlord")).toBe(1);
  });
});

describe("standing", () => {
  it("at the top rung there is no next level, no requirements and progress is 100", () => {
    const t = standing(profile(GOLD_T), "tenant");
    expect(t).toMatchObject({ index: 3, top: 3, name: "Gold", next: null, requirements: [], progress: 100 });
    const l = standing(profile(GOLD_L), "landlord");
    expect(l).toMatchObject({ index: 3, top: 3, name: "Gold", next: null, requirements: [], progress: 100 });
  });

  it("below the top, next is the next rung's name", () => {
    expect(standing(null, "tenant").next?.name).toBe("Resident");
    expect(standing(profile({ paidOnTime: 1 }), "tenant").next?.name).toBe("Trusted");
    expect(standing(profile(TRUSTED_L), "landlord").next?.name).toBe("Gold");
  });

  it("lists every rule of the next rung, met ones included, with have/need/met", () => {
    const s = standing(profile({ paidOnTime: 2, leasesCompleted: 1 }), "tenant");
    expect(s.next?.name).toBe("Trusted");
    expect(s.requirements.map((r) => [r.label, r.have, r.need, r.met])).toEqual([
      ["1 finished lease", 1, 1, true],
      ["3 payments on time", 2, 3, false],
      ["No defaults", 0, 0, true],
    ]);
  });

  it("a zero-need rule is unmet while the counter is above zero", () => {
    const s = standing(profile({ paidOnTime: 5, leasesCompleted: 1, defaults: 2 }), "tenant");
    const gate = s.requirements.find((r) => r.label === "No defaults")!;
    expect(gate).toMatchObject({ have: 2, need: 0, met: false, ratio: 0 });
  });

  it("progress is 0 when none of the next rung's rules is satisfied", () => {
    expect(standing(null, "tenant").progress).toBe(0);
    expect(standing(null, "landlord").progress).toBe(0);
    // Resident -> Trusted with a default on record: lease 0, on-time 0, default gate failed
    expect(standing(profile({ paidLate: 1, defaults: 1 }), "tenant").progress).toBe(0);
  });

  it("progress rises as a counter rises", () => {
    const a = standing(profile({ paidOnTime: 1 }), "tenant").progress;
    const b = standing(profile({ paidOnTime: 2 }), "tenant").progress;
    expect(b).toBeGreaterThan(a);
  });

  it("progress is never 100 while there is a next level, even one counter short", () => {
    const oneShort = [
      standing(profile({ ...GOLD_T, paidOnTime: 5 }), "tenant"),
      standing(profile({ ...GOLD_T, leasesCompleted: 1 }), "tenant"),
      standing(profile({ ...GOLD_L, leasesCompleted: 3 }), "landlord"),
      standing(profile({ ...GOLD_L, depositsReturnedFull: 2 }), "landlord"),
      standing(profile({ ...TRUSTED_T, paidOnTime: 2 }), "tenant"),
    ];
    for (const s of oneShort) {
      expect(s.next).not.toBeNull();
      expect(s.progress).toBeGreaterThan(0);
      expect(s.progress).toBeLessThanOrEqual(99);
    }
  });

  it("progress stays within 0..99 for a sweep of profiles below the top", () => {
    for (const role of roles) {
      for (let l = 0; l <= 5; l++)
        for (let o = 0; o <= 7; o++)
          for (let r = 0; r <= 4; r++) {
            const p = profile({ leasesCompleted: l, paidOnTime: o, depositsReturnedFull: r });
            const s = standing(p, role);
            if (s.next) {
              expect(s.progress).toBeGreaterThanOrEqual(0);
              expect(s.progress).toBeLessThanOrEqual(99);
            }
          }
    }
  });

  it("invariant: the standing's name is the level name at levelOf", () => {
    const sample = [
      null,
      profile(),
      profile({ paidOnTime: 1 }),
      profile(TRUSTED_T),
      profile(GOLD_T),
      profile({ ...GOLD_T, defaults: 1 }),
      profile({ leasesCompleted: 1 }),
      profile(TRUSTED_L),
      profile(GOLD_L),
      profile({ ...GOLD_L, depositsClaimed: 1 }),
    ];
    for (const role of roles)
      for (const p of sample) {
        expect(standing(p, role).name).toBe(levelNames(role)[levelOf(p, role)]);
        expect(standing(p, role).index).toBe(levelOf(p, role));
      }
  });
});
