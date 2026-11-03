import { describe, expect, it } from "vitest";
import { asRole, derivedRole, initialRole, readTabRole, roleOverride, writeTabRole } from "../role";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const fakeStore = (initial: Record<string, string> = {}): Store => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
};

const throwingStore: Store = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("asRole", () => {
  it("accepts 'landlord' and 'tenant'", () => {
    expect(asRole("landlord")).toBe("landlord");
    expect(asRole("tenant")).toBe("tenant");
  });

  it("rejects anything else", () => {
    expect(asRole("admin")).toBeNull();
    expect(asRole(undefined)).toBeNull();
    expect(asRole(null)).toBeNull();
    expect(asRole(42)).toBeNull();
  });
});

describe("roleOverride", () => {
  it("reads ?role=landlord or ?role=tenant from the query string", () => {
    expect(roleOverride("?role=landlord")).toBe("landlord");
    expect(roleOverride("?role=tenant")).toBe("tenant");
  });

  it("ignores an invalid ?role= value", () => {
    expect(roleOverride("?role=admin")).toBeNull();
  });

  it("is null when there is no override", () => {
    expect(roleOverride("")).toBeNull();
  });
});

describe("readTabRole / writeTabRole", () => {
  it("round-trips a role through an in-memory store", () => {
    const store = fakeStore();
    writeTabRole("landlord", store);
    expect(readTabRole(store)).toBe("landlord");
  });

  it("removes the key when writing null", () => {
    const store = fakeStore({ "relstate.role": "tenant" });
    writeTabRole(null, store);
    expect(readTabRole(store)).toBeNull();
  });

  it("readTabRole swallows a throwing store and returns null", () => {
    expect(readTabRole(throwingStore)).toBeNull();
  });

  it("writeTabRole swallows a throwing store without raising", () => {
    expect(() => writeTabRole("landlord", throwingStore)).not.toThrow();
  });
});

describe("derivedRole", () => {
  it("returns the role when exactly one relstate.wallet.<role> key exists", () => {
    expect(derivedRole(fakeStore({ "relstate.wallet.landlord": "1" }))).toBe("landlord");
    expect(derivedRole(fakeStore({ "relstate.wallet.tenant": "1" }))).toBe("tenant");
  });

  it("returns null when no wallet key exists", () => {
    expect(derivedRole(fakeStore())).toBeNull();
  });

  it("returns null when both wallet keys exist (signed in as both)", () => {
    expect(derivedRole(fakeStore({ "relstate.wallet.landlord": "1", "relstate.wallet.tenant": "1" }))).toBeNull();
  });

  it("returns null when the store throws", () => {
    expect(derivedRole(throwingStore)).toBeNull();
  });
});

describe("initialRole", () => {
  it("prefers the override over the tab's choice and the derived role", () => {
    const tab = fakeStore({ "relstate.role": "tenant" });
    const persisted = fakeStore({ "relstate.wallet.tenant": "1" });
    expect(initialRole("?role=landlord", tab, persisted)).toBe("landlord");
  });

  it("falls back to the tab's own choice when there is no override", () => {
    const tab = fakeStore({ "relstate.role": "landlord" });
    const persisted = fakeStore({ "relstate.wallet.tenant": "1" });
    expect(initialRole("", tab, persisted)).toBe("landlord");
  });

  it("falls back to the derived role when there is no override or tab choice", () => {
    const tab = fakeStore();
    const persisted = fakeStore({ "relstate.wallet.landlord": "1" });
    expect(initialRole("", tab, persisted)).toBe("landlord");
  });

  it("ignores an invalid ?role= override and falls through", () => {
    const tab = fakeStore({ "relstate.role": "tenant" });
    const persisted = fakeStore();
    expect(initialRole("?role=admin", tab, persisted)).toBe("tenant");
  });

  it("is null when nothing resolves the role", () => {
    expect(initialRole("", fakeStore(), fakeStore())).toBeNull();
  });
});
