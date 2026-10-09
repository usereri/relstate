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

describe("obtainSession", () => {
  it("POSTs { wallet } to /api/auth/mock and returns the token", async () => {
    fetchMock().mockResolvedValue(json(session("T1", 3600)));
    const s = await load();
    const got = await s.obtainSession("W1");
    expect(got).toEqual({ token: "T1", wallet: "W1", expiresAt: NOW + 3600 });
    const [url, init] = fetchMock().mock.calls[0];
    expect(url).toBe("http://b/api/auth/mock");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ wallet: "W1" });
  });

  it("reuses a fresh session without a second request", async () => {
    fetchMock().mockResolvedValue(json(session("T1", 3600)));
    const s = await load();
    await s.obtainSession("W1");
    expect((await s.obtainSession("W1")).token).toBe("T1");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("persists to storage so a reload reuses it", async () => {
    fetchMock().mockResolvedValue(json(session("T1", 3600)));
    await (await load()).obtainSession("W1");
    expect(store.has("relstate.session.W1")).toBe(true);
    const reloaded = await load();
    expect((await reloaded.obtainSession("W1")).token).toBe("T1");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("keeps wallets separate", async () => {
    fetchMock().mockImplementation(async () => json(session("T", 3600)));
    const s = await load();
    await s.obtainSession("W1");
    await s.obtainSession("W2");
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    fetchMock().mockResolvedValue(json(session("T1", 3600)));
    const s = await load();
    const [a, b] = await Promise.all([s.obtainSession("W1"), s.obtainSession("W1")]);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("does not cache a failure: the next call retries", async () => {
    fetchMock().mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(json(session("T2", 3600)));
    const s = await load();
    await expect(s.obtainSession("W1")).rejects.toThrow("network down");
    expect((await s.obtainSession("W1")).token).toBe("T2");
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("renews a session within the 60s skew of expiry rather than returning it", async () => {
    fetchMock().mockResolvedValueOnce(json(session("OLD", 30))).mockResolvedValueOnce(json(session("NEW", 3600)));
    const s = await load();
    await s.obtainSession("W1");
    expect((await s.obtainSession("W1")).token).toBe("NEW");
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("still reuses a session just outside the skew", async () => {
    fetchMock().mockResolvedValue(json(session("T1", 61)));
    const s = await load();
    await s.obtainSession("W1");
    await s.obtainSession("W1");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("renews once time passes into the skew window", async () => {
    fetchMock().mockResolvedValueOnce(json(session("A", 120))).mockResolvedValueOnce(json(session("B", 3600)));
    const s = await load();
    expect((await s.obtainSession("W1")).token).toBe("A");
    vi.setSystemTime((NOW + 61) * 1000);
    expect((await s.obtainSession("W1")).token).toBe("B");
  });

  it("a 404 says the backend is not running in mock auth mode", async () => {
    fetchMock().mockResolvedValue(new Response("", { status: 404 }));
    await expect((await load()).obtainSession("W1")).rejects.toThrow(/not running in mock auth mode/);
  });

  it("surfaces the backend's error field, else a status message", async () => {
    fetchMock().mockResolvedValueOnce(json({ error: "wallet banned" }, 403)).mockResolvedValueOnce(new Response("x", { status: 500 }));
    const s = await load();
    await expect(s.obtainSession("W1")).rejects.toThrow("wallet banned");
    await expect(s.obtainSession("W1")).rejects.toThrow(/session request failed \(500\)/);
  });

  it("rejects a response without a usable token", async () => {
    fetchMock().mockResolvedValue(json({ wallet: "W1" }));
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
    expect(fetchMock()).toHaveBeenCalledTimes(3);
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
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("heldToken returns a fresh token without touching the network", async () => {
    fetchMock().mockResolvedValue(json(session("T1", 3600)));
    const s = await load();
    expect(s.heldToken("W1")).toBeNull();
    await s.obtainSession("W1");
    expect(s.heldToken("W1")).toBe("T1");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
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
    const settle = deferredFetch();
    const s = await load();
    const pending = s.obtainSession("W1");
    s.clearSession("W1");
    settle(json(session("ABANDONED", 3600)));
    expect((await pending).token).toBe("ABANDONED");
    expect(store.has("relstate.session.W1")).toBe(false);
    expect(s.heldToken("W1")).toBeNull();
  });

  it("a later obtainSession goes back to the network instead of returning the abandoned token", async () => {
    const settle = deferredFetch();
    const s = await load();
    const pending = s.obtainSession("W1");
    s.clearSession("W1");
    settle(json(session("ABANDONED", 3600)));
    await pending;
    fetchMock().mockResolvedValueOnce(json(session("NEW", 3600)));
    expect((await s.obtainSession("W1")).token).toBe("NEW");
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("a request started after the clear is the one that gets cached, whichever settles last", async () => {
    const settleOld = deferredFetch();
    const s = await load();
    const old = s.obtainSession("W1");
    s.clearSession("W1");
    const settleNew = deferredFetch();
    const next = s.obtainSession("W1");
    settleNew(json(session("NEW", 3600)));
    await next;
    settleOld(json(session("OLD", 3600)));
    await old;
    expect(s.heldToken("W1")).toBe("NEW");
    expect(JSON.parse(store.get("relstate.session.W1")!).token).toBe("NEW");
  });

  it("a failure of an abandoned request does not disturb the replacement in flight", async () => {
    const s = await load();
    let failOld!: (e: Error) => void;
    fetchMock().mockImplementationOnce(() => new Promise<Response>((_, rej) => (failOld = rej)));
    const old = s.obtainSession("W1");
    s.clearSession("W1");
    const settleNew = deferredFetch();
    const next = s.obtainSession("W1");
    failOld(new Error("late failure"));
    await expect(old).rejects.toThrow("late failure");
    // the replacement is still the registered in-flight request: a third caller joins it
    const joined = s.obtainSession("W1");
    settleNew(json(session("NEW", 3600)));
    expect((await next).token).toBe("NEW");
    expect(await joined).toBe(await next);
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("without a clear, the resolved session is cached and stored", async () => {
    const settle = deferredFetch();
    const s = await load();
    const pending = s.obtainSession("W1");
    settle(json(session("T1", 3600)));
    await pending;
    expect(s.heldToken("W1")).toBe("T1");
    expect(JSON.parse(store.get("relstate.session.W1")!)).toEqual({ token: "T1", wallet: "W1", expiresAt: NOW + 3600 });
  });
});

describe("wallet echoed by the backend", () => {
  it("a session issued for a different wallet throws and is not cached", async () => {
    fetchMock().mockResolvedValue(json({ ...session("T", 3600), wallet: "OTHER" }));
    const s = await load();
    await expect(s.obtainSession("W1")).rejects.toThrow("The backend issued a session for OTHER instead of W1.");
    expect(s.heldToken("W1")).toBeNull();
    expect(store.size).toBe(0);
  });

  it("a matching wallet is accepted", async () => {
    fetchMock().mockResolvedValue(json({ ...session("T", 3600), wallet: "W1" }));
    expect((await (await load()).obtainSession("W1")).token).toBe("T");
  });

  // The check is deliberately conditional: a backend that does not echo the wallet is still fine.
  it("a response omitting wallet entirely is still accepted", async () => {
    fetchMock().mockResolvedValue(json(session("T", 3600)));
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
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(() => s.clearSession("W1")).not.toThrow();
  });
});
