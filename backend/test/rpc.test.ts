import "./noenv.ts";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { isRetryableStatus, nextDelayMs, parseRetryAfter, retryingFetch, type RetryConfig } from "../src/rpc.ts";

const cfg = (over: Partial<RetryConfig> = {}): RetryConfig => ({
  maxRetries: 3,
  baseMs: 100,
  maxMs: 1000,
  sleep: async () => {},
  random: () => 0.5,
  ...over,
});

describe("nextDelayMs", () => {
  it("backs off exponentially with jitter in [50%, 100%] of the ceiling", () => {
    assert.equal(nextDelayMs(0, undefined, cfg({ random: () => 0 })), 50);
    assert.equal(nextDelayMs(0, undefined, cfg({ random: () => 0.999999 })), 100);
    assert.equal(nextDelayMs(2, undefined, cfg({ random: () => 0 })), 200);
    assert.equal(nextDelayMs(2, undefined, cfg({ random: () => 0.999999 })), 400);
  });

  it("clamps to maxMs", () => {
    assert.equal(nextDelayMs(20, undefined, cfg({ random: () => 0.999999 })), 1000);
    assert.equal(nextDelayMs(20, undefined, cfg({ random: () => 0 })), 500);
  });

  it("Retry-After wins, clamped to maxMs", () => {
    assert.equal(nextDelayMs(0, 250, cfg()), 250);
    assert.equal(nextDelayMs(0, 0, cfg()), 0);
    assert.equal(nextDelayMs(0, 60_000, cfg()), 1000);
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds", () => {
    assert.equal(parseRetryAfter("2"), 2000);
    assert.equal(parseRetryAfter("0.5"), 500);
    assert.equal(parseRetryAfter("0"), 0);
  });

  it("reads an HTTP date relative to now", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    assert.equal(parseRetryAfter("Wed, 21 Oct 2015 07:28:10 GMT", now), 10_000);
    assert.equal(parseRetryAfter("Wed, 21 Oct 2015 07:27:00 GMT", now), 0, "a date in the past means retry now");
  });

  it("returns undefined for absent or unparseable values", () => {
    assert.equal(parseRetryAfter(undefined), undefined);
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter("   "), undefined);
    assert.equal(parseRetryAfter("soon"), undefined);
  });

  it("never returns a negative delay", () => {
    assert.equal(parseRetryAfter("-5"), 0);
  });
});

describe("isRetryableStatus", () => {
  it("retries 429, 408 and 5xx only", () => {
    for (const s of [429, 408, 500, 502, 503, 599]) assert.equal(isRetryableStatus(s), true, String(s));
    for (const s of [200, 301, 400, 401, 403, 404, 600]) assert.equal(isRetryableStatus(s), false, String(s));
  });
});

describe("retryingFetch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const stub = (responses: Array<Response | Error>) => {
    let calls = 0;
    globalThis.fetch = (async () => {
      const next = responses[calls++];
      if (next === undefined) throw new Error("fetch called more times than stubbed");
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch;
    return { calls: () => calls };
  };

  it("retries a 429 and then succeeds, sleeping per Retry-After", async () => {
    const slept: number[] = [];
    const s = stub([new Response("slow down", { status: 429, headers: { "retry-after": "1" } }), new Response("ok", { status: 200 })]);
    const res = await retryingFetch("http://x.test", undefined, cfg({ sleep: async (ms) => void slept.push(ms) }));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.equal(s.calls(), 2);
    assert.deepEqual(slept, [1000]);
  });

  it("returns the last response once retries are exhausted", async () => {
    const s = stub([1, 2, 3, 4].map(() => new Response("", { status: 503 })));
    const res = await retryingFetch("http://x.test", undefined, cfg({ maxRetries: 3 }));
    assert.equal(res.status, 503);
    assert.equal(s.calls(), 4);
  });

  it("does not retry a non-retryable status", async () => {
    const s = stub([new Response("no", { status: 404 })]);
    const res = await retryingFetch("http://x.test", undefined, cfg());
    assert.equal(res.status, 404);
    assert.equal(s.calls(), 1);
  });

  it("retries a transient network error but not an arbitrary one", async () => {
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const s = stub([reset, new Response("ok")]);
    assert.equal((await retryingFetch("http://x.test", undefined, cfg())).status, 200);
    assert.equal(s.calls(), 2);

    stub([new Error("programmer error")]);
    await assert.rejects(retryingFetch("http://x.test", undefined, cfg()), /programmer error/);
  });
});
