import { beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateReads, sharedRead } from "../reads";

// The cache is module-level state shared by every caller (that is the point of it), so each test
// must start from empty, or an earlier test's entry under the same key leaks in.
beforeEach(() => invalidateReads());

describe("sharedRead", () => {
  it("shares one load between concurrent callers using the same key", async () => {
    let calls = 0;
    const load = vi.fn(async () => {
      calls++;
      return "value";
    });
    const [a, b, c] = await Promise.all([sharedRead("k", load), sharedRead("k", load), sharedRead("k", load)]);
    expect(calls).toBe(1);
    expect([a, b, c]).toEqual(["value", "value", "value"]);
  });

  it("serves a second call from cache within the TTL, with no second load", async () => {
    const load = vi.fn(async () => "value");
    let now = 0;
    await sharedRead("k", load, 10_000, () => now);
    now += 5_000; // still inside the 10s TTL
    const second = await sharedRead("k", load, 10_000, () => now);
    expect(second).toBe("value");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reloads once the TTL has passed", async () => {
    let now = 0;
    const load = vi.fn(async () => `value-at-${now}`);
    const first = await sharedRead("k", load, 10_000, () => now);
    now = 10_001; // just past the TTL
    const second = await sharedRead("k", load, 10_000, () => now);
    expect(first).toBe("value-at-0");
    expect(second).toBe("value-at-10001");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("invalidateReads forces the next read to reload, even inside the TTL", async () => {
    let now = 0;
    const load = vi.fn(async () => `value-at-${now}`);
    await sharedRead("k", load, 10_000, () => now);
    now += 1; // nowhere near the TTL
    invalidateReads();
    const second = await sharedRead("k", load, 10_000, () => now);
    expect(second).toBe("value-at-1");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache a rejected load: the next call tries again", async () => {
    let fail = true;
    const load = vi.fn(async () => {
      if (fail) throw new Error("boom");
      return "value";
    });
    await expect(sharedRead("k2", load)).rejects.toThrow("boom");
    fail = false;
    const result = await sharedRead("k2", load);
    expect(result).toBe("value");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache a result that resolves after an invalidation arrived mid-flight", async () => {
    let resolveLoad: (v: string) => void;
    const slow = new Promise<string>((res) => {
      resolveLoad = res;
    });
    const load = vi.fn(() => slow);
    const pending = sharedRead("k3", load);
    invalidateReads(); // arrives while the load is still in flight
    resolveLoad!("stale");
    await expect(pending).resolves.toBe("stale"); // the in-flight caller still gets its answer
    // but the stale value must not have been cached under the key: a fresh call reloads.
    const load2 = vi.fn(async () => "fresh");
    const next = await sharedRead("k3", load2);
    expect(next).toBe("fresh");
    expect(load2).toHaveBeenCalledTimes(1);
  });

  it("simulates 5 callers polling the same key every 10s for 60s: at most ceil(60/10) + 1 loads", async () => {
    let now = 0;
    let calls = 0;
    const load = vi.fn(async () => {
      calls++;
      return "value";
    });
    const ticks = 6; // 0, 10s, 20s, 30s, 40s, 50s over a 60s window
    for (let tick = 0; tick < ticks; tick++) {
      now = tick * 10_000;
      await Promise.all(Array.from({ length: 5 }, () => sharedRead("poll-key", load, 10_000, () => now)));
    }
    // One load per tick (every caller in a tick shares it), and ticks land exactly on the TTL
    // boundary, so a tick can occasionally still be "within" the previous entry depending on the
    // strict `<` comparison — either way it is bounded by one load per tick, never one per caller.
    expect(calls).toBeLessThanOrEqual(ticks);
    expect(calls).toBeGreaterThan(0);
  });
});
