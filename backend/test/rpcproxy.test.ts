import "./noenv.ts";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getBase58Decoder } from "@solana/kit";
import { env } from "../src/env.ts";
import { ASSOCIATED_TOKEN_PROGRAM, RELSTATE_PROGRAM, TOKEN_2022_PROGRAM } from "../src/contracts.ts";
import { createRpcLimiter, createRpcProxy, RpcRateLimited, RPC_PROXY_MAX_BODY_BYTES, type RpcProxyOptions } from "../src/rpcproxy.ts";

const { createApp } = await import("../src/server.ts");

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const UPSTREAM = "https://x.test/?api-key=SECRETKEY123456SUPERSECRET";
const UPSTREAM_SECRET = "SECRETKEY123456SUPERSECRET";

// A valid base58 string that decodes to exactly N bytes, for the discriminator / pubkey memcmp
// filters getProgramAccounts requires. Built from real bytes rather than hand-picked strings so the
// byte length is exactly right (base58 does not map 1:1 to bytes).
const b58 = getBase58Decoder();
const base58Of = (byte: number, n: number) => b58.decode(new Uint8Array(n).fill(byte));
const DISCRIMINATOR = base58Of(7, 8); // offset 0, 8 bytes: selects an account type
const OWNER_PUBKEY = base58Of(9, 32); // offset 8, 32 bytes: the shape the app's reader.account.*.all() sends alongside it
const SHORT_BYTES = base58Of(3, 7); // 7 bytes: not a valid discriminator length

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

const noAdmit = () => {};

const req = (method: string, params: unknown[] = [], id: string | number | null = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

describe("createRpcProxy: method allowlist", () => {
  it("allows a plain read", async () => {
    const { fn, calls } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: null } }), { status: 200 })]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(req("getAccountInfo", ["11111111111111111111111111111111"]), noAdmit);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
  });

  for (const method of ["sendTransaction", "requestAirdrop", "signatureSubscribe", "unknownMethod", "__proto__", "constructor"]) {
    it(`rejects ${method} without calling upstream`, async () => {
      const { fn, calls } = fakeFetch([]);
      const proxy = proxyOf({ fetch: fn });
      const res = await proxy.handle(req(method, []), noAdmit);
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0, "upstream must not be called for a disallowed method");
      const body = JSON.parse(res.body) as { error: { message: string } };
      assert.match(body.error.message, /not allowed/);
    });
  }

  it("rejects getMultipleAccounts with more than 100 items", async () => {
    const { fn, calls } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const items = Array.from({ length: 101 }, () => "11111111111111111111111111111111");
    const res = await proxy.handle(req("getMultipleAccounts", [items]), noAdmit);
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  it("allows getMultipleAccounts with exactly 100 items", async () => {
    const { fn } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } }), { status: 200 })]);
    const proxy = proxyOf({ fetch: fn });
    const items = Array.from({ length: 100 }, () => "11111111111111111111111111111111");
    const res = await proxy.handle(req("getMultipleAccounts", [items]), noAdmit);
    assert.equal(res.status, 200);
  });
});

