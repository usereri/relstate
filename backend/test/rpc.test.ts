import "./noenv.ts";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getBase64Encoder, getSignatureFromTransaction, getTransactionDecoder, type RpcTransport } from "@solana/kit";
import {
  createRetryingTransport,
  isRetryableStatus,
  nextDelayMs,
  parseRetryAfter,
  retryingFetch,
  sendAndConfirmByPolling,
  type RetryConfig,
  type SolanaClient,
} from "../src/rpc.ts";
import { buildTx, ixSignedBy, twoKeys } from "./txfixtures.ts";

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

describe("createRetryingTransport", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const send = (transport: RpcTransport) => transport<{ result: number }>({ payload: { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] } });

  it("retries a 429 through the real HTTP transport and then returns the result", async () => {
    const statuses = [429, 503, 200];
    let calls = 0;
    globalThis.fetch = (async () => {
      const status = statuses[calls++] ?? 500;
      return status === 200
        ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }), { status, headers: { "content-type": "application/json" } })
        : new Response("busy", { status, headers: { "retry-after": "1" } });
    }) as typeof fetch;
    const slept: number[] = [];
    const transport = createRetryingTransport("http://rpc.test", cfg({ sleep: async (ms) => void slept.push(ms) }));
    assert.equal(((await send(transport)) as { result: unknown }).result, 42n);
    assert.equal(calls, 3);
    assert.deepEqual(slept, [1000, 1000]);
  });

  it("does not retry a 400", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("bad", { status: 400 });
    }) as typeof fetch;
    await assert.rejects(send(createRetryingTransport("http://rpc.test", cfg())));
    assert.equal(calls, 1);
  });

  it("gives up after maxRetries", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("busy", { status: 429 });
    }) as typeof fetch;
    await assert.rejects(send(createRetryingTransport("http://rpc.test", cfg({ maxRetries: 2 }))));
    assert.equal(calls, 3);
  });
});

describe("sendAndConfirmByPolling", () => {
  type Status = { err: unknown; confirmationStatus: string } | null;
  const fakeClient = (statuses: Status[], blockhashValid = true) => {
    const calls = { send: 0, polls: 0, valid: 0 };
    const client = {
      rpc: {
        sendTransaction: () => ({ send: async () => void calls.send++ }),
        getSignatureStatuses: () => ({ send: async () => ({ value: [statuses[Math.min(calls.polls++, statuses.length - 1)] ?? null] }) }),
        isBlockhashValid: () => ({ send: async () => (calls.valid++, { value: blockhashValid }) }),
      },
    } as unknown as SolanaClient;
    return { client, calls };
  };
  const opts = { pollMs: 0, resendEveryPolls: 2, timeoutMs: 2000 };

  const signedTx = async () => {
    const { user } = await twoKeys();
    const b64 = await buildTx({ feePayer: user.address, instructions: [ixSignedBy(user)] });
    return getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(b64)));
  };

  it("returns once the status is confirmed, re-sending while the transaction is not seen", async () => {
    const tx = await signedTx();
    const { client, calls } = fakeClient([null, null, null, null, { err: null, confirmationStatus: "confirmed" }]);
    const sig = await sendAndConfirmByPolling(client, tx as never, { ...opts, blockhash: "11111111111111111111111111111111" as never });
    assert.equal(sig, getSignatureFromTransaction(tx as never));
    assert.equal(calls.polls, 5);
    assert.equal(calls.send, 3, "initial send + a re-send on polls 2 and 4");
    assert.equal(calls.valid, 2);
  });

  it("does not treat 'processed' as confirmed", async () => {
    const tx = await signedTx();
    const { client, calls } = fakeClient([{ err: null, confirmationStatus: "processed" }, { err: null, confirmationStatus: "finalized" }]);
    await sendAndConfirmByPolling(client, tx as never, opts);
    assert.equal(calls.polls, 2);
  });

  it("throws when the transaction landed with an error", async () => {
    const tx = await signedTx();
    const { client } = fakeClient([{ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }]);
    await assert.rejects(sendAndConfirmByPolling(client, tx as never, opts), /failed/);
  });

  it("throws 'expired' when the blockhash is no longer valid", async () => {
    const tx = await signedTx();
    const { client, calls } = fakeClient([null], false);
    await assert.rejects(sendAndConfirmByPolling(client, tx as never, { ...opts, blockhash: "11111111111111111111111111111111" as never }), /expired/);
    assert.equal(calls.send, 1, "no re-send after expiry");
  });

  it("times out when never seen and no blockhash was given", async () => {
    const tx = await signedTx();
    const { client } = fakeClient([null]);
    await assert.rejects(sendAndConfirmByPolling(client, tx as never, { pollMs: 1, resendEveryPolls: 1000, timeoutMs: 30 }), /not confirmed within/);
  });
});
