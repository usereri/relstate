import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEmailSender } from "../src/email.ts";
import { ResendApiError, createResendEmailSender, type ResendConfig } from "../src/email-resend.ts";

const TOKEN = "bearer-token-1234567890abcdef";
const RECIPIENT = "appraiser@example.com";

const baseConfig: ResendConfig = {
  apiKey: "re_test_0123456789abcdef",
  from: "Relstate <invites@relstate.casa>",
  apiBase: "https://api.resend.com",
  timeoutMs: 10_000,
};

const baseEmail = { to: RECIPIENT, subject: "You've been invited to appraise", text: `Open your invite: https://app.example/invite/${TOKEN}` };

/** Fetch stub that records each call and answers with a fresh Response built by `make`. */
function recordingFetch(make: () => Response): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(make());
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

/** Fetch stub for a sequence of attempts: one factory per call, the last one repeating past the end. */
function sequenceFetch(...makers: Array<() => Response>): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  let n = 0;
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const make = makers[Math.min(n, makers.length - 1)]!;
    n += 1;
    return Promise.resolve(make());
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

/** Never actually waits: for every retry test, so the delay cannot slow the suite down. */
const noSleep = async (): Promise<void> => {};

describe("createResendEmailSender: request shape", () => {
  it("POSTs to <apiBase>/emails with the expected headers and body", async () => {
    const { fetch, calls } = recordingFetch(() => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
    const sender = createResendEmailSender(baseConfig, { fetch });
    await sender.send(baseEmail);

    assert.equal(calls.length, 1);
    const { url, init } = calls[0]!;
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(init.method, "POST");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${baseConfig.apiKey}`);
    assert.equal(headers["content-type"], "application/json");
    assert.ok(typeof headers["idempotency-key"] === "string" && headers["idempotency-key"].length > 0);
    assert.ok(headers["idempotency-key"]!.length <= 256);
    assert.ok(init.signal instanceof AbortSignal);

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    assert.equal(body.from, baseConfig.from);
    assert.deepEqual(body.to, [RECIPIENT]);
    assert.equal(body.subject, baseEmail.subject);
    assert.equal(body.text, baseEmail.text);
    assert.equal("html" in body, false, "no html field should be sent");
  });

  it("does not produce a double slash when apiBase has a trailing slash", async () => {
    const { fetch, calls } = recordingFetch(() => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
    const sender = createResendEmailSender({ ...baseConfig, apiBase: "https://api.resend.com/" }, { fetch });
    await sender.send(baseEmail);
    assert.equal(calls[0]!.url, "https://api.resend.com/emails");
  });
});

describe("createResendEmailSender: idempotency key", () => {
  const keyFor = async (email: typeof baseEmail): Promise<string> => {
    const { fetch, calls } = recordingFetch(() => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
    const sender = createResendEmailSender(baseConfig, { fetch });
    await sender.send(email);
    return (calls[0]!.init.headers as Record<string, string>)["idempotency-key"]!;
  };

  it("is stable for the same message", async () => {
    assert.equal(await keyFor(baseEmail), await keyFor(baseEmail));
  });

  it("differs when the invite link/token differs", async () => {
    const other = { ...baseEmail, text: baseEmail.text.replace(TOKEN, "a-totally-different-token") };
    assert.notEqual(await keyFor(baseEmail), await keyFor(other));
  });

  it("is a fixed 59 characters, well inside Resend's 256-character limit", async () => {
    // `relstate-invite-` plus the full base64url of a sha256, which is always 43 characters. Pinned
    // because a truncation here would quietly weaken the key, and a prefix change would silently
    // split the 24-hour dedupe window.
    const key = await keyFor(baseEmail);
    assert.equal(key.length, 59);
    assert.ok(key.startsWith("relstate-invite-"));
  });
});

describe("createResendEmailSender: success", () => {
  it("resolves, and the sender reports name 'resend' and delivers true", async () => {
    const { fetch } = recordingFetch(() => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
    const sender = createResendEmailSender(baseConfig, { fetch });
    assert.equal(sender.name, "resend");
    assert.equal(sender.delivers, true);
    await assert.doesNotReject(() => sender.send(baseEmail));
  });

  it("logs the Resend message id and nothing else identifying", async () => {
    const { fetch } = recordingFetch(() => new Response(JSON.stringify({ id: "msg_abc123" }), { status: 200 }));
    const lines: string[] = [];
    const sender = createResendEmailSender(baseConfig, { fetch, log: (...args) => lines.push(args.join(" ")) });
    await sender.send(baseEmail);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("msg_abc123"));
    assert.ok(!lines[0]!.includes(RECIPIENT));
    assert.ok(!lines[0]!.includes(TOKEN));
    assert.ok(!lines[0]!.includes(baseConfig.apiKey));
  });
});

/** An error body that, like a real Resend validation error, quotes request fragments back. */
const errorBody = (name: string, message: string) => JSON.stringify({ name, message });

describe("createResendEmailSender: failure paths", () => {
  it("HTTP 403 validation_error throws ResendApiError naming the problem, without leaking secrets", async () => {
    const quoting = errorBody("validation_error", `The recipient ${RECIPIENT} with token ${TOKEN} using key ${baseConfig.apiKey} is invalid`);
    const { fetch } = recordingFetch(() => new Response(quoting, { status: 403 }));
    const lines: string[] = [];
    const sender = createResendEmailSender(baseConfig, { fetch, log: (...args) => lines.push(args.join(" ")) });

    const error = await sender.send(baseEmail).catch((e: unknown) => e);
    assert.ok(error instanceof ResendApiError);
    assert.equal((error as ResendApiError).status, 403);
    assert.equal((error as ResendApiError).resendCode, "validation_error");
    assert.ok(/INVITE_EMAIL_FROM|domain verified/i.test((error as Error).message), (error as Error).message);

    assert.ok(!(error as Error).message.includes(RECIPIENT));
    assert.ok(!(error as Error).message.includes(TOKEN));
    assert.ok(!(error as Error).message.includes(baseConfig.apiKey));
    assert.ok(!lines.join("\n").includes(RECIPIENT));
    assert.ok(!lines.join("\n").includes(TOKEN));
    assert.ok(!lines.join("\n").includes(baseConfig.apiKey));
  });

  it("HTTP 429 rate_limit_exceeded throws ResendApiError with the right status and code", async () => {
    // 429 is retried, so the fetch stub has to build a fresh Response per call: the first one's body
    // is consumed by then, and reusing the instance would silently lose `resendCode` here.
    const { fetch, calls } = recordingFetch(() => new Response(errorBody("rate_limit_exceeded", "Too many requests"), { status: 429 }));
    const sender = createResendEmailSender(baseConfig, { fetch, sleep: noSleep });
    const error = await sender.send(baseEmail).catch((e: unknown) => e);
    assert.ok(error instanceof ResendApiError);
    assert.equal((error as ResendApiError).status, 429);
    assert.equal((error as ResendApiError).resendCode, "rate_limit_exceeded");
    assert.equal(calls.length, 2, "429 is retried exactly once");
  });

  it("a non-JSON error body (e.g. an HTML error page) still throws with the status, without crashing on response.json()", async () => {
    const { fetch } = recordingFetch(() => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } }));
    const sender = createResendEmailSender(baseConfig, { fetch });
    const error = await sender.send(baseEmail).catch((e: unknown) => e);
    assert.ok(error instanceof ResendApiError);
    assert.equal((error as ResendApiError).status, 502);
    assert.equal((error as ResendApiError).resendCode, undefined);
  });

  it("a rejected fetch (network failure) throws ResendApiError with status 0", async () => {
    const fetchFn = (() => Promise.reject(new Error("getaddrinfo ENOTFOUND api.resend.com"))) as typeof fetch;
    const sender = createResendEmailSender(baseConfig, { fetch: fetchFn });
    const error = await sender.send(baseEmail).catch((e: unknown) => e);
    assert.ok(error instanceof ResendApiError);
    assert.equal((error as ResendApiError).status, 0);
    assert.ok(!(error as Error).message.includes(RECIPIENT));
    assert.ok(!(error as Error).message.includes(TOKEN));
    assert.ok(!(error as Error).message.includes(baseConfig.apiKey));
  });

  it("times out: status 0, message names the timeout, never resolves silently", async () => {
    // AbortSignal.timeout's own timer is unref'd, so a stub that only waits for the abort can let
    // Node exit with "Detected unsettled top-level await". Keep the loop open with a ref'd timer
    // and clear it once the abort fires.
    const timeoutMs = 50;
    const fetchFn = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const keepAlive = setTimeout(() => {}, 5000);
        (init.signal as AbortSignal).addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject((init.signal as AbortSignal).reason);
        });
      })) as typeof fetch;
    const sender = createResendEmailSender({ ...baseConfig, timeoutMs }, { fetch: fetchFn });

    const error = await sender.send(baseEmail).catch((e: unknown) => e);
    assert.ok(error instanceof ResendApiError);
    assert.equal((error as ResendApiError).status, 0);
    assert.ok((error as Error).message.includes(`${timeoutMs}`), (error as Error).message);
    assert.ok(!(error as Error).message.includes(RECIPIENT));
    assert.ok(!(error as Error).message.includes(TOKEN));
  });
});

/**
 * The retry exists because a rate limit and a transient 5xx are worth one more go; it is safe
 * because the `Idempotency-Key` is a digest of the message, so a first attempt Resend actually
 * accepted is replayed rather than delivered twice. Both halves are asserted here: that the retry
 * happens for exactly the right statuses, and that the key is identical across the two attempts.
 */
describe("createResendEmailSender: one retry, inside one budget", () => {
  const ok = () => new Response(JSON.stringify({ id: "msg_retried" }), { status: 200 });

  for (const status of [429, 500, 503]) {
    it(`retries HTTP ${status} exactly once, with the same idempotency key`, async () => {
      const { fetch, calls } = sequenceFetch(() => new Response(errorBody("transient", "try again"), { status }), ok);
      const lines: string[] = [];
      const sender = createResendEmailSender(baseConfig, { fetch, sleep: noSleep, log: (...args) => lines.push(args.join(" ")) });

      await sender.send(baseEmail);
      assert.equal(calls.length, 2);
      const keyOf = (i: number) => (calls[i]!.init.headers as Record<string, string>)["idempotency-key"];
      assert.equal(keyOf(0), keyOf(1), "a retry that changed the key could be delivered twice");
      assert.ok(
        lines.some((l) => l.includes("msg_retried")),
        "the second attempt's success is logged",
      );
    });
  }

  it("gives up after the one retry, reporting the second attempt's status", async () => {
    const { fetch, calls } = sequenceFetch(() => new Response(errorBody("rate_limit_exceeded", "slow down"), { status: 429 }), () => new Response(errorBody("daily_quota_exceeded", "no more today"), { status: 429 }));
    const sender = createResendEmailSender(baseConfig, { fetch, sleep: noSleep });
    const error = await sender.send(baseEmail).catch((e: unknown) => e);
    assert.equal(calls.length, 2, "never a third attempt");
    assert.equal((error as ResendApiError).resendCode, "daily_quota_exceeded");
  });

  // 502 is the one worth spelling out: a 5xx that is deliberately *not* retried, because it comes
  // from an intermediary we know nothing about rather than from Resend.
  for (const status of [400, 401, 403, 409, 422, 502, 504]) {
    it(`does not retry HTTP ${status}`, async () => {
      const { fetch, calls } = recordingFetch(() => new Response(errorBody("validation_error", "no"), { status }));
      const sender = createResendEmailSender(baseConfig, { fetch, sleep: noSleep });
      await sender.send(baseEmail).catch(() => {});
      assert.equal(calls.length, 1);
    });
  }

  it("does not retry a rejected fetch", async () => {
    let calls = 0;
    const fetchFn = (() => {
      calls += 1;
      return Promise.reject(new Error("fetch failed"));
    }) as typeof fetch;
    await createResendEmailSender(baseConfig, { fetch: fetchFn, sleep: noSleep })
      .send(baseEmail)
      .catch(() => {});
    assert.equal(calls, 1);
  });

  it("does not retry once the budget is spent during the delay", async () => {
    // The retry shares the send's one `AbortSignal.timeout`, so a delay that outlives the budget
    // must end the send rather than start a second attempt. A ref'd timer keeps the loop alive,
    // since AbortSignal.timeout's own timer is unref'd.
    const { fetch, calls } = recordingFetch(() => new Response(errorBody("rate_limit_exceeded", "slow down"), { status: 429 }));
    const sender = createResendEmailSender(
      { ...baseConfig, timeoutMs: 30 },
      {
        fetch,
        sleep: (_ms, signal) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 500);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          }),
      },
    );
    const error = await sender.send(baseEmail).catch((e: unknown) => e);
    assert.ok(error instanceof ResendApiError);
    assert.equal(calls.length, 1, "the budget ran out, so the retry must not happen");
    assert.equal((error as ResendApiError).status, 429);
  });
});

/**
 * The two hints exist to tell apart the only two configuration mistakes an operator can actually
 * fix, so each must point at the right variable: Resend answers 403 both for an unverified domain
 * (`validation_error`) and for a key that is restricted, inactive or suspended.
 */
describe("createResendEmailSender: which variable the hint names", () => {
  const failWith = async (status: number, name?: string): Promise<string> => {
    const body = name === undefined ? "{}" : errorBody(name, `quoting ${RECIPIENT} and ${TOKEN} and ${baseConfig.apiKey}`);
    const { fetch } = recordingFetch(() => new Response(body, { status }));
    const sender = createResendEmailSender(baseConfig, { fetch, sleep: noSleep });
    const error = await sender.send(baseEmail).catch((e: unknown) => e);
    const message = (error as Error).message;
    // Every hint path is also a leak path: the fake body quotes all three secrets back at us.
    assert.ok(!message.includes(RECIPIENT), message);
    assert.ok(!message.includes(TOKEN), message);
    assert.ok(!message.includes(baseConfig.apiKey), message);
    return message;
  };

  it("403 validation_error points at INVITE_EMAIL_FROM, not the key", async () => {
    const message = await failWith(403, "validation_error");
    assert.match(message, /INVITE_EMAIL_FROM/);
    assert.doesNotMatch(message, /RESEND_API_KEY/);
  });

  for (const name of ["restricted_api_key", "suspended_api_key"]) {
    it(`403 ${name} points at RESEND_API_KEY, not the from address`, async () => {
      const message = await failWith(403, name);
      assert.match(message, /RESEND_API_KEY/);
      assert.doesNotMatch(message, /INVITE_EMAIL_FROM/);
    });
  }

  it("401 points at RESEND_API_KEY, with or without a parseable code", async () => {
    assert.match(await failWith(401, "missing_api_key"), /RESEND_API_KEY/);
    assert.match(await failWith(401), /RESEND_API_KEY/);
  });

  it("a status that is nobody's configuration gets no hint at all", async () => {
    for (const [status, name] of [[429, "rate_limit_exceeded"], [500, "internal_server_error"]] as const) {
      const message = await failWith(status, name);
      assert.doesNotMatch(message, /RESEND_API_KEY|INVITE_EMAIL_FROM/);
    }
  });
});

describe("createEmailSender with sender: resend", () => {
  it("returns the Resend sender and routes through the injected fetch, never the network", async () => {
    const { fetch, calls } = recordingFetch(() => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
    const lines: string[] = [];
    const sender = createEmailSender({ sender: "resend", fetch, log: (...args) => lines.push(args.join(" ")) });
    assert.equal(sender.name, "resend");
    await sender.send(baseEmail);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url.endsWith("/emails"), true);
  });
});