describe("createRpcProxy: getProgramAccounts (F1)", () => {
  const gpa = (params: unknown[]) => req("getProgramAccounts", params);
  const discFilter = { memcmp: { offset: 0, bytes: DISCRIMINATOR } };

  it("rejects a token program: only OUR program is allowed", async () => {
    for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ASSOCIATED_TOKEN_PROGRAM]) {
      const { fn, calls } = fakeFetch([]);
      const proxy = proxyOf({ fetch: fn });
      const res = await proxy.handle(gpa([program, { filters: [discFilter] }]), noAdmit);
      assert.equal(res.status, 400, program);
      assert.equal(calls.length, 0, program);
    }
  });

  it("rejects a dataSize-only filter set (matches everything, selects no type)", async () => {
    const { fn, calls } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(gpa([RELSTATE_PROGRAM, { filters: [{ dataSize: 100 }] }]), noAdmit);
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
    assert.match((JSON.parse(res.body) as { error: { message: string } }).error.message, /discriminator/);
  });

  it("rejects an empty-bytes memcmp", async () => {
    const { fn } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(gpa([RELSTATE_PROGRAM, { filters: [{ memcmp: { offset: 0, bytes: "" } }] }]), noAdmit);
    assert.equal(res.status, 400);
  });

  it("rejects a discriminator-shaped memcmp that is not at offset 0", async () => {
    const { fn, calls } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(gpa([RELSTATE_PROGRAM, { filters: [{ memcmp: { offset: 8, bytes: DISCRIMINATOR } }] }]), noAdmit);
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  it("rejects a memcmp at offset 0 that is not 8 bytes", async () => {
    const { fn } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(gpa([RELSTATE_PROGRAM, { filters: [{ memcmp: { offset: 0, bytes: SHORT_BYTES } }] }]), noAdmit);
    assert.equal(res.status, 400);
  });

  it("rejects an unknown filter key", async () => {
    const { fn } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(gpa([RELSTATE_PROGRAM, { filters: [discFilter, { bogus: 1 }] }]), noAdmit);
    assert.equal(res.status, 400);
    assert.match((JSON.parse(res.body) as { error: { message: string } }).error.message, /unknown filter/);
  });

  it("rejects a filter object carrying more than one key", async () => {
    const { fn } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(gpa([RELSTATE_PROGRAM, { filters: [{ ...discFilter, dataSize: 10 }] }]), noAdmit);
    assert.equal(res.status, 400);
  });

  it("rejects more than 4 filters", async () => {
    const { fn } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const filters = [discFilter, { dataSize: 1 }, { dataSize: 2 }, { dataSize: 3 }, { dataSize: 4 }];
    const res = await proxy.handle(gpa([RELSTATE_PROGRAM, { filters }]), noAdmit);
    assert.equal(res.status, 400);
  });

  it("rejects an unknown config option", async () => {
    const { fn } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(gpa([RELSTATE_PROGRAM, { filters: [discFilter], tooBig: true }]), noAdmit);
    assert.equal(res.status, 400);
    assert.match((JSON.parse(res.body) as { error: { message: string } }).error.message, /unsupported option tooBig/);
  });

  it("accepts OUR program with a real discriminator memcmp, at the gPA weight", async () => {
    const { fn } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), { status: 200 })]);
    const proxy = proxyOf({ fetch: fn });
    const weights: number[] = [];
    const res = await proxy.handle(gpa([RELSTATE_PROGRAM, { filters: [discFilter] }]), (w) => weights.push(w));
    assert.equal(res.status, 200);
    assert.deepEqual(weights, [50]);
  });

  it("accepts the discriminator plus a 32-byte pubkey memcmp at offset 8, as the app's reader sends", async () => {
    const { fn } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), { status: 200 })]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(gpa([RELSTATE_PROGRAM, { filters: [discFilter, { memcmp: { offset: 8, bytes: OWNER_PUBKEY } }] }]), noAdmit);
    assert.equal(res.status, 200);
  });
});

describe("createRpcProxy: simulateTransaction (F10)", () => {
  const sim = (params: unknown[]) => req("simulateTransaction", params);
  const tx = "A".repeat(200); // content does not matter to validate(), only shape and length

  it("rejects a transaction string over 2048 characters", async () => {
    const { fn, calls } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(sim(["A".repeat(2049)]), noAdmit);
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  it("rejects more than 5 requested accounts", async () => {
    const { fn } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const addresses = Array.from({ length: 6 }, () => "11111111111111111111111111111111");
    const res = await proxy.handle(sim([tx, { accounts: { addresses } }]), noAdmit);
    assert.equal(res.status, 400);
  });

  it("rejects an unknown config key", async () => {
    const { fn } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(sim([tx, { encoding: "base64", notAThing: 1 }]), noAdmit);
    assert.equal(res.status, 400);
  });

  it("rejects sigVerify and replaceRecentBlockhash both true (the RPC itself refuses this combination)", async () => {
    const { fn } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(sim([tx, { sigVerify: true, replaceRecentBlockhash: true }]), noAdmit);
    assert.equal(res.status, 400);
  });

  it("accepts a normal web3.js-shaped request, at the simulate weight", async () => {
    const { fn } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: { err: null, logs: [] } } }), { status: 200 })]);
    const proxy = proxyOf({ fetch: fn });
    const weights: number[] = [];
    const addresses = ["11111111111111111111111111111111", RELSTATE_PROGRAM];
    const res = await proxy.handle(
      sim([tx, { encoding: "base64", commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: true, accounts: { addresses }, minContextSlot: 1 }]),
      (w) => weights.push(w),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(weights, [20]);
  });
});

