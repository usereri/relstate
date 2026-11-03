import "./noenv.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

const { SumsubApiError, createSumsubKyc, eventRef, parseCreatedAtMs, payloadToProviderEvent, signRequest, verifySumsubSignature } = await import(
  "../src/providers/kyc-sumsub.ts"
);
import type { SumsubConfig, SumsubPayload } from "../src/providers/kyc-sumsub.ts";

// There are no Sumsub keys in this project, so this file is the only place the verifier is ever
// exercised: every case below is one the first real webhook must not get wrong.
// The fixtures are stamped 2026-10-10 10:00:00 UTC; the clock is injected so the freshness window
// is deterministic instead of depending on when the suite runs.
const NOW = Date.UTC(2026, 9, 10, 10, 0, 5);
const verify = (rawBody: string, headers: Record<string, string>, secret: string, opts: Parameters<typeof verifySumsubSignature>[3] = {}) =>
  verifySumsubSignature(rawBody, headers, secret, { now: NOW, ...opts });

const SECRET = "whsec_sumsub_known_secret";
const WALLET = "EBMibFLTvr5GDpgxNqt5Gqp9B1xLMr32aNwGDJV2oGJ6";

const ALGS = { HMAC_SHA1_HEX: "sha1", HMAC_SHA256_HEX: "sha256", HMAC_SHA512_HEX: "sha512" } as const;
const digest = (body: string, alg: keyof typeof ALGS = "HMAC_SHA256_HEX", secret = SECRET) =>
  createHmac(ALGS[alg], secret).update(body, "utf8").digest("hex");
const headersFor = (body: string, alg?: string, secret = SECRET) => ({
  "x-payload-digest": digest(body, (alg ?? "HMAC_SHA256_HEX") as keyof typeof ALGS, secret),
  ...(alg === undefined ? {} : { "x-payload-digest-alg": alg }),
});

const reviewed = (patch: Partial<SumsubPayload> = {}): SumsubPayload => ({
  applicantId: "app-123",
  correlationId: "corr-1",
  externalUserId: WALLET,
  levelName: "basic-kyc-level",
  type: "applicantReviewed",
  reviewStatus: "completed",
  reviewResult: { reviewAnswer: "GREEN" },
  createdAtMs: "2026-10-10 10:00:00.000",
  ...patch,
});
const body = (p: SumsubPayload = reviewed()) => JSON.stringify(p);

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? `no-code:${(error as Error).message}`;
  }
  return "did-not-throw";
};

describe("verifySumsubSignature: accepting", () => {
  for (const alg of Object.keys(ALGS)) {
    it(`accepts a correct ${alg} digest`, () => {
      const raw = body();
      const payload = verify(raw, headersFor(raw, alg), SECRET);
      assert.equal(payload.applicantId, "app-123");
    });
  }

  it("defaults to HMAC_SHA256_HEX when the algorithm header is absent", () => {
    const raw = body();
    assert.equal(verify(raw, headersFor(raw), SECRET).type, "applicantReviewed");
  });

  it("accepts an upper-case hex digest and a lower-case algorithm name", () => {
    const raw = body();
    const h = { "x-payload-digest": digest(raw).toUpperCase(), "x-payload-digest-alg": "hmac_sha256_hex" };
    assert.equal(verify(raw, h, SECRET).type, "applicantReviewed");
  });

  it("accepts the configured digestAlg and nothing else", () => {
    const raw = body();
    assert.ok(verify(raw, headersFor(raw, "HMAC_SHA512_HEX"), SECRET, { digestAlg: "HMAC_SHA512_HEX" }));
  });
});

