import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// invites.ts reads VITE_API at module load through sponsor.ts, so each case stubs it and re-imports.
beforeEach(() => vi.stubEnv("VITE_API", "http://backend.test"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function load(token: string | null = "SESSION") {
  vi.resetModules();
  const sponsor = await import("../sponsor");
  sponsor.setSessionTokenSource(token ? async () => token : null);
  return import("../invites");
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mockFetch = (res: Response) => vi.spyOn(globalThis, "fetch").mockResolvedValue(res);

describe("createInvite", () => {
  it("posts the decided request with a bearer token and parses the masked response", async () => {
    const inv = await load();
    const f = mockFetch(
      json(200, {
        lease: "L", companyName: "Acme", nameHash: "AB", agreedFee: "3000000", email: "b***@acme.example", expiresAt: 99,
        delivery: { sender: "console", sent: true }, url: "http://app/#/invite/tok",
      }),
    );
    const out = await inv.createInvite({ lease: "L", companyName: "Acme", email: " boss@acme.example " });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://backend.test/api/invites");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer SESSION");
    expect(JSON.parse(init.body as string)).toEqual({ lease: "L", companyName: "Acme", email: "boss@acme.example" });
    expect(out).toMatchObject({ agreedFee: 3_000_000, email: "b***@acme.example", nameHash: "ab", delivery: { sender: "console", sent: true }, url: "http://app/#/invite/tok" });
  });
  it("url is empty when the backend (live mode) omits it", async () => {
    const inv = await load();
    mockFetch(json(200, { lease: "L", companyName: "Acme", delivery: { sender: "none", sent: false } }));
    expect((await inv.createInvite({ lease: "L", companyName: "Acme", email: "a@b.c" })).url).toBe("");
  });
  it("maps the backend's codes to readable messages", async () => {
    const inv = await load();
    for (const [code, re] of [
      ["name-not-agreed", /agreed on a company/],
      ["name-mismatch", /agreed on/],
      ["not-a-party", /landlord or tenant/],
      ["lease-not-in-mediation", /not in mediation/],
      ["appraiser-already-bound", /already bound/],
    ] as const) {
      mockFetch(json(409, { error: "raw", code }));
      await expect(inv.createInvite({ lease: "L", companyName: "A", email: "a@b.c" })).rejects.toThrow(re);
    }
  });
  it("401 and 429 get their own wording; an unknown failure keeps the backend's error", async () => {
    const inv = await load();
    mockFetch(json(401, {}));
    await expect(inv.createInvite({ lease: "L", companyName: "A", email: "a@b.c" })).rejects.toThrow(/session/);
    mockFetch(json(429, {}));
    await expect(inv.createInvite({ lease: "L", companyName: "A", email: "a@b.c" })).rejects.toThrow(/Too many/);
    mockFetch(json(500, { error: "boom" }));
    await expect(inv.createInvite({ lease: "L", companyName: "A", email: "a@b.c" })).rejects.toThrow("boom");
  });
});

describe("loadInvite (public)", () => {
  it("sends no authorization header and parses the case, amounts as digit strings", async () => {
    const inv = await load(null);
    const f = mockFetch(
      json(200, { lease: "L", companyName: "Acme", nameHash: "ab", agreedFee: "3000000", mint: "M", depositAmount: "5000000000", landlord: "LL", tenant: "TT", selectionDeadline: 5, status: "claimed", claimedWallet: "W", expiresAt: 6 }),
    );
    const c = await inv.loadInvite("tok/en");
    expect((f.mock.calls[0] as [string])[0]).toBe("http://backend.test/api/invites/tok%2Fen");
    expect(f.mock.calls[0][1]).toBeUndefined();
    expect(c).toMatchObject({ depositAmount: 5_000_000_000, agreedFee: 3_000_000, status: "claimed", claimedWallet: "W" });
  });
  it("a 404 is null; other failures are raised with the readable message", async () => {
    const inv = await load(null);
    mockFetch(json(404, { code: "invite-invalid" }));
    expect(await inv.loadInvite("x")).toBeNull();
    mockFetch(json(410, { code: "invite-expired" }));
    await expect(inv.loadInvite("x")).rejects.toThrow(/expired/);
  });
  it("survives a null body and a hostile company name", async () => {
    const inv = await load(null);
    mockFetch(json(200, null));
    expect(await inv.loadInvite("x")).toMatchObject({ companyName: "", depositAmount: 0, status: "pending", claimedWallet: "" });
    mockFetch(json(200, { companyName: "Ac‮me" }));
    expect((await inv.loadInvite("x"))!.companyName).toBe("Acme");
  });
});

describe("claimInvite", () => {
  it("posts an empty body with the appraiser's own session", async () => {
    const inv = await load("APPRAISER");
    const f = mockFetch(json(200, { lease: "L", companyName: "Acme", wallet: "W", claimedAt: 7 }));
    expect(await inv.claimInvite("tok")).toEqual({ lease: "L", companyName: "Acme", wallet: "W", claimedAt: 7 });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://backend.test/api/invites/tok/claim");
    expect(init.body).toBe("{}");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer APPRAISER");
  });
  it("explains already-claimed and wallet-is-party", async () => {
    const inv = await load();
    mockFetch(json(409, { code: "already-claimed" }));
    await expect(inv.claimInvite("t")).rejects.toThrow(/different account/);
    mockFetch(json(400, { code: "wallet-is-party" }));
    await expect(inv.claimInvite("t")).rejects.toThrow(/landlord or the tenant/);
  });
});

describe("loadLeaseInvite", () => {
  it("returns the pending wallet for a party, or null when there is no invite", async () => {
    const inv = await load();
    const f = mockFetch(json(200, { lease: "L", invite: { companyName: "Acme", nameHash: "ab", agreedFee: "1", status: "claimed", wallet: "W", claimedAt: 3, expiresAt: 9, issuedBy: "tenant" } }));
    expect(await inv.loadLeaseInvite("L")).toMatchObject({ wallet: "W", status: "claimed", issuedBy: "tenant", agreedFee: 1 });
    expect((f.mock.calls[0] as [string])[0]).toBe("http://backend.test/api/invites?lease=L");
    mockFetch(json(200, { lease: "L", invite: null }));
    expect(await inv.loadLeaseInvite("L")).toBeNull();
  });
  it("sends no authorization header when no session is registered, and the backend's 401 is explained", async () => {
    const inv = await load(null);
    const f = mockFetch(json(401, {}));
    await expect(inv.loadLeaseInvite("L")).rejects.toThrow(/session/);
    expect((f.mock.calls[0][1] as RequestInit).headers).toEqual({});
  });
});

describe("without a backend", () => {
  it("every call explains that e-mail needs one", async () => {
    vi.stubEnv("VITE_API", "");
    vi.resetModules();
    const inv = await import("../invites");
    expect(inv.INVITES_AVAILABLE).toBe(false);
    await expect(inv.createInvite({ lease: "L", companyName: "A", email: "a@b.c" })).rejects.toThrow(/no backend/);
    await expect(inv.loadInvite("t")).rejects.toThrow(/no backend/);
  });
});