describe("createRpcProxy: batch caps", () => {
  it("rejects a batch larger than the max", async () => {
    const { fn, calls } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const batch = Array.from({ length: 11 }, (_, i) => JSON.parse(req("getSlot", [], i)));
    const res = await proxy.handle(JSON.stringify(batch), noAdmit);
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  it("rejects the whole batch when one entry carries a disallowed method, charging the admitted weight for the attempt", async () => {
    const { fn, calls } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const batch = [JSON.parse(req("getSlot", [], 1)), JSON.parse(req("sendTransaction", [], 2))];
    const weights: number[] = [];
    const res = await proxy.handle(JSON.stringify(batch), (w) => weights.push(w));
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0, "a rejected batch must never reach upstream");
    assert.deepEqual(weights, [2], "a rejected batch is still charged (capped at its own length)");
  });

  it("allows a batch at the max size", async () => {
    const { fn } = fakeFetch([new Response(JSON.stringify([{ jsonrpc: "2.0", id: 1, result: 1 }]), { status: 200 })]);
    const proxy = proxyOf({ fetch: fn });
    const batch = Array.from({ length: 10 }, (_, i) => JSON.parse(req("getSlot", [], i)));
    const res = await proxy.handle(JSON.stringify(batch), noAdmit);
    assert.equal(res.status, 200);
  });
});

describe("createRpcProxy: weights and admission (F3, via handle)", () => {
  it("charges 1 for a plain read, n for a list method, and sums a batch", async () => {
    const { fn } = fakeFetch([
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200 }),
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } }), { status: 200 }),
      new Response(JSON.stringify([{ jsonrpc: "2.0", id: 1, result: 1 }, { jsonrpc: "2.0", id: 2, result: 1 }]), { status: 200 }),
    ]);
    const proxy = proxyOf({ fetch: fn });
    const weights: number[] = [];
    await proxy.handle(req("getSlot"), (w) => weights.push(w));
    await proxy.handle(req("getMultipleAccounts", [["a", "b", "c"].map(() => "11111111111111111111111111111111")]), (w) => weights.push(w));
    const batch = [JSON.parse(req("getSlot", [], 1)), JSON.parse(req("getSlot", [], 2))];
    await proxy.handle(JSON.stringify(batch), (w) => weights.push(w));
    assert.deepEqual(weights, [1, 3, 2]);
  });

  it("propagates whatever admit throws, before touching upstream", async () => {
    const { fn, calls } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    class Blocked extends Error {}
    const admit = () => {
      throw new Blocked("nope");
    };
    await assert.rejects(proxy.handle(req("getSlot"), admit), Blocked);
    assert.equal(calls.length, 0);
  });

  it("turns a thrown RpcRateLimited into a 429 JSON-RPC body with retry-after, and never mentions login", async () => {
    const { fn, calls } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const admit = () => {
      throw new RpcRateLimited("ip", 42);
    };
    const res = await proxy.handle(req("getSlot"), admit);
    assert.equal(res.status, 429);
    assert.equal(res.retryAfter, "42");
    assert.equal(calls.length, 0);
    const body = JSON.parse(res.body) as { jsonrpc: string; error: { code: number; message: string } };
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.error.code, -32005);
    assert.doesNotMatch(res.body.toLowerCase(), /login/);
  });

  it("still charges admit (capped) for a body that fails to parse", async () => {
    const { fn, calls } = fakeFetch([]);
    const proxy = proxyOf({ fetch: fn });
    const weights: number[] = [];
    const res = await proxy.handle("{not json", (w) => weights.push(w));
    assert.equal(res.status, 400);
    assert.deepEqual(weights, [1]);
    assert.equal(calls.length, 0);
  });
});