describe("verifySumsubSignature: rejecting", () => {
  const raw = body();

  it("refuses everything when no webhook secret is configured, even a digest made with the empty secret", () => {
    // Verifying with "" would make the digest forgeable by anyone.
    assert.equal(codeOf(() => verify(raw, headersFor(raw, undefined, ""), "")), "webhook-not-configured");
  });

  it("rejects a missing digest", () => {
    assert.equal(codeOf(() => verify(raw, {}, SECRET)), "signature-missing");
    assert.equal(codeOf(() => verify(raw, { "x-payload-digest": "  " }, SECRET)), "signature-missing");
  });

  it("rejects a non-hex digest", () => {
    assert.equal(codeOf(() => verify(raw, { "x-payload-digest": "not-hex!" }, SECRET)), "signature-malformed");
  });

  it("rejects an algorithm we do not implement", () => {
    const h = { ...headersFor(raw), "x-payload-digest-alg": "HMAC_MD5_HEX" };
    assert.equal(codeOf(() => verify(raw, h, SECRET)), "signature-alg-unsupported");
  });

  it("rejects an algorithm other than the pinned one, even with a valid digest", () => {
    // Downgrade protection: a deployment that pinned SHA-512 must not accept SHA-1.
    const h = headersFor(raw, "HMAC_SHA1_HEX");
    assert.equal(codeOf(() => verify(raw, h, SECRET, { digestAlg: "HMAC_SHA512_HEX" })), "signature-alg-unexpected");
  });

  it("rejects a digest computed over a different body", () => {
    const h = headersFor(body(reviewed({ applicantId: "someone-else" })));
    assert.equal(codeOf(() => verify(raw, h, SECRET)), "signature-invalid");
  });

  it("rejects a digest computed with a different secret", () => {
    assert.equal(codeOf(() => verify(raw, headersFor(raw, undefined, "other-secret"), SECRET)), "signature-invalid");
  });

  it("rejects a truncated digest and a digest padded past the HMAC length", () => {
    const full = digest(raw);
    assert.equal(codeOf(() => verify(raw, { "x-payload-digest": full.slice(0, 32) }, SECRET)), "signature-invalid");
    assert.equal(codeOf(() => verify(raw, { "x-payload-digest": `${full}00` }, SECRET)), "signature-invalid");
  });

  it("rejects a valid digest over a body that is not JSON", () => {
    const notJson = "applicantReviewed GREEN";
    assert.equal(codeOf(() => verify(notJson, headersFor(notJson), SECRET)), "body-malformed");
  });

  it("rejects a valid digest over JSON that is not a Sumsub event", () => {
    for (const odd of ["{}", "[]", "null", JSON.stringify({ type: 3 }), JSON.stringify({ applicantId: "x" })]) {
      assert.equal(codeOf(() => verify(odd, headersFor(odd), SECRET)), "body-malformed", odd);
    }
  });

  it("fails on a one-byte change at every position of the body", () => {
    // Proves the digest covers the whole raw body, not a parsed subset of it.
    const header = headersFor(raw);
    for (let i = 0; i < raw.length; i++) {
      const flipped = raw.slice(0, i) + String.fromCharCode(raw.charCodeAt(i) ^ 1) + raw.slice(i + 1);
      assert.equal(codeOf(() => verify(flipped, header, SECRET)), "signature-invalid", `byte ${i}`);
    }
  });

  it("fails when the body is re-serialised with different whitespace", () => {
    const pretty = JSON.stringify(reviewed(), null, 2);
    assert.equal(codeOf(() => verify(pretty, headersFor(raw), SECRET)), "signature-invalid");
  });
});

