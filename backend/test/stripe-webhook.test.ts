import "./noenv.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  WebhookError,
  createStripeOnramp,
  encodeForm,
  eventToProviderEvent,
  verifyStripeSignature,
  type CheckoutMetadata,
  type StripeConfig,
} from "../src/providers/stripe.ts";
import { parseRate } from "../src/providers/money.ts";

const SECRET = "whsec_test_secret";
const WALLET = "EBMibFLTvr5GDpgxNqt5Gqp9B1xLMr32aNwGDJV2oGJ6";
const NOW = 1_800_000_000_000; // ms
const T = Math.floor(NOW / 1000);

const sign = (body: string, secret = SECRET, t = T) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
const header = (body: string, secret = SECRET, t = T) => `t=${t},v1=${sign(body, secret, t)}`;

const session = (patch: Record<string, unknown> = {}) => ({
  id: "cs_test_1",
  amount_total: 40000,
  currency: "pln",
  payment_status: "paid",
  metadata: { wallet: WALLET, plnPerUsdc: "4.30", holdback: "0", intent: "i-1" },
  ...patch,
});
const event = (obj: Record<string, unknown> = session(), patch: Record<string, unknown> = {}) => ({
  id: "evt_1",
  type: "checkout.session.completed",
  data: { object: obj },
  ...patch,
});

const verify = (body: string, hdr: string | undefined, opts: { toleranceSeconds?: number } = {}) =>
  verifyStripeSignature(body, hdr, SECRET, { now: NOW, ...opts });

const rejectsWith = (code: string) => (e: unknown) => e instanceof WebhookError && e.code === code;

describe("verifyStripeSignature", () => {
  const body = JSON.stringify(event());

  it("accepts a correct signature over the exact raw bytes", () => {
    const parsed = verify(body, header(body));
    assert.equal(parsed.id, "evt_1");
    assert.equal(parsed.type, "checkout.session.completed");
  });

  it("accepts when one of several v1 signatures matches", () => {
    const hdr = `t=${T},v1=${"00".repeat(32)},v1=${sign(body)}`;
    assert.equal(verify(body, hdr).id, "evt_1");
  });

  it("rejects a signature made with the wrong secret", () => {
    assert.throws(() => verify(body, header(body, "whsec_other")), rejectsWith("signature-invalid"));
  });

  it("rejects a tampered body", () => {
    const hdr = header(body);
    const tampered = body.replace("40000", "40000000");
    assert.notEqual(tampered, body);
    assert.throws(() => verify(tampered, hdr), rejectsWith("signature-invalid"));
  });

  it("rejects a re-serialised body even though it parses to the same JSON", () => {
    const hdr = header(body);
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    assert.deepEqual(JSON.parse(reserialised), JSON.parse(body));
    assert.throws(() => verify(reserialised, hdr), rejectsWith("signature-invalid"));
  });

  it("rejects a missing or empty Stripe-Signature header", () => {
    assert.throws(() => verify(body, undefined), rejectsWith("signature-missing"));
    assert.throws(() => verify(body, ""), rejectsWith("signature-missing"));
    assert.throws(() => verify(body, "   "), rejectsWith("signature-missing"));
  });

  it("rejects a header with no timestamp", () => {
    assert.throws(() => verify(body, `v1=${sign(body)}`), rejectsWith("signature-malformed"));
  });

  it("rejects a header with a non-numeric timestamp", () => {
    assert.throws(() => verify(body, `t=abc,v1=${sign(body)}`), rejectsWith("signature-malformed"));
  });

  it("rejects a header with no v1 signature", () => {
    assert.throws(() => verify(body, `t=${T}`), rejectsWith("signature-malformed"));
    assert.throws(() => verify(body, `t=${T},v1=nothex`), rejectsWith("signature-malformed"));
  });

  it("rejects a v0-only header even when the v0 value is a valid HMAC", () => {
    assert.throws(() => verify(body, `t=${T},v0=${sign(body)}`), rejectsWith("signature-malformed"));
  });

  it("rejects an expired timestamp even with a valid signature", () => {
    const old = T - 301;
    assert.throws(() => verify(body, header(body, SECRET, old)), rejectsWith("signature-expired"));
  });

  it("rejects a timestamp in the future even with a valid signature", () => {
    const future = T + 301;
    assert.throws(() => verify(body, header(body, SECRET, future)), rejectsWith("signature-expired"));
  });

  it("accepts a timestamp exactly at the tolerance edge", () => {
    assert.equal(verify(body, header(body, SECRET, T - 300)).id, "evt_1");
  });

  it("honours a tighter configured tolerance", () => {
    assert.throws(() => verify(body, header(body, SECRET, T - 11), { toleranceSeconds: 10 }), rejectsWith("signature-expired"));
  });

  it("refuses to verify anything when no secret is configured", () => {
    assert.throws(() => verifyStripeSignature(body, header(body, ""), "", { now: NOW }), rejectsWith("webhook-not-configured"));
  });

  it("rejects a correctly signed body that is not JSON", () => {
    assert.throws(() => verify("not json", header("not json")), rejectsWith("body-malformed"));
  });

  it("rejects a correctly signed JSON body that is not a Stripe event", () => {
    const other = JSON.stringify({ hello: "world" });
    assert.throws(() => verify(other, header(other)), rejectsWith("body-malformed"));
  });

  it("never puts the secret or the signature in an error message", () => {
    try {
      verify(body, header(body, "whsec_other"));
      assert.fail("should have thrown");
    } catch (e) {
      const message = (e as Error).message;
      assert.ok(!message.includes(SECRET));
      assert.ok(!message.includes(sign(body, "whsec_other")));
    }
  });
});

