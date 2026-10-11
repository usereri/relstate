import "./noenv.ts";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { env } from "../src/env.ts";
import { ASSOCIATED_TOKEN_PROGRAM, RELSTATE_PROGRAM, TOKEN_2022_PROGRAM } from "../src/contracts.ts";
import { createRpcProxy, RPC_PROXY_MAX_BODY_BYTES, type RpcProxyOptions } from "../src/rpcproxy.ts";

const { createApp } = await import("../src/server.ts");

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const UPSTREAM = "https://x.test/?api-key=SECRETKEY123456SUPERSECRET";
const UPSTREAM_SECRET = "SECRETKEY123456SUPERSECRET";

type FetchCall = { url: string; init: RequestInit | undefined };

/** A fake `fetch` that replays a scripted response (or error) and records every call made to it. */
function fakeFetch(script: Array<Response | Error | ((call: FetchCall) => Response | Promise<Response>)>) {
  const calls: FetchCall[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url: String(url), init };
    calls.push(call);
    const next = script[calls.length - 1];
    if (next === undefined) throw new Error("fetch called more times than scripted");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(call);
    return next;
  }) as typeof fetch;
  return { fn, calls };
}

const proxyOf = (over: Partial<RpcProxyOptions> = {}) => createRpcProxy({ upstreamUrl: () => UPSTREAM, ...over });

const noLimit = () => {};

const req = (method: string, params: unknown[] = [], id: string | number | null = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

describe("createRpcProxy: method allowlist", () => {
  it("allows a plain read", async () => {
    const { fn, calls } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: null } }), { status: 200 })]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(req("getAccountInfo", ["11111111111111111111111111111111"]), noLimit);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
  });

  for (const method of ["sendTransaction", "requestAirdrop", "signatureSubscribe", "unknownMethod", "__proto__", "constructor"]) {
    it(`rejects ${method} without calling upstream`, async () => {
      const { fn, calls } = fakeFetch([]);
      const proxy = proxyOf({ fetch: fn });
      const res = await proxy.handle(req(method, []), noLimit);
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0, "upstream must not be called for a disallowed method");
      const body = JSON.parse(res.body) as { error: { message: string } };
      assert.match(body.error.message, /not allowed/);
    });
  }

  it("rejects getProgramAccounts for a program id not in the allowlist", async () => {
    const { fn, calls } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const randomProgram = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
    const res = await proxy.handle(req("getProgramAccounts", [randomProgram, { filters: [{ dataSize: 1 }] }]), noLimit);
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  it("rejects getProgramAccounts without filters", async () => {
    const { fn, calls } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(req("getProgramAccounts", [RELSTATE_PROGRAM, {}]), noLimit);
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  it("allows getProgramAccounts for any allowlisted program with filters", async () => {
    for (const program of [RELSTATE_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ASSOCIATED_TOKEN_PROGRAM]) {
      const { fn } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), { status: 200 })]);
      const proxy = proxyOf({ fetch: fn });
      const res = await proxy.handle(req("getProgramAccounts", [program, { filters: [{ dataSize: 1 }] }]), noLimit);
      assert.equal(res.status, 200, program);
    }
  });

  it("rejects getMultipleAccounts with more than 100 items", async () => {
    const { fn, calls } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const items = Array.from({ length: 101 }, () => "11111111111111111111111111111111");
    const res = await proxy.handle(req("getMultipleAccounts", [items]), noLimit);
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  it("allows getMultipleAccounts with exactly 100 items", async () => {
    const { fn } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } }), { status: 200 })]);
    const proxy = proxyOf({ fetch: fn });
    const items = Array.from({ length: 100 }, () => "11111111111111111111111111111111");
    const res = await proxy.handle(req("getMultipleAccounts", [items]), noLimit);
    assert.equal(res.status, 200);
  });
});

describe("createRpcProxy: batch caps", () => {
  it("rejects a batch larger than the max", async () => {
    const { fn, calls } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const batch = Array.from({ length: 11 }, (_, i) => JSON.parse(req("getSlot", [], i)));
    const res = await proxy.handle(JSON.stringify(batch), noLimit);
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  it("rejects the whole batch when one entry carries a disallowed method", async () => {
    const { fn, calls } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const batch = [JSON.parse(req("getSlot", [], 1)), JSON.parse(req("sendTransaction", [], 2))];
    const res = await proxy.handle(JSON.stringify(batch), noLimit);
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0, "a rejected batch must never reach upstream");
  });

  it("allows a batch at the max size", async () => {
    const { fn } = fakeFetch([new Response(JSON.stringify([{ jsonrpc: "2.0", id: 1, result: 1 }]), { status: 200 })]);
    const proxy = proxyOf({ fetch: fn });
    const batch = Array.from({ length: 10 }, (_, i) => JSON.parse(req("getSlot", [], i)));
    const res = await proxy.handle(JSON.stringify(batch), noLimit);
    assert.equal(res.status, 200);
  });
});

describe("createRpcProxy: per-IP limit via the limit callback", () => {
  it("propagates whatever the limit callback throws, before touching upstream", async () => {
    const { fn, calls } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    class Blocked extends Error {}
    const limit = () => {
      throw new Blocked("too many calls");
    };
    await assert.rejects(proxy.handle(req("getSlot"), limit), Blocked);
    assert.equal(calls.length, 0, "upstream must not be called once the limiter rejects");
  });

  it("is called once per request for a single call, and once per item for a batch", async () => {
    const { fn } = fakeFetch([
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200 }),
      new Response(JSON.stringify([{ jsonrpc: "2.0", id: 1, result: 1 }]), { status: 200 }),
    ]);
    const proxy = proxyOf({ fetch: fn });
    const weights: number[] = [];
    await proxy.handle(req("getSlot"), (n) => weights.push(n));
    const batch = Array.from({ length: 3 }, (_, i) => JSON.parse(req("getSlot", [], i)));
    await proxy.handle(JSON.stringify(batch), (n) => weights.push(n));
    assert.deepEqual(weights, [1, 3]);
  });
});