describe("payloadToProviderEvent", () => {
  it("maps GREEN to kyc.approved with the wallet from externalUserId", () => {
    const event = payloadToProviderEvent(reviewed());
    assert.equal(event.kind, "kyc.approved");
    assert.equal(event.wallet, WALLET);
    assert.equal(event.applicantId, "app-123");
    assert.equal(event.levelName, "basic-kyc-level");
    assert.equal(event.reason, undefined);
    assert.equal(event.ref, eventRef(reviewed()));
  });

  for (const reviewRejectType of ["FINAL", "RETRY"]) {
    it(`maps RED/${reviewRejectType} to kyc.rejected carrying the reject type`, () => {
      const event = payloadToProviderEvent(reviewed({ reviewResult: { reviewAnswer: "RED", reviewRejectType } }));
      assert.equal(event.kind, "kyc.rejected");
      assert.equal(event.reason, reviewRejectType);
    });
  }

  it("falls back to RED as the reason when Sumsub gives no reject type", () => {
    assert.equal(payloadToProviderEvent(reviewed({ reviewResult: { reviewAnswer: "RED" } })).reason, "RED");
  });

  it("does not put rejectLabels (free-form review detail) into the event", () => {
    const event = payloadToProviderEvent(reviewed({ reviewResult: { reviewAnswer: "RED", reviewRejectType: "FINAL", rejectLabels: ["FORGERY"] } }));
    assert.ok(!JSON.stringify(event).includes("FORGERY"));
  });

  it("is case-insensitive about the review answer", () => {
    assert.equal(payloadToProviderEvent(reviewed({ reviewResult: { reviewAnswer: "green" } })).kind, "kyc.approved");
  });

  for (const type of ["applicantCreated", "applicantPending", "applicantOnHold", "applicantReset"]) {
    it(`ignores ${type}`, () => {
      assert.equal(codeOf(() => payloadToProviderEvent(reviewed({ type }))), "event-ignored");
    });
  }

  it("refuses an event with no externalUserId: there is nobody to attest", () => {
    assert.equal(codeOf(() => payloadToProviderEvent(reviewed({ externalUserId: undefined }))), "wallet-missing");
    assert.equal(codeOf(() => payloadToProviderEvent(reviewed({ externalUserId: "" }))), "wallet-missing");
  });

  it("refuses an event with no applicantId", () => {
    assert.equal(codeOf(() => payloadToProviderEvent(reviewed({ applicantId: undefined }))), "applicant-missing");
  });

  it("ignores a review with a non-final or unknown answer", () => {
    for (const reviewResult of [undefined, {}, { reviewAnswer: "PENDING" }, { reviewAnswer: "YELLOW" }]) {
      assert.equal(codeOf(() => payloadToProviderEvent(reviewed({ reviewResult }))), "event-ignored", JSON.stringify(reviewResult));
    }
  });
});

describe("eventRef", () => {
  it("is stable for the same payload", () => {
    assert.equal(eventRef(reviewed()), eventRef(reviewed()));
  });

  it("uses correlationId when present", () => {
    assert.equal(eventRef(reviewed({ correlationId: "abc" })), "sumsub-abc-GREEN");
  });

  // Sumsub may reuse one correlationId for a GREEN and a later RED: the RED must not replay the GREEN.
  it("keeps GREEN and RED apart even under one correlationId", () => {
    const red = reviewed({ correlationId: "abc", reviewResult: { reviewAnswer: "RED" } });
    assert.notEqual(eventRef(red), eventRef(reviewed({ correlationId: "abc" })));
  });

  it("falls back to the composite of type, applicant, answer and timestamp", () => {
    const ref = eventRef(reviewed({ correlationId: undefined }));
    assert.equal(ref, "sumsub-applicantReviewed-app-123-GREEN-2026-10-10 10:00:00.000");
    assert.equal(eventRef(reviewed({ correlationId: "" })), ref);
  });

  it("differs between a GREEN and a RED for the same applicant, with or without a correlationId", () => {
    // Otherwise a rejection after an approval would replay the approval's record and never revoke.
    const red = { reviewAnswer: "RED", reviewRejectType: "FINAL" };
    const noCorr = { correlationId: undefined };
    assert.notEqual(eventRef(reviewed({ ...noCorr })), eventRef(reviewed({ ...noCorr, reviewResult: red })));
  });
});

describe("signRequest", () => {
  const cfg = { appToken: "tok_app", secretKey: "sk_secret" };

  it("signs ts + METHOD + path?query + body with HMAC-SHA256 and emits the three headers", () => {
    const now = 1_760_000_000_123;
    const path = "/resources/x/websdkLink?externalUserId=abc&ttlInSecs=60";
    const out = signRequest(cfg, "POST", path, '{"a":1}', now);
    const expected = createHmac("sha256", "sk_secret").update(`1760000000POST${path}{"a":1}`).digest("hex");
    assert.deepEqual(out, { "x-app-token": "tok_app", "x-app-access-ts": "1760000000", "x-app-access-sig": expected });
  });

  it("upper-cases the method before signing", () => {
    assert.deepEqual(signRequest(cfg, "post", "/p", "", 5000), signRequest(cfg, "POST", "/p", "", 5000));
  });

  it("covers the body and the query: changing either changes the signature", () => {
    const base = signRequest(cfg, "POST", "/p?a=1", "x", 5000)["x-app-access-sig"];
    assert.notEqual(base, signRequest(cfg, "POST", "/p?a=2", "x", 5000)["x-app-access-sig"]);
    assert.notEqual(base, signRequest(cfg, "POST", "/p?a=1", "y", 5000)["x-app-access-sig"]);
  });
});

