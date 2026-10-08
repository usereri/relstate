import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// sponsor.ts reads import.meta.env at module load, so each case sets env and re-imports.
async function load(env: { api?: string; feePayer?: string } = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_API", env.api ?? "");
  vi.stubEnv("VITE_FEE_PAYER", env.feePayer ?? "");
  return import("../sponsor");
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

describe("SPONSORED / API", () => {
  it("is off without VITE_API and on with it", async () => {
    expect((await load()).SPONSORED).toBe(false);
    const s = await load({ api: "http://b" });
    expect(s.SPONSORED).toBe(true);
    expect(s.API).toBe("http://b");
  });
});

describe("sponsorFeePayer", () => {
  it("VITE_FEE_PAYER wins outright, with no network", async () => {
    const s = await load({ api: "http://b", feePayer: "PAYER" });
    expect(await s.sponsorFeePayer()).toBe("PAYER");
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("with neither env var rejects telling the caller what to set", async () => {
    const s = await load();
    await expect(s.sponsorFeePayer()).rejects.toThrow(/VITE_API.*VITE_FEE_PAYER/);
  });

  it("discovers via GET /api/sponsor and caches the result", async () => {
    fetchMock().mockResolvedValue(json({ feePayer: "DISCOVERED" }));
    const s = await load({ api: "http://b" });
    expect(await s.sponsorFeePayer()).toBe("DISCOVERED");
    expect(await s.sponsorFeePayer()).toBe("DISCOVERED");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(fetchMock().mock.calls[0][0]).toBe("http://b/api/sponsor");
  });

  it("shares one in-flight discovery between concurrent callers", async () => {
    fetchMock().mockResolvedValue(json({ feePayer: "X" }));
    const s = await load({ api: "http://b" });
    await Promise.all([s.sponsorFeePayer(), s.sponsorFeePayer()]);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("throws naming the problem when feePayer is missing", async () => {
    fetchMock().mockResolvedValue(json({}));
    const s = await load({ api: "http://b" });
    await expect(s.sponsorFeePayer()).rejects.toThrow(/did not report a feePayer.*VITE_FEE_PAYER/);
  });

  it("throws on a non-ok response, preferring the backend's error text", async () => {
    fetchMock().mockResolvedValue(json({ error: "sponsor offline" }, 503));
    const s = await load({ api: "http://b" });
    await expect(s.sponsorFeePayer()).rejects.toThrow("sponsor offline");
  });

  it("falls back to a status message when the error body is not JSON", async () => {
    fetchMock().mockResolvedValue(new Response("<html>", { status: 502 }));
    const s = await load({ api: "http://b" });
    await expect(s.sponsorFeePayer()).rejects.toThrow(/sponsor discovery failed \(502\)/);
  });

  it("a failed discovery is not cached: the next call retries", async () => {
    fetchMock().mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(json({ feePayer: "LATER" }));
    const s = await load({ api: "http://b" });
    await expect(s.sponsorFeePayer()).rejects.toThrow("network down");
    expect(await s.sponsorFeePayer()).toBe("LATER");
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("a missing feePayer is also retried afterwards", async () => {
    fetchMock().mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ feePayer: "OK" }));
    const s = await load({ api: "http://b" });
    await expect(s.sponsorFeePayer()).rejects.toThrow();
    expect(await s.sponsorFeePayer()).toBe("OK");
  });
});

describe("postSponsored", () => {
  it("rejects without VITE_API", async () => {
    const s = await load();
    await expect(s.postSponsored("AAA")).rejects.toThrow(/VITE_API/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("POSTs the base64 transaction as JSON and returns the signature", async () => {
    fetchMock().mockResolvedValue(json({ signature: "SIG" }));
    const s = await load({ api: "http://b" });
    expect(await s.postSponsored("TXB64")).toBe("SIG");
    const [url, init] = fetchMock().mock.calls[0];
    expect(url).toBe("http://b/api/sponsor");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ txBase64: "TXB64" });
  });

  it("surfaces the backend's error field, not a bare status", async () => {
    fetchMock().mockResolvedValue(json({ error: "fee payer not allowed to pay for this instruction" }, 400));
    const s = await load({ api: "http://b" });
    await expect(s.postSponsored("TX")).rejects.toThrow("fee payer not allowed to pay for this instruction");
  });

  it("falls back to a status message without an error field", async () => {
    fetchMock().mockResolvedValue(new Response("nope", { status: 500 }));
    const s = await load({ api: "http://b" });
    await expect(s.postSponsored("TX")).rejects.toThrow(/sponsor failed \(500\)/);
  });
});