describe("createRpcLimiter (F3, unit)", () => {
  it("admits up to the per-key budget, then throws for that key only", () => {
    const admit = createRpcLimiter({ perIpPerMinute: 10, globalPerMinute: 1000 });
    admit("rpc:1.1.1.1", 9);
    assert.throws(() => admit("rpc:1.1.1.1", 2), RpcRateLimited);
    admit("rpc:2.2.2.2", 9); // a different key has its own budget
  });

  it("the window resets after 60s, using an injected clock", () => {
    let t = 0;
    const now = () => t;
    const admit = createRpcLimiter({ perIpPerMinute: 10, globalPerMinute: 1000, now });
    admit("k", 10);
    assert.throws(() => admit("k", 1), RpcRateLimited);
    t = 60_000;
    admit("k", 10); // fresh window
  });

  it("enforces one process-wide global budget across different keys", () => {
    const admit = createRpcLimiter({ perIpPerMinute: 1000, globalPerMinute: 10 });
    admit("a", 6);
    admit("b", 4);
    assert.throws(() => admit("c", 1), (e) => e instanceof RpcRateLimited && e.scope === "global");
  });

  it("gives a key ending :unknown only a tenth of the per-IP budget", () => {
    const admit = createRpcLimiter({ perIpPerMinute: 100, globalPerMinute: 10_000 });
    admit("rpc:unknown", 10);
    assert.throws(() => admit("rpc:unknown", 1), (e) => e instanceof RpcRateLimited && e.scope === "ip");
    admit("rpc:1.2.3.4", 99); // a resolved key keeps the full budget
  });

  it("reports retryAfterSeconds counting down to the window's end", () => {
    let t = 10_000;
    const now = () => t;
    const admit = createRpcLimiter({ perIpPerMinute: 1, globalPerMinute: 1000, now });
    admit("k", 1);
    t = 40_000; // 30s into the 60s window
    try {
      admit("k", 1);
      assert.fail("expected RpcRateLimited");
    } catch (e) {
      assert.ok(e instanceof RpcRateLimited);
      assert.equal(e.retryAfterSeconds, 30);
    }
  });
});

describe("createRpcProxy: upstream key never leaks (incl. configured secrets)", () => {
  it("never appears when upstream returns an error status", async () => {
    const { fn } = fakeFetch([new Response("internal error, upstream was https://x.test/?api-key=SECRETKEY123456SUPERSECRET", { status: 500 })]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(req("getSlot"), noAdmit);
    assert.equal(res.status, 502);
    assert.ok(!res.body.includes(UPSTREAM_SECRET));
    assert.ok(!res.body.includes(UPSTREAM));
  });

  it("never appears when upstream throws", async () => {
    const { fn } = fakeFetch([new Error(`network error reaching ${UPSTREAM}`)]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(req("getSlot"), noAdmit);
    assert.equal(res.status, 502);
    assert.ok(!res.body.includes(UPSTREAM_SECRET));
  });

  it("scrubs the key when upstream echoes it back in a 200 body", async () => {
    const { fn } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: UPSTREAM }), { status: 200 })]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(req("getSlot"), noAdmit);
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes(UPSTREAM_SECRET));
    assert.ok(res.body.includes("<redacted>"));
  });

  it("passes through 429 with a well-formed retry-after, never the upstream URL", async () => {
    const { fn } = fakeFetch([new Response(`rate limited by ${UPSTREAM}`, { status: 429, headers: { "retry-after": "7" } })]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(req("getSlot"), noAdmit);
    assert.equal(res.status, 429);
    assert.equal(res.retryAfter, "7");
    assert.ok(!res.body.includes(UPSTREAM_SECRET));
  });

  it("drops a malformed or absurd retry-after rather than passing it through", async () => {
    const { fn } = fakeFetch([new Response("slow down", { status: 429, headers: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" } })]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(req("getSlot"), noAdmit);
    assert.equal(res.status, 429);
    assert.equal(res.retryAfter, undefined);
  });

  it("maps a 500 to a generic 502 with no upstream detail", async () => {
    const { fn } = fakeFetch([new Response("boom", { status: 500 })]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(req("getSlot"), noAdmit);
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
    const res = await proxy.handle(req("getSlot"), noAdmit);
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
    const res = await proxy.handle(raw, noAdmit);
    assert.equal(res.status, 200);
    assert.ok(!sentBody.includes("evil"));
    assert.ok(!sentBody.includes("DROP TABLE"));
    assert.ok(!sentBody.includes("nested"));
    assert.deepEqual(JSON.parse(sentBody), { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] });
  });

  it("scrubs a query-string key regardless of its parameter name (apiKey=, key=, token=)", async () => {
    for (const param of ["apiKey=LEAKEDVALUE1", "key=LEAKEDVALUE2", "token=LEAKEDVALUE3"]) {
      const upstream = `https://x.test/?${param}`;
      const secret = param.split("=")[1]!;
      const { fn } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `echo ${secret} from ${upstream}` }), { status: 200 })]);
      const proxy = createRpcProxy({ upstreamUrl: () => upstream, fetch: fn });
      const res = await proxy.handle(req("getSlot"), noAdmit);
      assert.ok(!res.body.includes(secret), param);
    }
  });

  it("scrubs a short path-embedded key (/v2/<key> style)", async () => {
    const upstream = "https://x.test/v2/shortkey";
    const { fn } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "leaked shortkey here" }), { status: 200 })]);
    const proxy = createRpcProxy({ upstreamUrl: () => upstream, fetch: fn });
    const res = await proxy.handle(req("getSlot"), noAdmit);
    assert.ok(!res.body.includes("shortkey"));
  });

  it("scrubs userinfo credentials embedded in the URL", async () => {
    const upstream = "https://someuser:somepassword@x.test/";
    const { fn } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "leaked somepassword and someuser" }), { status: 200 })]);
    const proxy = createRpcProxy({ upstreamUrl: () => upstream, fetch: fn });
    const res = await proxy.handle(req("getSlot"), noAdmit);
    assert.ok(!res.body.includes("somepassword"));
    assert.ok(!res.body.includes("someuser"));
  });

  it("scrubs a configured secret() value that the URL alone would not reveal", async () => {
    const { fn } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "leaked CONFIGUREDSECRETVALUE here" }), { status: 200 })]);
    const proxy = createRpcProxy({ upstreamUrl: () => "https://plain.test/", secrets: () => ["CONFIGUREDSECRETVALUE"], fetch: fn });
    const res = await proxy.handle(req("getSlot"), noAdmit);
    assert.ok(!res.body.includes("CONFIGUREDSECRETVALUE"));
  });

  it("scrubs the full upstream URL when echoed back verbatim", async () => {
    const { fn } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: UPSTREAM }), { status: 200 })]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(req("getSlot"), noAdmit);
    assert.ok(!res.body.includes(UPSTREAM));
  });
});

