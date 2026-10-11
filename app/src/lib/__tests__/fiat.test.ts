import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fiat.ts reads VITE_API through sponsor.ts at module load, so each group sets
// env and re-imports, exactly as sponsor.test.ts does.
async function load(api = "http://b") {
  vi.resetModules();
  vi.stubEnv("VITE_API", api);
  vi.stubEnv("VITE_FEE_PAYER", "");
  return import("../fiat");
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;
// Sessions come from auth/session.ts: it asks GET /health for the auth mode first, then
// POST /api/auth/mock (mock mode) for a token that must carry a numeric expiresAt. A fresh
// Response per call: a body can only be read once, and tests share this module scope.
const health = () => json({ authMode: "mock" });
const session = { token: "SESSION", expiresAt: Math.floor(Date.now() / 1000) + 3600 };
const sess = (token: string) => ({ token, expiresAt: session.expiresAt });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("FIAT_AVAILABLE", () => {
  it("is off without VITE_API and on with it", async () => {
    expect((await load("")).FIAT_AVAILABLE).toBe(false);
    expect((await load("http://b")).FIAT_AVAILABLE).toBe(true);
  });

  it("every call explains the missing backend rather than throwing a fetch error", async () => {
    const f = await load("");
    await expect(f.onrampConfig()).rejects.toThrow(/VITE_API/);
    await expect(f.startTopUp("W", "10")).rejects.toThrow(/VITE_API/);
    await expect(f.requestPayout("W", "10")).rejects.toThrow(/VITE_API/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});

describe("normalisePln", () => {
  it("accepts integers and up to two decimals, and a comma as the separator", async () => {
    const { normalisePln } = await load();
    expect(normalisePln("400")).toBe("400");
    expect(normalisePln(" 1200.5 ")).toBe("1200.5");
    expect(normalisePln("99.99")).toBe("99.99");
    expect(normalisePln("12,50")).toBe("12.50");
  });

  it("rejects what the backend's parser rejects, so the error lands next to the input", async () => {
    const { normalisePln } = await load();
    for (const bad of ["", "   ", "-5", "1e3", "NaN", "Infinity", "400.123", "4.5.6", "abc", "0", "0.00", "+5", "1_000"]) {
      expect(normalisePln(bad), bad).toBeNull();
    }
  });
});

describe("previewUsdc", () => {
  it("floors, matching the backend's integer arithmetic rather than disagreeing by a cent", async () => {
    const { previewUsdc } = await load();
    // 400 / 4.30 = 93.0232…
    expect(previewUsdc("400", "4.30")).toBe("93.02");
    expect(previewUsdc("1200", "4.30")).toBe("279.06");
  });

  it("is null for an unusable amount or rate", async () => {
    const { previewUsdc } = await load();
    expect(previewUsdc("abc", "4.30")).toBeNull();
    expect(previewUsdc("400", "0")).toBeNull();
    expect(previewUsdc("400", "not a rate")).toBeNull();
  });
});

describe("amount formatting", () => {
  it("renders base units and grosz without going through a float", async () => {
    const { usdcFromBase, plnFromMinor } = await load();
    expect(usdcFromBase("93023255")).toBe("93.02");
    expect(usdcFromBase("1000000")).toBe("1.00");
    expect(usdcFromBase("0")).toBe("0.00");
    expect(usdcFromBase("")).toBe("0.00");
    expect(usdcFromBase("1234567890123")).toBe("1,234,567.89");
    expect(plnFromMinor("40000")).toBe("400.00");
    expect(plnFromMinor("5")).toBe("0.05");
    expect(plnFromMinor("")).toBe("0.00");
  });
});

describe("topUpReturn", () => {
  it("reads the outcome and intent out of the hash query", async () => {
    const { topUpReturn } = await load();
    expect(topUpReturn("#/app?tab=wallet&topup=done&intent=abc")).toEqual({ outcome: "done", intent: "abc" });
    expect(topUpReturn("#/app?topup=cancelled&intent=xyz")).toEqual({ outcome: "cancelled", intent: "xyz" });
  });

  it("is null when there is nothing to resume, including a half-formed return", async () => {
    const { topUpReturn } = await load();
    expect(topUpReturn("#/app")).toBeNull();
    expect(topUpReturn("")).toBeNull();
    expect(topUpReturn("#/app?tab=wallet")).toBeNull();
    expect(topUpReturn("#/app?topup=done")).toBeNull(); // no intent
    expect(topUpReturn("#/app?topup=weird&intent=abc")).toBeNull();
  });
});

describe("sessionToken", () => {
  it("obtains the session through the shared auth layer and returns its token", async () => {
    fetchMock().mockResolvedValueOnce(health()).mockResolvedValue(json(session));
    const f = await load();
    expect(await f.sessionToken("W1")).toBe("SESSION");
    expect(fetchMock().mock.calls[0][0]).toBe("http://b/health");
    const [url, init] = fetchMock().mock.calls[1];
    expect(url).toBe("http://b/api/auth/mock");
    expect(JSON.parse(init.body)).toEqual({ wallet: "W1" });
  });

  it("fetches once per wallet and caches it", async () => {
    fetchMock().mockResolvedValueOnce(health()).mockResolvedValue(json(session));
    const f = await load();
    expect(await f.sessionToken("W1")).toBe("SESSION");
    expect(await f.sessionToken("W1")).toBe("SESSION");
    expect(fetchMock()).toHaveBeenCalledTimes(2); // health + mock; served from cache after
  });

  it("keeps one session per wallet", async () => {
    fetchMock().mockResolvedValueOnce(health()).mockResolvedValueOnce(json(sess("A"))).mockResolvedValue(json(sess("B")));
    const f = await load();
    expect(await f.sessionToken("W1")).toBe("A");
    expect(await f.sessionToken("W2")).toBe("B");
    expect(fetchMock()).toHaveBeenCalledTimes(3); // one health check (shared) + one mock call per wallet
  });

  it("shares one in-flight request between concurrent callers", async () => {
    fetchMock().mockResolvedValueOnce(health()).mockResolvedValue(json(session));
    const f = await load();
    await Promise.all([f.sessionToken("W1"), f.sessionToken("W1")]);
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure: the next call retries", async () => {
    fetchMock()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(json({ error: "nope" }, 500))
      .mockResolvedValue(json(session)); // the auth-mode answer stays cached; only the mock call is retried
    const f = await load();
    await expect(f.sessionToken("W1")).rejects.toThrow("nope");
    expect(await f.sessionToken("W1")).toBe("SESSION");
  });

  it("forgetSession drops the cache", async () => {
    // A fresh Response per call: a body can only be read once.
    fetchMock().mockResolvedValueOnce(health()).mockImplementation(() => Promise.resolve(json(session)));
    const f = await load();
    await f.sessionToken("W1");
    f.forgetSession("W1");
    await f.sessionToken("W1");
    expect(fetchMock()).toHaveBeenCalledTimes(3); // health, mock, mock again (health stays cached)
  });
});

describe("startTopUp", () => {
  it("sends the amount as a string under a bearer session", async () => {
    fetchMock()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({ url: "http://b/mock/onramp?intent=i1", intent: "i1", amountUsdc: "93.023255" }));
    const f = await load();
    const checkout = await f.startTopUp("W1", "400");
    expect(checkout.intent).toBe("i1");
    const [url, init] = fetchMock().mock.calls[2];
    expect(url).toBe("http://b/api/onramp/checkout");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer SESSION");
    expect(JSON.parse(init.body)).toEqual({ amountPln: "400" });
  });

  it("passes the deposit holdback through only when there is one", async () => {
    fetchMock()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(json(session))
      .mockResolvedValue(json({ url: "u", intent: "i" }));
    const f = await load();
    await f.startTopUp("W1", "400", "50000000");
    expect(JSON.parse(fetchMock().mock.calls[2][1].body)).toEqual({ amountPln: "400", depositHoldbackUsdc: "50000000" });
  });

  it("surfaces the backend's own error text", async () => {
    fetchMock()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({ error: "top up between 10.00 and 5000.00 PLN" }, 400));
    const f = await load();
    await expect(f.startTopUp("W1", "1")).rejects.toThrow("top up between 10.00 and 5000.00 PLN");
  });

  it("falls back to a status message when the body is not JSON", async () => {
    fetchMock()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(new Response("<html>", { status: 502 }));
    const f = await load();
    await expect(f.startTopUp("W1", "400")).rejects.toThrow(/checkout failed \(502\)/);
  });

  it("retries once with a fresh session on a 401, then gives up", async () => {
    fetchMock()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(json(sess("STALE")))
      .mockResolvedValueOnce(json({ error: "session expired" }, 401))
      .mockResolvedValueOnce(json(sess("FRESH")))
      .mockResolvedValueOnce(json({ url: "u", intent: "i" }));
    const f = await load();
    await expect(f.startTopUp("W1", "400")).resolves.toMatchObject({ intent: "i" });
    expect(fetchMock().mock.calls[2][1].headers.authorization).toBe("Bearer STALE");
    expect(fetchMock().mock.calls[4][1].headers.authorization).toBe("Bearer FRESH");
  });

  it("a second 401 is a real failure, not an endless retry", async () => {
    fetchMock()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(json(sess("A")))
      .mockResolvedValueOnce(json({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(json(sess("B")))
      .mockResolvedValueOnce(json({ error: "unauthorized" }, 401));
    const f = await load();
    await expect(f.startTopUp("W1", "400")).rejects.toThrow("unauthorized");
    // health, session, attempt, session refresh, attempt — and no more.
    expect(fetchMock()).toHaveBeenCalledTimes(5);
  });

  it("a session that cannot be reissued fails with the sign-in error, not a loop", async () => {
    fetchMock()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(json(sess("A")))
      .mockResolvedValueOnce(json({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(json({ error: "refusing to issue a session for the fee payer's own address" }, 400));
    const f = await load();
    await expect(f.startTopUp("W1", "400")).rejects.toThrow(/fee payer's own address/);
    expect(fetchMock()).toHaveBeenCalledTimes(4);
  });
});

describe("awaitTopUp", () => {
  const status = (state: string, extra: Record<string, unknown> = {}) => json({ intent: "i1", state, credit: null, ...extra });

  it("polls while the webhook has not landed and returns the credited status", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    fetchMock()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(status("pending"))
      .mockResolvedValueOnce(status("pending"))
      .mockResolvedValueOnce(status("credited", { credit: { amountUsdc: "93023255" } }));
    const f = await load();
    const result = await f.awaitTopUp("W1", "i1", { sleep, pollMs: 1 });
    expect(result.state).toBe("credited");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns a rejection immediately rather than waiting it out", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    fetchMock().mockResolvedValueOnce(health()).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(status("rejected"));
    const f = await load();
    expect((await f.awaitTopUp("W1", "i1", { sleep })).state).toBe("rejected");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up at the timeout and hands back the last pending status", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    fetchMock().mockResolvedValueOnce(health()).mockResolvedValueOnce(json(session)).mockResolvedValue(status("pending"));
    const f = await load();
    // A zero timeout means one read, then the deadline has passed.
    expect((await f.awaitTopUp("W1", "i1", { sleep, timeoutMs: 0 })).state).toBe("pending");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("encodes the intent into the query", async () => {
    fetchMock().mockResolvedValueOnce(health()).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(status("credited"));
    const f = await load();
    await f.topUpStatus("W1", "a b&c");
    expect(fetchMock().mock.calls[2][0]).toBe("http://b/api/onramp/status?intent=a%20b%26c");
  });
});

describe("requestPayout", () => {
  it("posts the amount and destination under a session", async () => {
    fetchMock()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({ simulated: true, reference: "SIM-1" }));
    const f = await load();
    expect((await f.requestPayout("W1", "50", { destination: "PL00" })).reference).toBe("SIM-1");
    const [url, init] = fetchMock().mock.calls[2];
    expect(url).toBe("http://b/api/offramp/payout");
    expect(JSON.parse(init.body)).toEqual({ amountUsdc: "50", destination: "PL00" });
  });

  it("reads the history for the session wallet", async () => {
    fetchMock()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({ simulated: true, receipts: [] }));
    const f = await load();
    expect((await f.payoutHistory("W1")).receipts).toEqual([]);
    expect(fetchMock().mock.calls[2][0]).toBe("http://b/api/offramp/history");
  });
});

describe("onrampConfig", () => {
  it("is fetched without a session, because it holds nothing per-wallet", async () => {
    fetchMock().mockResolvedValueOnce(json({ provider: "mock", simulated: true, plnPerUsdc: "4.30" }));
    const f = await load();
    expect((await f.onrampConfig()).plnPerUsdc).toBe("4.30");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(fetchMock().mock.calls[0][0]).toBe("http://b/api/onramp/config");
  });
});
