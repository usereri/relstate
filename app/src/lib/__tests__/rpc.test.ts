import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryOn429, retryingFetch } from "../rpc";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Attaches the rejection handler before timers run, so a failing run never reports it as unhandled.
const settle = async <T>(p: Promise<T>) => {
  const out = p.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return out;
};

const err429 = () => Object.assign(new Error("boom"), { context: { statusCode: 429 } });

describe("retryOn429", () => {
  it("returns on first success without retrying", async () => {
    const t = vi.fn(async () => "ok");
    expect(await retryOn429(t)()).toBe("ok");
    expect(t).toHaveBeenCalledTimes(1);
  });

  it("retries a thrown context.statusCode 429, then succeeds", async () => {
    const t = vi.fn().mockRejectedValueOnce(err429()).mockRejectedValueOnce(err429()).mockResolvedValue("ok");
    expect(await settle(retryOn429(t)())).toEqual({ value: "ok" });
    expect(t).toHaveBeenCalledTimes(3);
  });

  it.each(["HTTP 429 returned", "Too Many Requests"])("retries on message %j", async (msg) => {
    const t = vi.fn().mockRejectedValueOnce(new Error(msg)).mockResolvedValue("ok");
    expect(await settle(retryOn429(t)())).toEqual({ value: "ok" });
    expect(t).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["500 status", Object.assign(new Error("server"), { context: { statusCode: 500 } })],
    ["plain error", new Error("blockhash not found")],
    ["number containing 429", new Error("slot 14290 failed")],
  ])("does not retry %s", async (_n, e) => {
    const t = vi.fn().mockRejectedValue(e);
    const r = await settle(retryOn429(t)());
    expect((r as any).error).toBe(e);
    expect(t).toHaveBeenCalledTimes(1);
  });

  it("gives up after 6 attempts and rethrows the 429", async () => {
    const e = err429();
    const t = vi.fn().mockRejectedValue(e);
    const r = await settle(retryOn429(t)());
    expect((r as any).error).toBe(e);
    expect(t).toHaveBeenCalledTimes(6);
  });

  it("passes arguments through", async () => {
    const t = vi.fn(async (a: number, b: number) => a + b);
    expect(await retryOn429(t)(2, 3)).toBe(5);
  });
});

describe("retryingFetch", () => {
  const res = (status: number, headers: Record<string, string> = {}) => new Response("", { status, headers });

  it("retries 429 then returns the good response", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200));
    vi.stubGlobal("fetch", f);
    const r = (await settle(retryingFetch("http://x"))) as any;
    expect(r.value.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not retry other statuses", async () => {
    const f = vi.fn().mockResolvedValue(res(500));
    vi.stubGlobal("fetch", f);
    const r = (await settle(retryingFetch("http://x"))) as any;
    expect(r.value.status).toBe(500);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("returns the last 429 after 6 attempts", async () => {
    const f = vi.fn().mockImplementation(async () => res(429));
    vi.stubGlobal("fetch", f);
    const r = (await settle(retryingFetch("http://x"))) as any;
    expect(r.value.status).toBe(429);
    expect(f).toHaveBeenCalledTimes(6);
  });

  it("honours Retry-After (seconds)", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(429, { "retry-after": "2" })).mockResolvedValueOnce(res(200));
    vi.stubGlobal("fetch", f);
    const p = retryingFetch("http://x");
    await vi.advanceTimersByTimeAsync(1999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).status).toBe(200);
  });
});
