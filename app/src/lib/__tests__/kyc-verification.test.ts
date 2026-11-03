import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// kyc.ts reads VITE_API through sponsor.ts at module load (KYC_AVAILABLE), exactly like fiat.ts;
// each group sets env and re-imports, as fiat.test.ts does.
async function load(api = "http://b") {
  vi.resetModules();
  vi.stubEnv("VITE_API", api);
  vi.stubEnv("VITE_FEE_PAYER", "");
  return import("../kyc");
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;
const health = () => json({ authMode: "mock" });
const session = { token: "SESSION", expiresAt: Math.floor(Date.now() / 1000) + 3600 };

const status = (over: Partial<Record<string, unknown>> = {}) =>
  json({ wallet: "W", verified: false, requireKyc: true, issuer: null, attestation: null, pending: false, last: null, provider: "mock", ...over });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("needsVerification", () => {
  it("is false with no backend configured, without making a network call", async () => {
    const { needsVerification } = await load("");
    expect(await needsVerification("W")).toBe(false);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("is true when the program requires identity and the wallet is not verified", async () => {
    fetchMock().mockResolvedValueOnce(health()).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(status({ requireKyc: true, verified: false }));
    const { needsVerification } = await load();
    expect(await needsVerification("W")).toBe(true);
  });

  it("is false once the wallet is verified", async () => {
    fetchMock().mockResolvedValueOnce(health()).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(status({ requireKyc: true, verified: true }));
    const { needsVerification } = await load();
    expect(await needsVerification("W")).toBe(false);
  });

  it("is false when the program does not require identity at all", async () => {
    fetchMock().mockResolvedValueOnce(health()).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(status({ requireKyc: false, verified: false }));
    const { needsVerification } = await load();
    expect(await needsVerification("W")).toBe(false);
  });

  it("is false when this deployment cannot write attestations, even if requireKyc is set", async () => {
    fetchMock()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(status({ requireKyc: true, verified: false, unavailable: "no issuer key configured" }));
    const { needsVerification } = await load();
    expect(await needsVerification("W")).toBe(false);
  });

  it("is false when the status lookup fails, leaving the program as the judge", async () => {
    fetchMock().mockResolvedValueOnce(health()).mockResolvedValueOnce(json(session)).mockRejectedValueOnce(new Error("network down"));
    const { needsVerification } = await load();
    expect(await needsVerification("W")).toBe(false);
  });
});

describe("setReturnAfterKyc / returnAfterKyc", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it("remembers which action to resume after the verification redirect", async () => {
    const { setReturnAfterKyc, returnAfterKyc } = await load();
    expect(returnAfterKyc()).toBeNull();
    setReturnAfterKyc("apply");
    expect(returnAfterKyc()).toBe("apply");
    setReturnAfterKyc("propose");
    expect(returnAfterKyc()).toBe("propose");
  });

  it("clears the remembered action with null", async () => {
    const { setReturnAfterKyc, returnAfterKyc } = await load();
    setReturnAfterKyc("apply");
    setReturnAfterKyc(null);
    expect(returnAfterKyc()).toBeNull();
  });

  it("survives sessionStorage being unavailable (private mode)", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    const { setReturnAfterKyc, returnAfterKyc } = await load();
    expect(() => setReturnAfterKyc("apply")).not.toThrow();
    expect(returnAfterKyc()).toBeNull();
  });

  it("ignores a garbage stored value", async () => {
    store.set("relstate.afterKyc", "not-a-valid-action");
    const { returnAfterKyc } = await load();
    expect(returnAfterKyc()).toBeNull();
  });
});
