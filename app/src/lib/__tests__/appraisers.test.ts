import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { directoryEntries, mergeDirectory, nameHash, trustedLabel, trustedLabelFor } from "../appraisers";
import type { RegistryEntry } from "../appraisers";

// appraisers.ts reads VITE_API through sponsor.ts at module load (DIRECTORY_AVAILABLE, loadAppraiserDirectory),
// so loadAppraiserDirectory cases set env and re-import, as sponsor.test.ts and fiat.test.ts do.
async function load(env: { api?: string } = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_API", env.api ?? "");
  return import("../appraisers");
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("nameHash", () => {
  it("is sha256(name) as lower-case hex, pinned against a literal digest", () => {
    // sha256("Rzeczoznawca A") computed independently (node:crypto); a change of encoding
    // (trimming, case-folding, a different text-to-bytes path) must fail this.
    expect(nameHash("Rzeczoznawca A")).toBe("67f555f43a991f7c4efc336ae37fb3eefe7d1ae5942d9b5f38dcacc02187acad");
  });

  it("is deterministic and sensitive to the exact bytes", () => {
    expect(nameHash("Rzeczoznawca A")).toBe(nameHash("Rzeczoznawca A"));
    expect(nameHash("Rzeczoznawca A")).not.toBe(nameHash("Rzeczoznawca B"));
    expect(nameHash("Rzeczoznawca A")).not.toBe(nameHash("rzeczoznawca a"));
  });
});

describe("mergeDirectory", () => {
  const entry = (overrides: Partial<RegistryEntry> = {}): RegistryEntry => ({
    address: "ADDR",
    wallet: "WALLET",
    active: true,
    isDefault: false,
    fee: 1_000,
    nameHashHex: nameHash("Rzeczoznawca A"),
    ...overrides,
  });

  it("attaches the name by wallet", () => {
    const [o] = mergeDirectory([entry({ wallet: "W1" })], [{ wallet: "W1", name: "Rzeczoznawca A" }]);
    expect(o.name).toBe("Rzeczoznawca A");
  });

  it("nameVerified is true only when nameHash(name) equals the registry's name_hash", () => {
    const [o] = mergeDirectory(
      [entry({ wallet: "W1", nameHashHex: nameHash("Rzeczoznawca A") })],
      [{ wallet: "W1", name: "Rzeczoznawca A" }],
    );
    expect(o.nameVerified).toBe(true);
  });

  it("nameVerified is false when the directory's name does not hash to the registry's commitment", () => {
    const [o] = mergeDirectory(
      [entry({ wallet: "W1", nameHashHex: nameHash("Rzeczoznawca A") })],
      [{ wallet: "W1", name: "Not The Real Name" }],
    );
    expect(o.nameVerified).toBe(false);
    expect(o.name).toBe("Not The Real Name"); // still shown, as a name the backend asserts
  });

  it("nameVerified is false (not thrown) when the directory has no name for this key", () => {
    const [o] = mergeDirectory([entry({ wallet: "W1" })], []);
    expect(o.name).toBe("");
    expect(o.nameVerified).toBe(false);
  });

  it("drops a directory row whose key has no registry entry: the chain is the authority on who exists", () => {
    const merged = mergeDirectory([entry({ wallet: "W1" })], [
      { wallet: "W1", name: "Rzeczoznawca A" },
      { wallet: "W-GHOST", name: "Nobody Registered This" },
    ]);
    expect(merged.map((o) => o.wallet)).toEqual(["W1"]);
  });

  it("orders active before suspended", () => {
    const merged = mergeDirectory(
      [entry({ wallet: "SUSPENDED", active: false, nameHashHex: "" }), entry({ wallet: "ACTIVE", nameHashHex: "" })],
      [],
    );
    expect(merged.map((o) => o.wallet)).toEqual(["ACTIVE", "SUSPENDED"]);
  });

  it("within the same active state, orders named before nameless", () => {
    const merged = mergeDirectory(
      [entry({ wallet: "NAMELESS", nameHashHex: "" }), entry({ wallet: "NAMED", nameHashHex: nameHash("Rzeczoznawca A") })],
      [{ wallet: "NAMED", name: "Rzeczoznawca A" }],
    );
    expect(merged.map((o) => o.wallet)).toEqual(["NAMED", "NAMELESS"]);
  });

  it("the returned name is sanitised, but nameVerified is computed from the RAW directory name", () => {
    // The sharp case: a zero-width character inside a name that still hashes correctly (the
    // registry committed to the RAW string). Hashing the sanitised string first would fail a
    // legitimately registered name -- this is the test that stops someone "simplifying" that order.
    const raw = "Rzeczoznawca​ A";
    const [o] = mergeDirectory([entry({ wallet: "W1", nameHashHex: nameHash(raw) })], [{ wallet: "W1", name: raw }]);
    expect(o.nameVerified).toBe(true);
    expect(o.name).toBe("Rzeczoznawca A"); // the zero-width character is gone from what is shown
  });
});

describe("trustedLabel", () => {
  const opt = (overrides: Partial<{ name: string; nameVerified: boolean; wallet: string }> = {}) => ({
    name: "Rzeczoznawca A",
    nameVerified: true,
    wallet: "WALLETKEY",
    ...overrides,
  });
  const shorten = (s: string) => `short(${s})`;

  it("shows the name when it is verified and non-empty", () => {
    expect(trustedLabel(opt(), shorten)).toBe("Rzeczoznawca A");
  });

  it("falls back to the shortened key when nameVerified is true but the name is empty", () => {
    expect(trustedLabel(opt({ nameVerified: true, name: "" }), shorten)).toBe("short(WALLETKEY)");
  });

  it("falls back to the shortened key when the name is unverified", () => {
    expect(trustedLabel(opt({ nameVerified: false }), shorten)).toBe("short(WALLETKEY)");
  });

  it("falls back to the shortened empty key when the option itself is undefined", () => {
    expect(trustedLabel(undefined, shorten)).toBe("short()");
  });
});

describe("trustedLabelFor", () => {
  const opt = (overrides: Partial<{ name: string; nameVerified: boolean; wallet: string }> = {}) => ({
    name: "Rzeczoznawca A",
    nameVerified: true,
    wallet: "WALLETKEY",
    ...overrides,
  });
  const shorten = (s: string) => `short(${s})`;

  it("shows a matching verified name", () => {
    expect(trustedLabelFor(opt(), "CALLERKEY", shorten)).toBe("Rzeczoznawca A");
  });

  it("uses the entry's shortened key when the entry is unverified", () => {
    expect(trustedLabelFor(opt({ nameVerified: false }), "CALLERKEY", shorten)).toBe("short(WALLETKEY)");
  });

  it("uses the caller's shortened wallet when the entry is missing, never an empty label", () => {
    expect(trustedLabelFor(undefined, "WALLETKEY123", shorten)).toBe("short(WALLETKEY123)");
  });

  it("uses the entry's shortened key when a verified name is empty", () => {
    expect(trustedLabelFor(opt({ name: "" }), "CALLERKEY", shorten)).toBe("short(WALLETKEY)");
  });

  it("agrees with trustedLabel whenever an entry is present", () => {
    for (const entry of [opt(), opt({ nameVerified: false }), opt({ name: "" })]) {
      expect(trustedLabelFor(entry, "CALLERKEY", shorten)).toBe(trustedLabel(entry, shorten));
    }
  });
});

describe("directoryEntries", () => {
  it("accepts a bare array", () => {
    expect(directoryEntries([{ wallet: "W1", name: "A" }])).toEqual([{ wallet: "W1", name: "A" }]);
  });

  it("accepts { appraisers: [...] }", () => {
    expect(directoryEntries({ appraisers: [{ wallet: "W1", name: "A" }] })).toEqual([{ wallet: "W1", name: "A" }]);
  });

  it("accepts key as well as wallet", () => {
    expect(directoryEntries([{ key: "W1", name: "A" }])).toEqual([{ wallet: "W1", name: "A" }]);
  });

  it("prefers wallet over key when both are present", () => {
    expect(directoryEntries([{ wallet: "W1", key: "W2", name: "A" }])).toEqual([{ wallet: "W1", name: "A" }]);
  });

  it("drops rows with no usable key", () => {
    expect(directoryEntries([{ name: "A" }])).toEqual([]);
  });

  it("defaults name to '' when missing or not a string", () => {
    expect(directoryEntries([{ wallet: "W1" }])).toEqual([{ wallet: "W1", name: "" }]);
    expect(directoryEntries([{ wallet: "W1", name: 42 }])).toEqual([{ wallet: "W1", name: "" }]);
  });

  it("survives a junk top-level body without throwing", () => {
    expect(directoryEntries(null)).toEqual([]);
    expect(directoryEntries(undefined)).toEqual([]);
    expect(directoryEntries("just a string")).toEqual([]);
    expect(directoryEntries({})).toEqual([]);
  });

  it("survives junk rows inside the array, including null and primitives, without throwing", () => {
    // A null or primitive element used to throw on `row.wallet` before the row shape was checked;
    // fixed in 8566986 by skipping any non-object row first.
    expect(directoryEntries([null, "junk", 42, {}, { wallet: 7 }, { wallet: "OK" }])).toEqual([{ wallet: "OK", name: "" }]);
  });
});

describe("loadAppraiserDirectory", () => {
  it("is [] with no VITE_API, and never calls fetch", async () => {
    const a = await load();
    expect(await a.loadAppraiserDirectory()).toEqual([]);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("is [] on a 404 (a backend that predates the route is not a failure)", async () => {
    fetchMock().mockResolvedValue(json({}, 404));
    const a = await load({ api: "http://b" });
    expect(await a.loadAppraiserDirectory()).toEqual([]);
  });

  it("throws on a 500, using the body's error string when there is one", async () => {
    fetchMock().mockResolvedValue(json({ error: "directory backend is down" }, 500));
    const a = await load({ api: "http://b" });
    await expect(a.loadAppraiserDirectory()).rejects.toThrow("directory backend is down");
  });

  it("throws on a 500 with no usable error body, falling back to a status message", async () => {
    fetchMock().mockResolvedValue(new Response("<html>", { status: 500 }));
    const a = await load({ api: "http://b" });
    await expect(a.loadAppraiserDirectory()).rejects.toThrow(/\(500\)/);
  });

  it("is [] on a 200 with a junk body rather than throwing", async () => {
    fetchMock().mockResolvedValue(json({ not: "a list" }));
    const a = await load({ api: "http://b" });
    expect(await a.loadAppraiserDirectory()).toEqual([]);
  });

  it("returns the parsed rows on a normal 200", async () => {
    fetchMock().mockResolvedValue(json([{ wallet: "W1", name: "Rzeczoznawca A" }]));
    const a = await load({ api: "http://b" });
    expect(await a.loadAppraiserDirectory()).toEqual([{ wallet: "W1", name: "Rzeczoznawca A" }]);
    expect(fetchMock().mock.calls[0][0]).toBe("http://b/api/appraisers");
  });
});