describe("createSumsubKyc", () => {
  const config: SumsubConfig = {
    appToken: "tok_app_SECRETTOKEN",
    secretKey: "sk_SECRETKEY",
    webhookSecret: SECRET,
    apiBase: "https://sumsub.test",
    levelName: "my level/with space",
    linkTtlSeconds: 900,
    maxEventAgeSeconds: 600,
    digestAlg: "",
  };
  type Call = { url: string; init: RequestInit };
  const fakeFetch = (respond: () => Response) => {
    const calls: Call[] = [];
    const fn = (async (input: unknown, init: RequestInit) => {
      calls.push({ url: String(input), init });
      return respond();
    }) as unknown as typeof fetch;
    return { fn, calls };
  };

  it("asks for a link at the configured level for this wallet and returns the url from the response", async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ url: "https://in.sumsub.test/idensic/l/#/abc" }));
    const kyc = createSumsubKyc(config, { fetch: fn });
    const out = await kyc.start(WALLET);
    assert.deepEqual(out, { url: "https://in.sumsub.test/idensic/l/#/abc" });

    assert.equal(calls.length, 1);
    const { url, init } = calls[0]!;
    assert.ok(url.startsWith("https://sumsub.test/resources/sdkIntegrations/levels/"));
    assert.ok(url.includes(encodeURIComponent("my level/with space")), url);
    assert.ok(url.includes(`externalUserId=${WALLET}`), url);
    assert.ok(url.includes("ttlInSecs=900"), url);
    assert.equal(init.method, "POST");

    const headers = init.headers as Record<string, string>;
    assert.equal(headers["x-app-token"], config.appToken);
    assert.match(headers["x-app-access-ts"]!, /^\d{10}$/);
    // Recompute independently from the headers actually sent, so the signature is tied to the request.
    const path = url.slice("https://sumsub.test".length);
    const expected = createHmac("sha256", config.secretKey).update(`${headers["x-app-access-ts"]}POST${path}${init.body}`).digest("hex");
    assert.equal(headers["x-app-access-sig"], expected);
  });

  it("raises SumsubApiError with the status on a non-ok response, without leaking the token or secret", async () => {
    const { fn } = fakeFetch(() => Response.json({ description: "Applicant level not found", code: 404 }, { status: 404 }));
    const kyc = createSumsubKyc(config, { fetch: fn });
    await assert.rejects(
      () => kyc.start(WALLET),
      (error: unknown) => {
        assert.ok(error instanceof SumsubApiError);
        assert.equal(error.status, 404);
        for (const secret of [config.appToken, config.secretKey, config.webhookSecret]) {
          assert.ok(!error.message.includes(secret));
          assert.ok(!String(error.stack).includes(secret));
        }
        return true;
      },
    );
  });

  it("still raises SumsubApiError, with a generic message, when the failure body is not JSON", async () => {
    const { fn } = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await assert.rejects(
      () => createSumsubKyc(config, { fetch: fn }).start(WALLET),
      (error: unknown) => error instanceof SumsubApiError && error.status === 502 && !error.message.includes(config.secretKey),
    );
  });

  it("refuses an ok response that carries no url", async () => {
    const { fn } = fakeFetch(() => Response.json({}));
    await assert.rejects(() => createSumsubKyc(config, { fetch: fn }).start(WALLET), SumsubApiError);
  });

  it("webhook() verifies with the webhook secret, not the API secret", async () => {
    const kyc = createSumsubKyc(config, { now: () => NOW });
    const raw = body();
    const event = await kyc.webhook(headersFor(raw), raw);
    assert.equal((event as { kind: string }).kind, "kyc.approved");
    const wrong = headersFor(raw, undefined, config.secretKey);
    await assert.rejects(async () => kyc.webhook(wrong, raw), { code: "signature-invalid" });
  });
});