describe("createRpcProxy: upstream key never leaks", () => {
  it("never appears when upstream returns an error status", async () => {
    const { fn } = fakeFetch([new Response("internal error, upstream was https://x.test/?api-key=SECRETKEY123456SUPERSECRET", { status: 500 })]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(req("getSlot"), noLimit);
    assert.equal(res.status, 502);
    assert.ok(!res.body.includes(UPSTREAM_SECRET));
    assert.ok(!res.body.includes(UPSTREAM));
  });

  it("never appears when upstream throws", async () => {
    const { fn } = fakeFetch([new Error(`network error reaching ${UPSTREAM}`)]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(req("getSlot"), noLimit);
    assert.equal(res.status, 502);
    assert.ok(!res.body.includes(UPSTREAM_SECRET));
  });

  it("scrubs the key when upstream echoes it back in a 200 body", async () => {
    const { fn } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: UPSTREAM }), { status: 200 })]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(req("getSlot"), noLimit);
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes(UPSTREAM_SECRET));
    assert.ok(res.body.includes("<redacted>"));
  });

  it("passes through 429 with retry-after, never the upstream URL", async () => {
    const { fn } = fakeFetch([new Response(`rate limited by ${UPSTREAM}`, { status: 429, headers: { "retry-after": "7" } })]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(req("getSlot"), noLimit);
    assert.equal(res.status, 429);
    assert.equal(res.retryAfter, "7");
    assert.ok(!res.body.includes(UPSTREAM_SECRET));
  });

  it("maps a 500 to a generic 502 with no upstream detail", async () => {
    const { fn } = fakeFetch([new Response("boom", { status: 500 })]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(req("getSlot"), noLimit);
    assert.equal(res.status, 502);
    assert.ok(!res.body.includes("boom"));
  });

  it("times out without leaking the upstream URL", async () => {
    const { fn } = fakeFetch([
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        }),
    ]);
    const proxy = proxyOf({ fetch: fn, timeoutMs: 20 });
    const res = await proxy.handle(req("getSlot"), noLimit);
    assert.equal(res.status, 502);
    assert.ok(!res.body.includes(UPSTREAM_SECRET));
  });

  it("rebuilds the upstream request: unknown client fields are not forwarded", async () => {
    let sentBody = "";
    const { fn } = fakeFetch([
      (call) => {
        sentBody = String(call.init?.body ?? "");
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200 });
      },
    ]);
    const proxy = proxyOf({ fetch: fn });
    const raw = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [], evil: "DROP TABLE", extra: { nested: true } });
    const res = await proxy.handle(raw, noLimit);
    assert.equal(res.status, 200);
    assert.ok(!sentBody.includes("evil"));
    assert.ok(!sentBody.includes("DROP TABLE"));
    assert.ok(!sentBody.includes("nested"));
    assert.deepEqual(JSON.parse(sentBody), { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] });
  });
});

describe("POST /api/rpc through createApp", () => {
  it("413s a body over the cap, and never reaches upstream", async () => {
    const { fn, calls } = fakeFetch([]);
    const app = createApp(undefined, undefined, createRpcProxy({ upstreamUrl: () => UPSTREAM, fetch: fn }));
    const filler = "a".repeat(RPC_PROXY_MAX_BODY_BYTES + 1024);
    const res = await app.request("/api/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [filler] }),
    });
    assert.equal(res.status, 413);
    assert.equal(calls.length, 0);
  });

  it("proxies an allowed call end to end", async () => {
    const { fn } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: null } }), { status: 200 })]);
    const app = createApp(undefined, undefined, createRpcProxy({ upstreamUrl: () => UPSTREAM, fetch: fn }));
    const res = await app.request("/api/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: req("getAccountInfo", ["11111111111111111111111111111111"]),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(UPSTREAM_SECRET));
  });

  it("rejects a disallowed method before touching upstream", async () => {
    const { fn, calls } = fakeFetch([]);
    const app = createApp(undefined, undefined, createRpcProxy({ upstreamUrl: () => UPSTREAM, fetch: fn }));
    const res = await app.request("/api/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: req("sendTransaction", ["AAAA"]),
    });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  describe("per-IP rate limit", () => {
    const original = env.rpcProxyRatePerMinute;
    afterEach(() => {
      (env as unknown as { rpcProxyRatePerMinute: number }).rpcProxyRatePerMinute = original;
    });

    it("429s once the per-minute limit is exceeded, with retry unaffected by the upstream", async () => {
      (env as unknown as { rpcProxyRatePerMinute: number }).rpcProxyRatePerMinute = 2;
      const { fn } = fakeFetch([
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200 }),
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200 }),
      ]);
      const app = createApp(undefined, undefined, createRpcProxy({ upstreamUrl: () => UPSTREAM, fetch: fn }));
      const send = () =>
        app.request("/api/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: req("getSlot"),
        });
      assert.equal((await send()).status, 200);
      assert.equal((await send()).status, 200);
      const third = await send();
      assert.equal(third.status, 429);
      const body = (await third.json()) as { code: string; scope: string };
      assert.equal(body.code, "rate-limited");
      assert.equal(body.scope, "ip");
    });
  });
});
