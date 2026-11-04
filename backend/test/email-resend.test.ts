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

/** Fetch stub that records the single call it receives and answers with a fixed Response. */
function recordingFetch(response: Response): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

describe("createResendEmailSender: request shape", () => {
  it("POSTs to <apiBase>/emails with the expected headers and body", async () => {
    const { fetch, calls } = recordingFetch(new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
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
    const { fetch, calls } = recordingFetch(new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
    const sender = createResendEmailSender({ ...baseConfig, apiBase: "https://api.resend.com/" }, { fetch });
    await sender.send(baseEmail);
    assert.equal(calls[0]!.url, "https://api.resend.com/emails");
  });
});

describe("createResendEmailSender: idempotency key", () => {
  const keyFor = async (email: typeof baseEmail): Promise<string> => {
    const { fetch, calls } = recordingFetch(new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
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
});

describe("createResendEmailSender: success", () => {
  it("resolves, and the sender reports name 'resend' and delivers true", async () => {
    const { fetch } = recordingFetch(new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
    const sender = createResendEmailSender(baseConfig, { fetch });
    assert.equal(sender.name, "resend");
    assert.equal(sender.delivers, true);
    await assert.doesNotReject(() => sender.send(baseEmail));
  });

  it("logs the Resend message id and nothing else identifying", async () => {
    const { fetch } = recordingFetch(new Response(JSON.stringify({ id: "msg_abc123" }), { status: 200 }));
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
    const { fetch } = recordingFetch(new Response(quoting, { status: 403 }));
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
    const { fetch } = recordingFetch(new Response(errorBody("rate_limit_exceeded", "Too many requests"), { status: 429 }));
    const sender = createResendEmailSender(baseConfig, { fetch });
    const error = await sender.send(baseEmail).catch((e: unknown) => e);
    assert.ok(error instanceof ResendApiError);
    assert.equal((error as ResendApiError).status, 429);
    assert.equal((error as ResendApiError).resendCode, "rate_limit_exceeded");
  });

  it("a non-JSON error body (e.g. an HTML error page) still throws with the status, without crashing on response.json()", async () => {
    const { fetch } = recordingFetch(new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } }));
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

describe("createEmailSender with sender: resend", () => {
  it("returns the Resend sender and routes through the injected fetch, never the network", async () => {
    const { fetch, calls } = recordingFetch(new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
    const lines: string[] = [];
    const sender = createEmailSender({ sender: "resend", fetch, log: (...args) => lines.push(args.join(" ")) });
    assert.equal(sender.name, "resend");
    await sender.send(baseEmail);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url.endsWith("/emails"), true);
  });
});