describe("createRpcProxy: streamed response cap (F2)", () => {
  const encoder = new TextEncoder();

  function streamOf(chunks: Uint8Array[]) {
    let i = 0;
    const tracker = { pulls: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        tracker.pulls++;
        if (i < chunks.length) controller.enqueue(chunks[i++]!);
        else controller.close();
      },
      cancel() {
        tracker.cancelled = true;
      },
    });
    return { stream, tracker };
  }

  it("cancels a stream that would emit far more than the cap, after the first oversized chunk, without reading the rest", async () => {
    const bigChunk = new Uint8Array(2000).fill(65); // 2000 bytes, far over the cap below
    const { stream, tracker } = streamOf([bigChunk, bigChunk, bigChunk, bigChunk]); // would total 8000 bytes ("100MB" in miniature)
    const { fn } = fakeFetch([new Response(stream, { status: 200 })]);
    const proxy = proxyOf({ fetch: fn, maxResponseBytes: 1000 });
    const res = await proxy.handle(req("getSlot"), noAdmit);
    assert.equal(res.status, 502);
    assert.equal((JSON.parse(res.body) as { error: { message: string } }).error.message, "upstream response too large");
    assert.ok(tracker.cancelled, "the stream must be cancelled once the cap is passed");
    assert.ok(tracker.pulls < 4, "not every chunk should have been read");
  });

  it("rejects on a declared content-length over the cap without reading the body at all", async () => {
    const { stream, tracker } = streamOf([encoder.encode("short")]);
    const { fn } = fakeFetch([new Response(stream, { status: 200, headers: { "content-length": "999999" } })]);
    const proxy = proxyOf({ fetch: fn, maxResponseBytes: 1000 });
    const res = await proxy.handle(req("getSlot"), noAdmit);
    assert.equal(res.status, 502);
    assert.ok(tracker.pulls <= 1, "at most the stream's own priming pull; the body is never consumed");
    assert.ok(tracker.cancelled, "the unread body must be cancelled");
  });

  it("counts UTF-8 bytes, not UTF-16 string length, against the cap", async () => {
    // "é" is one UTF-16 code unit but two UTF-8 bytes: 20 of them is 20 "characters" but 40 bytes.
    const text = "é".repeat(20);
    const bytes = encoder.encode(text);
    assert.equal(bytes.byteLength, 40);
    const { stream } = streamOf([bytes]);
    const { fn } = fakeFetch([new Response(stream, { status: 200 })]); // no content-length: forces byte-by-byte accounting
    const proxy = proxyOf({ fetch: fn, maxResponseBytes: 30 }); // under the byte count, over the char count
    const res = await proxy.handle(req("getSlot"), noAdmit);
    assert.equal(res.status, 502);
    assert.equal((JSON.parse(res.body) as { error: { message: string } }).error.message, "upstream response too large");
  });

  it("accepts the same multibyte body comfortably under the byte cap", async () => {
    const text = "é".repeat(20); // 40 bytes
    const { stream } = streamOf([encoder.encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: text }))]);
    const { fn } = fakeFetch([new Response(stream, { status: 200 })]);
    const proxy = proxyOf({ fetch: fn, maxResponseBytes: 1000 });
    const res = await proxy.handle(req("getSlot"), noAdmit);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes(text));
  });

  it("a thrown fetch still reports the generic unavailable message, not the too-large one", async () => {
    const { fn } = fakeFetch([new Error("boom")]);
    const proxy = proxyOf({ fetch: fn });
    const res = await proxy.handle(req("getSlot"), noAdmit);
    assert.equal((JSON.parse(res.body) as { error: { message: string } }).error.message, "upstream RPC unavailable");
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

  it("415s a non-JSON content-type without touching upstream", async () => {
    const { fn, calls } = fakeFetch([]);
    const app = createApp(undefined, undefined, createRpcProxy({ upstreamUrl: () => UPSTREAM, fetch: fn }));
    const res = await app.request("/api/rpc", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: req("getAccountInfo", ["11111111111111111111111111111111"]),
    });
    assert.equal(res.status, 415);
    assert.equal(calls.length, 0);
  });

  it("accepts application/json with a charset suffix", async () => {
    const { fn } = fakeFetch([new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: null } }), { status: 200 })]);
    const app = createApp(undefined, undefined, createRpcProxy({ upstreamUrl: () => UPSTREAM, fetch: fn }));
    const res = await app.request("/api/rpc", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: req("getAccountInfo", ["11111111111111111111111111111111"]),
    });
    assert.equal(res.status, 200);
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

  describe("per-IP and global rate limits", () => {
    const originalIp = env.rpcProxyRatePerMinute;
    const originalGlobal = env.rpcProxyGlobalPerMinute;
    afterEach(() => {
      (env as unknown as { rpcProxyRatePerMinute: number }).rpcProxyRatePerMinute = originalIp;
      (env as unknown as { rpcProxyGlobalPerMinute: number }).rpcProxyGlobalPerMinute = originalGlobal;
    });

    it("429s once the per-minute limit is exceeded, with a JSON-RPC body that never mentions login", async () => {
      (env as unknown as { rpcProxyRatePerMinute: number }).rpcProxyRatePerMinute = 20; // no socket in app.request => the "unknown" key, which gets a tenth: 2
      (env as unknown as { rpcProxyGlobalPerMinute: number }).rpcProxyGlobalPerMinute = 1000;
      const { fn } = fakeFetch([
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200 }),
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200 }),
      ]);
      const app = createApp(undefined, undefined, createRpcProxy({ upstreamUrl: () => UPSTREAM, fetch: fn }));
      const send = () =>
        app.request("/api/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: req("getSlot") });
      assert.equal((await send()).status, 200);
      assert.equal((await send()).status, 200);
      const third = await send();
      assert.equal(third.status, 429);
      assert.equal(third.headers.get("retry-after") !== null, true);
      const text = await third.text();
      assert.doesNotMatch(text.toLowerCase(), /login/);
      const body = JSON.parse(text) as { jsonrpc: string; error: { code: number } };
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(body.error.code, -32005);
    });

    it("enforces one global budget shared across different client IPs", async () => {
      (env as unknown as { rpcProxyRatePerMinute: number }).rpcProxyRatePerMinute = 1000;
      (env as unknown as { rpcProxyGlobalPerMinute: number }).rpcProxyGlobalPerMinute = 2;
      const { fn } = fakeFetch([
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200 }),
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200 }),
      ]);
      const app = createApp(undefined, undefined, createRpcProxy({ upstreamUrl: () => UPSTREAM, fetch: fn }));
      const send = (ip: string) =>
        app.request("/api/rpc", {
          method: "POST",
          headers: { "content-type": "application/json", "fly-client-ip": ip },
          body: req("getSlot"),
        });
      // Without TRUST_PROXY_IP_HEADER, fly-client-ip is ignored and every call shares the socket's
      // "unknown" bucket anyway — which is exactly the scenario this test wants: two calls that
      // *look* like different callers but are not trusted as such still share one global budget.
      assert.equal((await send("1.1.1.1")).status, 200);
      assert.equal((await send("2.2.2.2")).status, 200);
      assert.equal((await send("3.3.3.3")).status, 429);
    });
  });
});