describe("eventToProviderEvent", () => {
  const rate = parseRate("4.30");

  it("prices a paid PLN session from the signed event alone", () => {
    const e = eventToProviderEvent(event(session({ metadata: { wallet: WALLET, plnPerUsdc: "4.30", holdback: "1000000", intent: "i-1" } })), rate);
    assert.equal(e.kind, "onramp.completed");
    assert.equal(e.wallet, WALLET);
    assert.equal(e.ref, "evt_1");
    assert.equal(e.amountUsdc, 93_023_255);
    assert.equal(e.plnMinor, 40000n);
    assert.equal(e.holdback, 1_000_000n);
  });

  it("uses the rate pinned in the metadata over the fallback", () => {
    const e = eventToProviderEvent(event(session({ metadata: { wallet: WALLET, plnPerUsdc: "4.00" } })), rate);
    assert.equal(e.amountUsdc, 100_000_000);
  });

  it("falls back to the configured rate when metadata lost it", () => {
    const e = eventToProviderEvent(event(session({ metadata: { wallet: WALLET } })), rate);
    assert.equal(e.amountUsdc, 93_023_255);
  });

  it("refuses an eur session with wrong-currency", () => {
    assert.throws(() => eventToProviderEvent(event(session({ currency: "eur" })), rate), rejectsWith("wrong-currency"));
  });

  it("refuses a session with no currency with wrong-currency", () => {
    const { currency: _drop, ...noCurrency } = session();
    assert.throws(() => eventToProviderEvent(event(noCurrency), rate), rejectsWith("wrong-currency"));
    assert.throws(() => eventToProviderEvent(event(session({ currency: null })), rate), rejectsWith("wrong-currency"));
  });

  it("accepts the currency in upper case", () => {
    assert.equal(eventToProviderEvent(event(session({ currency: "PLN" })), rate).amountUsdc, 93_023_255);
  });

  it("refuses an unpaid session", () => {
    assert.throws(() => eventToProviderEvent(event(session({ payment_status: "unpaid" })), rate), rejectsWith("not-paid"));
    assert.throws(() => eventToProviderEvent(event(session({ payment_status: undefined })), rate), rejectsWith("not-paid"));
  });

  it("refuses a session with no metadata.wallet", () => {
    assert.throws(() => eventToProviderEvent(event(session({ metadata: { plnPerUsdc: "4.30" } })), rate), rejectsWith("wallet-missing"));
    assert.throws(() => eventToProviderEvent(event(session({ metadata: null })), rate), rejectsWith("wallet-missing"));
    assert.throws(() => eventToProviderEvent(event(session({ metadata: { wallet: "" } })), rate), rejectsWith("wallet-missing"));
  });

  for (const [label, total] of [
    ["zero", 0],
    ["negative", -100],
    ["fractional", 100.5],
    ["a string", "40000"],
    ["null", null],
    ["missing", undefined],
  ] as const) {
    it(`refuses an amount_total that is ${label}`, () => {
      assert.throws(() => eventToProviderEvent(event(session({ amount_total: total })), rate), rejectsWith("amount-missing"));
    });
  }

  it("refuses a malformed holdback", () => {
    assert.throws(
      () => eventToProviderEvent(event(session({ metadata: { wallet: WALLET, holdback: "-5" } })), rate),
      rejectsWith("holdback-malformed"),
    );
  });

  it("ignores event types it does not act on", () => {
    for (const type of ["payment_intent.succeeded", "checkout.session.expired", "charge.refunded"]) {
      assert.throws(() => eventToProviderEvent(event(session(), { type }), rate), rejectsWith("event-ignored"));
    }
  });
});

