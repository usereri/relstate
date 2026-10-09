import { describe, expect, it } from "vitest";
import { celebration, readSeen, snapshot, writeSeen } from "../celebrate";
import type { Seen, Store } from "../celebrate";
import { profile } from "./fixtures";

const seen = (over: Partial<Seen> = {}): Seen => ({
  level: 0,
  leasesCompleted: 0,
  paidOnTime: 0,
  paidLate: 0,
  defaults: 0,
  depositsReturnedFull: 0,
  depositsClaimed: 0,
  ...over,
});

const mapStore = (): Store & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
};

describe("snapshot", () => {
  it("a missing profile is all zeros at level 0", () => {
    expect(snapshot(null, "tenant")).toEqual(seen());
    expect(snapshot(null, "landlord")).toEqual(seen());
  });

  it("copies the counters and the computed level", () => {
    expect(snapshot(profile({ paidOnTime: 1, paidLate: 2 }), "tenant")).toEqual(seen({ level: 1, paidOnTime: 1, paidLate: 2 }));
  });
});

describe("celebration", () => {
  it("returns null when nothing changed", () => {
    expect(celebration(seen(), seen(), "tenant")).toBeNull();
    const s = snapshot(profile({ paidOnTime: 4, leasesCompleted: 1 }), "tenant");
    expect(celebration(s, s, "tenant")).toBeNull();
  });

  it("a first rent payment that raises the level is a level-up naming the new level", () => {
    const c = celebration(snapshot(null, "tenant"), snapshot(profile({ paidOnTime: 1 }), "tenant"), "tenant");
    expect(c?.kind).toBe("level-up");
    expect(c?.title).toContain("Resident");
  });

  it("a payment that does not raise the level is progress, titled with the gain", () => {
    const c = celebration(seen({ level: 1, paidOnTime: 1 }), seen({ level: 1, paidOnTime: 2 }), "tenant");
    expect(c).toMatchObject({ kind: "progress", title: "Rent paid on time" });
  });

  it("a landlord level-up uses the landlord ladder's name", () => {
    const c = celebration(snapshot(null, "landlord"), snapshot(profile({ leasesCompleted: 1 }), "landlord"), "landlord");
    expect(c?.kind).toBe("level-up");
    expect(c?.title).toContain("Host");
  });

  it("a new late payment is never celebrated", () => {
    expect(celebration(seen({ level: 1, paidOnTime: 1 }), seen({ level: 1, paidOnTime: 1, paidLate: 1 }), "tenant")).toBeNull();
  });

  it("a new default is never celebrated", () => {
    expect(celebration(seen({ level: 2 }), seen({ level: 1, defaults: 1 }), "tenant")).toBeNull();
  });

  it("a new claimed deposit is never celebrated", () => {
    expect(celebration(seen({ level: 1, leasesCompleted: 1 }), seen({ level: 1, leasesCompleted: 1, depositsClaimed: 1 }), "landlord")).toBeNull();
  });

  it("a setback in the same step as a gain still suppresses the celebration", () => {
    const before = seen();
    expect(celebration(before, seen({ level: 1, paidOnTime: 1, paidLate: 1 }), "tenant")).toBeNull();
    expect(celebration(before, seen({ level: 1, paidOnTime: 1, defaults: 1 }), "tenant")).toBeNull();
    expect(celebration(before, seen({ leasesCompleted: 1, depositsClaimed: 1 }), "landlord")).toBeNull();
  });

  it("several gains at once are all named", () => {
    const c = celebration(
      seen({ level: 2, leasesCompleted: 1, paidOnTime: 3 }),
      seen({ level: 2, leasesCompleted: 2, paidOnTime: 3, depositsReturnedFull: 1 }),
      "tenant",
    );
    expect(c?.kind).toBe("progress");
    const text = `${c?.title} | ${c?.detail}`;
    expect(text).toContain("Lease completed");
    expect(text).toContain("Deposit returned in full");
  });

  it("pluralises: 1 reads as 'Rent paid on time', 2 as '2 rent payments on time'", () => {
    expect(celebration(seen({ level: 1, paidOnTime: 1 }), seen({ level: 1, paidOnTime: 2 }), "tenant")?.title).toBe("Rent paid on time");
    expect(celebration(seen({ level: 1, paidOnTime: 1 }), seen({ level: 1, paidOnTime: 3 }), "tenant")?.title).toBe("2 rent payments on time");
  });

  it("pluralises leases and returned deposits", () => {
    const c = celebration(seen(), seen({ leasesCompleted: 2, depositsReturnedFull: 2 }), "landlord");
    const text = `${c?.title} | ${c?.detail}`;
    expect(text).toContain("2 leases completed");
    expect(text).toContain("2 deposits returned in full");
  });
});

describe("readSeen / writeSeen", () => {
  it("readSeen is null for an empty store", () => {
    expect(readSeen("addr", "tenant", mapStore())).toBeNull();
  });

  it("a write then a read returns the same Seen", () => {
    const store = mapStore();
    const s = seen({ level: 2, leasesCompleted: 1, paidOnTime: 3 });
    writeSeen("addr", "tenant", s, store);
    expect(readSeen("addr", "tenant", store)).toEqual(s);
  });

  it("the key is per wallet and per role", () => {
    const store = mapStore();
    writeSeen("addr", "tenant", seen({ level: 1, paidOnTime: 1 }), store);
    expect(readSeen("addr", "landlord", store)).toBeNull();
    expect(readSeen("other", "tenant", store)).toBeNull();
    expect(readSeen("addr", "tenant", store)).not.toBeNull();
  });

  it("a stored value of the wrong shape reads as null", () => {
    const store = mapStore();
    writeSeen("addr", "tenant", seen(), store);
    const [k] = [...store.map.keys()];
    const { paidLate: _drop, ...partial } = seen();
    store.map.set(k!, JSON.stringify(partial));
    expect(readSeen("addr", "tenant", store)).toBeNull();
    store.map.set(k!, JSON.stringify({ ...seen(), level: "2" }));
    expect(readSeen("addr", "tenant", store)).toBeNull();
    store.map.set(k!, "not json");
    expect(readSeen("addr", "tenant", store)).toBeNull();
    store.map.set(k!, "null");
    expect(readSeen("addr", "tenant", store)).toBeNull();
  });

  it("a store that throws does not propagate from either call", () => {
    const boom: Store = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readSeen("addr", "tenant", boom)).toBeNull();
    expect(() => writeSeen("addr", "tenant", seen(), boom)).not.toThrow();
  });
});