describe("webhook freshness", () => {
  // Sumsub's digest has no timestamp, so this window is the only thing between a captured GREEN
  // and a wallet that has since been revoked.
  const CREATED = Date.UTC(2026, 9, 10, 10, 0, 0);
  const at = (offsetSeconds: number) => ({ now: CREATED + offsetSeconds * 1000, maxAgeSeconds: 600 });
  const raw = body();

  it("accepts a fresh event", () => {
    assert.equal(verifySumsubSignature(raw, headersFor(raw), SECRET, at(5)).type, "applicantReviewed");
  });

  it("accepts an event exactly at the boundary and refuses one second past it", () => {
    assert.ok(verifySumsubSignature(raw, headersFor(raw), SECRET, at(600)));
    assert.equal(codeOf(() => verifySumsubSignature(raw, headersFor(raw), SECRET, at(601))), "event-stale");
  });

  it("refuses a future-dated event, with the same boundary", () => {
    assert.ok(verifySumsubSignature(raw, headersFor(raw), SECRET, at(-600)));
    assert.equal(codeOf(() => verifySumsubSignature(raw, headersFor(raw), SECRET, at(-601))), "event-stale");
  });

  it("refuses a missing or unreadable createdAtMs instead of failing open", () => {
    for (const createdAtMs of [undefined, "", "yesterday", "2026-13-45 99:99:99", null]) {
      const stamped = JSON.stringify({ ...reviewed(), createdAtMs });
      assert.equal(codeOf(() => verifySumsubSignature(stamped, headersFor(stamped), SECRET, at(0))), "event-stale", String(createdAtMs));
    }
  });

  it("honours a custom window", () => {
    assert.equal(codeOf(() => verifySumsubSignature(raw, headersFor(raw), SECRET, { now: CREATED + 61_000, maxAgeSeconds: 60 })), "event-stale");
    assert.ok(verifySumsubSignature(raw, headersFor(raw), SECRET, { now: CREATED + 61_000, maxAgeSeconds: 120 }));
  });

  it("defaults the window to ten minutes", () => {
    assert.ok(verifySumsubSignature(raw, headersFor(raw), SECRET, { now: CREATED + 600_000 }));
    assert.equal(codeOf(() => verifySumsubSignature(raw, headersFor(raw), SECRET, { now: CREATED + 601_000 })), "event-stale");
  });

  it("reports a bad signature, not staleness, for a stale event with the wrong digest", () => {
    // Staleness is checked after the signature so nobody can probe the window without the secret.
    const bad = headersFor(raw, undefined, "other-secret");
    assert.equal(codeOf(() => verifySumsubSignature(raw, bad, SECRET, at(10_000))), "signature-invalid");
  });

  it("is applied by createSumsubKyc with its configured window and injected clock", async () => {
    const config: SumsubConfig = {
      appToken: "t", secretKey: "k", webhookSecret: SECRET, apiBase: "https://sumsub.test", levelName: "l", linkTtlSeconds: 60, digestAlg: "", maxEventAgeSeconds: 60,
    };
    const fresh = createSumsubKyc(config, { now: () => CREATED + 30_000 });
    const stale = createSumsubKyc(config, { now: () => CREATED + 90_000 });
    assert.equal(((await fresh.webhook(headersFor(raw), raw)) as { kind: string }).kind, "kyc.approved");
    await assert.rejects(async () => stale.webhook(headersFor(raw), raw), { code: "event-stale" });
  });
});

describe("parseCreatedAtMs", () => {
  it("reads Sumsub's UTC wall-clock string, with and without fractional seconds", () => {
    assert.equal(parseCreatedAtMs("2020-02-21 13:23:19.321"), Date.UTC(2020, 1, 21, 13, 23, 19, 321));
    assert.equal(parseCreatedAtMs("2020-02-21 13:23:19"), Date.UTC(2020, 1, 21, 13, 23, 19));
  });

  it("reads the string as UTC regardless of the process's time zone", () => {
    assert.equal(parseCreatedAtMs("2026-10-10 10:00:00.000"), Date.UTC(2026, 9, 10, 10, 0, 0));
  });

  it("accepts an ISO string and an epoch number", () => {
    assert.equal(parseCreatedAtMs("2020-02-21T13:23:19.321Z"), Date.UTC(2020, 1, 21, 13, 23, 19, 321));
    assert.equal(parseCreatedAtMs(1_582_291_399_321), 1_582_291_399_321);
  });

  it("returns null for anything unreadable", () => {
    for (const v of [undefined, null, "", "   ", "garbage", "2020-02-30x", Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
      assert.equal(parseCreatedAtMs(v), null, String(v));
    }
  });
});