describe("createStripeOnramp", () => {
  const config: StripeConfig = {
    secretKey: "sk_test_secret_key",
    webhookSecret: SECRET,
    apiBase: "https://stripe.invalid",
    toleranceSeconds: 300,
    paymentMethods: ["card"],
    plnPerUsdc: parseRate("4.30"),
  };
  const metadata: CheckoutMetadata = { wallet: WALLET, plnPerUsdc: "4.30", holdback: "0", intent: "intent-1" };
  const startOpts = { grosz: 40000n, metadata, successUrl: "https://app/ok", cancelUrl: "https://app/no" };

  const fakeFetch = (respond: (url: string, init: RequestInit) => { status?: number; body: unknown }) => {
    const calls: Array<{ url: string; init: RequestInit; form: URLSearchParams }> = [];
    const fn = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const { status = 200, body } = respond(url, init ?? {});
      calls.push({ url, init: init ?? {}, form: new URLSearchParams(String(init?.body ?? "")) });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { fn, calls };
  };

  it("creates a PLN Checkout Session priced and tagged server-side", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { id: "cs_1", url: "https://checkout.stripe.invalid/c/1" } }));
    const provider = createStripeOnramp(config, { fetch: fn });
    const { url } = await provider.start(WALLET, startOpts);
    assert.equal(url, "https://checkout.stripe.invalid/c/1");
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call!.url, "https://stripe.invalid/v1/checkout/sessions");
    assert.equal((call!.init.headers as Record<string, string>).authorization, "Bearer sk_test_secret_key");
    assert.equal((call!.init.headers as Record<string, string>)["idempotency-key"], "intent-1");
    assert.equal(call!.form.get("line_items[0][price_data][currency]"), "pln");
    assert.equal(call!.form.get("line_items[0][price_data][unit_amount]"), "40000");
    assert.equal(call!.form.get("metadata[wallet]"), WALLET);
    assert.equal(call!.form.get("metadata[intent]"), "intent-1");
    assert.equal(call!.form.get("payment_method_types[0]"), "card");
    assert.equal(call!.form.get("mode"), "payment");
  });

  it("falls back to card when an extra payment method is rejected", async () => {
    const { fn, calls } = fakeFetch((_u, init) => {
      const form = new URLSearchParams(String(init.body));
      if (form.get("payment_method_types[1]") === "blik") {
        return { status: 400, body: { error: { message: "The payment method type provided: blik is invalid", code: "parameter_invalid_empty" } } };
      }
      return { body: { id: "cs_2", url: "https://checkout.stripe.invalid/c/2" } };
    });
    const provider = createStripeOnramp({ ...config, paymentMethods: ["card", "blik"] }, { fetch: fn });
    const { url } = await provider.start(WALLET, startOpts);
    assert.equal(url, "https://checkout.stripe.invalid/c/2");
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.form.get("payment_method_types[1]"), null);
  });

  it("surfaces a Stripe failure without echoing the secret key", async () => {
    const { fn } = fakeFetch(() => ({ status: 401, body: { error: { message: "Invalid API Key provided", code: "api_key_invalid" } } }));
    const provider = createStripeOnramp(config, { fetch: fn });
    await assert.rejects(
      () => provider.start(WALLET, startOpts),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.equal((e as { status?: number }).status, 401);
        assert.ok(!e.message.includes("sk_test_secret_key"));
        return true;
      },
    );
  });

  it("rejects a session that comes back with no URL", async () => {
    const { fn } = fakeFetch(() => ({ body: { id: "cs_3" } }));
    await assert.rejects(() => createStripeOnramp(config, { fetch: fn }).start(WALLET, startOpts), /no URL/);
  });

  it("parse verifies the signature before it prices anything", () => {
    const provider = createStripeOnramp(config, { fetch: (async () => assert.fail("no network")) as typeof fetch });
    const body = JSON.stringify(event());
    // parse() reads the real clock, so sign with the real time.
    const t = Math.floor(Date.now() / 1000);
    const ok = provider.parse({ "stripe-signature": header(body, SECRET, t) }, body);
    assert.equal(ok.amountUsdc, 93_023_255);
    assert.throws(() => provider.parse({ "stripe-signature": header(body, "whsec_other", t) }, body), (e: unknown) => e instanceof WebhookError);
    assert.throws(() => provider.parse({}, body), rejectsWith("signature-missing"));
  });
});

describe("encodeForm", () => {
  it("skips undefined values and stringifies numbers", () => {
    assert.equal(encodeForm({ a: 1, b: undefined, "c[d]": "x y" }), "a=1&c%5Bd%5D=x+y");
  });
});
