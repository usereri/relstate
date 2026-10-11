import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage } from "./storage";

// session.ts takes API from sponsor.ts, which reads VITE_API at load, so each case re-imports.
async function load(env: { api?: string } = { api: "http://b" }) {
  vi.resetModules();
  vi.stubEnv("VITE_API", env.api ?? "");
  vi.stubEnv("VITE_FEE_PAYER", "");
  return import("../session");
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const NOW = 1_800_000_000; // unix seconds
const session = (token: string, ttl: number) => ({ token, expiresAt: NOW + ttl });
const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

let store: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  vi.stubGlobal("fetch", vi.fn());
  store = stubLocalStorage();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("obtainSession (mock auth mode)", () => {
  it("asks GET /health first, then POSTs { wallet } to /api/auth/mock and returns the token", async () => {
    fetchMock().mockImplementation(async () => json(session("T1", 3600)));
    const s = await load();
    const got = await s.obtainSession("W1");
    expect(got).toEqual({ token: "T1", wallet: "W1", expiresAt: NOW + 3600 });
    expect(fetchMock().mock.calls[0]![0]).toBe("http://b/health");
    const [url, init] = fetchMock().mock.calls[1]!;
    expect(url).toBe("http://b/api/auth/mock");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ wallet: "W1" });
  });

  it("reuses a fresh session without a second request", async () => {
    fetchMock().mockImplementation(async () => json(session("T1", 3600)));
    const s = await load();
    await s.obtainSession("W1");
    expect((await s.obtainSession("W1")).token).toBe("T1");
    expect(fetchMock()).toHaveBeenCalledTimes(2); // health once, mock once; the cached session skips both
  });

  it("persists to storage so a reload reuses it", async () => {
    fetchMock().mockImplementation(async () => json(session("T1", 3600)));
    await (await load()).obtainSession("W1");
    expect(store.has("relstate.session.W1")).toBe(true);
    const reloaded = await load();
    expect((await reloaded.obtainSession("W1")).token).toBe("T1");
    expect(fetchMock()).toHaveBeenCalledTimes(2); // the reload is served entirely from storage
  });

  it("keeps wallets separate", async () => {
    fetchMock().mockImplementation(async () => json(session("T", 3600)));
    const s = await load();
    await s.obtainSession("W1");
    await s.obtainSession("W2");
    expect(fetchMock()).toHaveBeenCalledTimes(3); // one health check (cached across wallets) + one mock call per wallet
  });

  it("shares one in-flight request between concurrent callers", async () => {
    fetchMock().mockImplementation(async () => json(session("T1", 3600)));
    const s = await load();
    const [a, b] = await Promise.all([s.obtainSession("W1"), s.obtainSession("W1")]);
    expect(fetchMock()).toHaveBeenCalledTimes(2); // health once + one mock call, shared between both callers
    expect(a).toBe(b);
  });

  it("does not cache a failure: the next call retries", async () => {
    fetchMock()
      .mockResolvedValueOnce(json({ authMode: "mock" }))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(json(session("T2", 3600)));
    const s = await load();
    await expect(s.obtainSession("W1")).rejects.toThrow("network down");
    expect((await s.obtainSession("W1")).token).toBe("T2");
    expect(fetchMock()).toHaveBeenCalledTimes(3);
  });

  it("renews a session within the 60s skew of expiry rather than returning it", async () => {
    fetchMock()
      .mockResolvedValueOnce(json({ authMode: "mock" }))
      .mockResolvedValueOnce(json(session("OLD", 30)))
      .mockResolvedValueOnce(json(session("NEW", 3600)));
    const s = await load();
    await s.obtainSession("W1");
    expect((await s.obtainSession("W1")).token).toBe("NEW");
    expect(fetchMock()).toHaveBeenCalledTimes(3);
  });

  it("still reuses a session just outside the skew", async () => {
    fetchMock().mockImplementation(async () => json(session("T1", 61)));
    const s = await load();
    await s.obtainSession("W1");
    await s.obtainSession("W1");
    expect(fetchMock()).toHaveBeenCalledTimes(2); // health + one mock call; the second call is served from cache
  });

  it("renews once time passes into the skew window", async () => {
    fetchMock()
      .mockResolvedValueOnce(json({ authMode: "mock" }))
      .mockResolvedValueOnce(json(session("A", 120)))
      .mockResolvedValueOnce(json(session("B", 3600)));
    const s = await load();
    expect((await s.obtainSession("W1")).token).toBe("A");
    vi.setSystemTime((NOW + 61) * 1000);
    expect((await s.obtainSession("W1")).token).toBe("B");
  });

  it("a 404 says the backend is not running in mock auth mode", async () => {
    fetchMock().mockImplementation(async () => new Response("", { status: 404 }));
    await expect((await load()).obtainSession("W1")).rejects.toThrow(/not running in mock auth mode/);
  });

  it("surfaces the backend's error field, else a status message", async () => {
    fetchMock()
      .mockResolvedValueOnce(json({ authMode: "mock" }))
      .mockResolvedValueOnce(json({ error: "wallet banned" }, 403))
      .mockResolvedValueOnce(new Response("x", { status: 500 }));
    const s = await load();
    await expect(s.obtainSession("W1")).rejects.toThrow("wallet banned");
    await expect(s.obtainSession("W1")).rejects.toThrow(/session request failed \(500\)/);
  });

  it("rejects a response without a usable token", async () => {
    fetchMock().mockImplementation(async () => json({ wallet: "W1" }));
    await expect((await load()).obtainSession("W1")).rejects.toThrow(/did not return a session token/);
  });

  it("rejects without VITE_API and makes no request", async () => {
    await expect((await load({})).obtainSession("W1")).rejects.toThrow(/VITE_API/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("ignores a stored session for a different wallet, a corrupt one, or an expired one", async () => {
    fetchMock().mockImplementation(async () => json(session("FRESH", 3600)));
    const s = await load();
    store.set("relstate.session.W1", JSON.stringify({ token: "X", wallet: "OTHER", expiresAt: NOW + 3600 }));
    expect((await s.obtainSession("W1")).token).toBe("FRESH");
    store.set("relstate.session.W2", "{nope");
    expect((await s.obtainSession("W2")).token).toBe("FRESH");
    store.set("relstate.session.W3", JSON.stringify({ token: "X", wallet: "W3", expiresAt: NOW - 5 }));
    expect((await s.obtainSession("W3")).token).toBe("FRESH");
    expect(fetchMock()).toHaveBeenCalledTimes(4); // one health check (cached) + one mock call per wallet
  });
});

describe("clearSession / heldToken", () => {
  it("clearSession drops the cached and stored session, so the next call asks again", async () => {
    fetchMock().mockImplementation(async () => json(session("T", 3600)));
    const s = await load();
    await s.obtainSession("W1");
    s.clearSession("W1");
    expect(store.has("relstate.session.W1")).toBe(false);
    expect(s.heldToken("W1")).toBeNull();
    await s.obtainSession("W1");
    expect(fetchMock()).toHaveBeenCalledTimes(3); // health once (cached) + one mock call per request
  });

  it("heldToken returns a fresh token without touching the network", async () => {
    fetchMock().mockImplementation(async () => json(session("T1", 3600)));
    const s = await load();
    expect(s.heldToken("W1")).toBeNull();
    await s.obtainSession("W1");
    expect(s.heldToken("W1")).toBe("T1");
    expect(fetchMock()).toHaveBeenCalledTimes(2); // health + mock
  });
});

describe("clearSession while a request is in flight", () => {
  /** A fetch the test settles by hand, so the clear lands at a known point. */
  const deferredFetch = () => {
    let settle!: (r: Response) => void;
    fetchMock().mockImplementationOnce(() => new Promise<Response>((r) => (settle = r)));
    return (r: Response) => settle(r);
  };

  it("still serves the in-flight caller, but caches and stores nothing", async () => {
    fetchMock().mockResolvedValueOnce(json({ authMode: "mock" }));
    const settle = deferredFetch();
    const s = await load();
    const pending = s.obtainSession("W1");
    await vi.advanceTimersByTimeAsync(0); // let the health check resolve so the deferred mock request actually starts
    s.clearSession("W1");
    settle(json(session("ABANDONED", 3600)));
    expect((await pending).token).toBe("ABANDONED");
    expect(store.has("relstate.session.W1")).toBe(false);
    expect(s.heldToken("W1")).toBeNull();
  });

  it("a later obtainSession goes back to the network instead of returning the abandoned token", async () => {
    fetchMock().mockResolvedValueOnce(json({ authMode: "mock" }));
    const settle = deferredFetch();
    const s = await load();
    const pending = s.obtainSession("W1");
    await vi.advanceTimersByTimeAsync(0); // let the health check resolve so the deferred mock request actually starts
    s.clearSession("W1");
    settle(json(session("ABANDONED", 3600)));
    await pending;
    fetchMock().mockResolvedValueOnce(json(session("NEW", 3600)));
    expect((await s.obtainSession("W1")).token).toBe("NEW");
    expect(fetchMock()).toHaveBeenCalledTimes(3); // health + the abandoned mock call + the fresh one (authMode stays cached)
  });

  it("a request started after the clear is the one that gets cached, whichever settles last", async () => {
    fetchMock().mockResolvedValueOnce(json({ authMode: "mock" }));
    const settleOld = deferredFetch();
    const s = await load();
    const old = s.obtainSession("W1");
    s.clearSession("W1");
    const settleNew = deferredFetch();
    const next = s.obtainSession("W1");
    await vi.advanceTimersByTimeAsync(0); // let the health check resolve so both deferred mock requests actually start
    settleNew(json(session("NEW", 3600)));
    await next;
    settleOld(json(session("OLD", 3600)));
    await old;
    expect(s.heldToken("W1")).toBe("NEW");
    expect(JSON.parse(store.get("relstate.session.W1")!).token).toBe("NEW");
  });

  it("a failure of an abandoned request does not disturb the replacement in flight", async () => {
    fetchMock().mockResolvedValueOnce(json({ authMode: "mock" }));
    const s = await load();
    let failOld!: (e: Error) => void;
    fetchMock().mockImplementationOnce(() => new Promise<Response>((_, rej) => (failOld = rej)));
    const old = s.obtainSession("W1");
    s.clearSession("W1");
    const settleNew = deferredFetch();
    const next = s.obtainSession("W1");
    await vi.advanceTimersByTimeAsync(0); // let the health check resolve so both deferred mock requests actually start
    failOld(new Error("late failure"));
    await expect(old).rejects.toThrow("late failure");
    // the replacement is still the registered in-flight request: a third caller joins it
    const joined = s.obtainSession("W1");
    settleNew(json(session("NEW", 3600)));
    expect((await next).token).toBe("NEW");
    expect(await joined).toBe(await next);
  });

  it("without a clear, the resolved session is cached and stored", async () => {
    fetchMock().mockResolvedValueOnce(json({ authMode: "mock" }));
    const settle = deferredFetch();
    const s = await load();
    const pending = s.obtainSession("W1");
    await vi.advanceTimersByTimeAsync(0); // let the health check resolve so the deferred mock request actually starts
    settle(json(session("T1", 3600)));
    await pending;
    expect(s.heldToken("W1")).toBe("T1");
    expect(JSON.parse(store.get("relstate.session.W1")!)).toEqual({ token: "T1", wallet: "W1", expiresAt: NOW + 3600 });
  });
});

describe("wallet echoed by the backend", () => {
  it("a session issued for a different wallet throws and is not cached", async () => {
    fetchMock().mockImplementation(async () => json({ ...session("T", 3600), wallet: "OTHER" }));
    const s = await load();
    await expect(s.obtainSession("W1")).rejects.toThrow("The backend issued a session for OTHER instead of W1.");
    expect(s.heldToken("W1")).toBeNull();
    expect(store.size).toBe(0);
  });

  it("a matching wallet is accepted", async () => {
    fetchMock().mockImplementation(async () => json({ ...session("T", 3600), wallet: "W1" }));
    expect((await (await load()).obtainSession("W1")).token).toBe("T");
  });

  // The check is deliberately conditional: a backend that does not echo the wallet is still fine.
  it("a response omitting wallet entirely is still accepted", async () => {
    fetchMock().mockImplementation(async () => json(session("T", 3600)));
    expect((await (await load()).obtainSession("W1")).wallet).toBe("W1");
  });
});

describe("without localStorage (node)", () => {
  it("still obtains and reuses a session from memory", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => json(session("T1", 3600))));
    expect(typeof localStorage).toBe("undefined");
    const s = await load();
    await s.obtainSession("W1");
    await s.obtainSession("W1");
    expect(fetchMock()).toHaveBeenCalledTimes(2); // health once + one mock call; the second call is cached
    expect(() => s.clearSession("W1")).not.toThrow();
  });
});

describe("obtainSession (wallet auth mode)", () => {
  const APP_ORIGIN = "http://localhost:3000";
  beforeEach(() => {
    // session.ts checks the challenge's URI against window.location.origin; the node test
    // environment has no window at all, so the app's own origin is stubbed here.
    vi.stubGlobal("window", { location: { origin: APP_ORIGIN } });
  });

  const CHALLENGE = (wallet: string, origin = APP_ORIGIN) =>
    [
      "example.test wants you to sign in with your Solana account:",
      wallet,
      "",
      "Sign in to relstate. This proves you control the wallet and costs nothing.",
      "",
      `URI: ${origin}`,
      "Nonce: abc123",
      "Issued At: 2026-01-01T00:00:00.000Z",
      "Expiration Time: 2026-01-01T00:05:00.000Z",
    ].join("\n");

  function registerSignerCapture(s: Awaited<ReturnType<typeof load>>, wallet: string) {
    const calls: Uint8Array[] = [];
    s.registerSigner(wallet, async (message: Uint8Array) => {
      calls.push(message);
      return new Uint8Array([9, 9, 9]);
    });
    return calls;
  }

  it("challenges, signs the exact bytes, verifies, and stores the session", async () => {
    const wallet = "W1";
    const challenge = CHALLENGE(wallet);
    fetchMock()
      .mockResolvedValueOnce(json({ authMode: "wallet" })) // GET /health
      .mockResolvedValueOnce(json({ message: challenge })) // POST /api/auth/challenge
      .mockResolvedValueOnce(json({ ...session("WT", 3600), wallet })); // POST /api/auth/verify
    const s = await load();
    const calls = registerSignerCapture(s, wallet);
    const got = await s.obtainSession(wallet);
    expect(got).toEqual({ token: "WT", wallet, expiresAt: NOW + 3600 });

    expect(fetchMock().mock.calls[0]![0]).toBe("http://b/health");
    const [challengeUrl, challengeInit] = fetchMock().mock.calls[1]!;
    expect(challengeUrl).toBe("http://b/api/auth/challenge");
    expect(JSON.parse(challengeInit.body)).toEqual({ wallet });

    expect(calls).toHaveLength(1);
    expect(new TextDecoder().decode(calls[0])).toBe(challenge);

    const [verifyUrl, verifyInit] = fetchMock().mock.calls[2]!;
    expect(verifyUrl).toBe("http://b/api/auth/verify");
    const body = JSON.parse(verifyInit.body);
    expect(body.wallet).toBe(wallet);
    expect(body.signature).toBe(btoa(String.fromCharCode(9, 9, 9)));

    expect(store.has(`relstate.session.${wallet}`)).toBe(true);
  });

  it("refuses to sign a challenge naming a different wallet", async () => {
    const wallet = "W1";
    fetchMock()
      .mockResolvedValueOnce(json({ authMode: "wallet" }))
      .mockResolvedValueOnce(json({ message: CHALLENGE("SOMEONE-ELSE") }));
    const s = await load();
    const calls = registerSignerCapture(s, wallet);
    await expect(s.obtainSession(wallet)).rejects.toThrow(/does not match this wallet and site/);
    expect(calls).toHaveLength(0);
  });

  it("refuses to sign a challenge naming another origin", async () => {
    const wallet = "W1";
    fetchMock()
      .mockResolvedValueOnce(json({ authMode: "wallet" }))
      .mockResolvedValueOnce(json({ message: CHALLENGE(wallet, "https://evil.test") }));
    const s = await load();
    const calls = registerSignerCapture(s, wallet);
    await expect(s.obtainSession(wallet)).rejects.toThrow(/does not match this wallet and site/);
    expect(calls).toHaveLength(0);
  });

  it("gives a clear error when no signer is registered for the wallet", async () => {
    fetchMock().mockResolvedValueOnce(json({ authMode: "wallet" }));
    const s = await load();
    await expect(s.obtainSession("UNREGISTERED")).rejects.toThrow(/cannot sign messages, so it cannot log in/);
  });

  it("re-login after a cleared session requests a brand new challenge", async () => {
    const wallet = "W1";
    fetchMock()
      .mockResolvedValueOnce(json({ authMode: "wallet" }))
      .mockResolvedValueOnce(json({ message: CHALLENGE(wallet) }))
      .mockResolvedValueOnce(json({ ...session("WT1", 3600), wallet }))
      .mockResolvedValueOnce(json({ message: CHALLENGE(wallet) })) // authMode is cached, so no second /health call
      .mockResolvedValueOnce(json({ ...session("WT2", 3600), wallet }));
    const s = await load();
    registerSignerCapture(s, wallet);
    expect((await s.obtainSession(wallet)).token).toBe("WT1");
    s.clearSession(wallet);
    expect((await s.obtainSession(wallet)).token).toBe("WT2");
    // health, challenge 1, verify 1, challenge 2, verify 2
    expect(fetchMock()).toHaveBeenCalledTimes(5);
  });
});
