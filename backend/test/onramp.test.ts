import "./noenv.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  OnrampError,
  WebhookError,
  createOnramp,
  createMockOnramp,
  mockCheckoutPage,
  formatRate,
  jsonForScript,
  type OnrampConfig,
  type OnrampTreasury,
} from "../src/providers/onramp.ts";
import { parsePln, parseRate, parseUsdc } from "../src/providers/money.ts";

const WALLET = "EBMibFLTvr5GDpgxNqt5Gqp9B1xLMr32aNwGDJV2oGJ6";
const OTHER = "11111111111111111111111111111111";
const SECRET = "whsec_test_secret";

const baseConfig = (patch: Partial<OnrampConfig> = {}): OnrampConfig => ({
  provider: "mock",
  rateScaled: parseRate("4.30"),
  minPln: parsePln("10"),
  maxPln: parsePln("5000"),
  maxUsdcPerWalletPerDay: parseUsdc("2000"),
  backendUrl: "http://backend.test",
  appUrl: "http://app.test",
  ...patch,
});

const stripeConfig = (patch: Partial<OnrampConfig> = {}): OnrampConfig =>
  baseConfig({
    provider: "stripe",
    stripe: {
      secretKey: "sk_test_x",
      webhookSecret: SECRET,
      apiBase: "https://stripe.invalid",
      toleranceSeconds: 300,
      paymentMethods: ["card"],
      plnPerUsdc: parseRate("4.30"),
    },
    ...patch,
  });

const report = { supply: 1n, reserve: 1n, ok: true, headroom: 0n, reserveSource: "mock-ledger" as const };

/** A treasury that records calls. `gate` holds `wrap` open so a test can race a duplicate against it. */
function fakeTreasury(opts: { gate?: Promise<void> } = {}) {
  const calls = { creditReserve: [] as Array<{ amount: bigint; ref?: string }>, wrap: [] as Array<{ wallet: string; amount: bigint; ref?: string }>, wrapAndMakeConfidential: [] as Array<Record<string, unknown>> };
  const treasury = {
    mode: "mock" as const,
    creditReserve(amount: bigint, ref?: string) {
      calls.creditReserve.push({ amount, ref });
      return amount;
    },
    async wrap(args: { wallet: string; amount: bigint; ref?: string }) {
      calls.wrap.push(args);
      if (opts.gate !== undefined) await opts.gate;
      return { token: WALLET, signatures: ["sig-wrap"], invariantBefore: report, invariantAfter: report };
    },
    async wrapAndMakeConfidential(args: Record<string, unknown>) {
      calls.wrapAndMakeConfidential.push(args);
      return { token: WALLET, confidentialAmount: 1n, publicRemaining: 0n, invariantAfter: report };
    },
    async invariant() {
      return report;
    },
  };
  return { treasury: treasury as unknown as OnrampTreasury, calls };
}

const mockBody = (intent: string, extra: Record<string, unknown> = {}) => JSON.stringify({ intent, ...extra });

function mockService(patch: Partial<OnrampConfig> = {}, t = fakeTreasury(), now?: () => number) {
  const svc = createOnramp({ config: baseConfig(patch), treasury: async () => t.treasury, now });
  return { svc, ...t };
}

const stripeEventBody = (patch: { id?: string; session?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) =>
  JSON.stringify({
    id: patch.id ?? "evt_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_1",
        amount_total: 40000,
        currency: "pln",
        payment_status: "paid",
        metadata: { wallet: WALLET, plnPerUsdc: "4.30", holdback: "0", intent: "i-1" },
        ...patch.session,
      },
    },
    ...patch.extra,
  });
const signedHeaders = (body: string, secret = SECRET) => {
  const t = Math.floor(Date.now() / 1000);
  return { "stripe-signature": `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}` };
};

describe("onramp checkout", () => {
  it("prices a top-up server-side and returns a mock URL", async () => {
    const { svc } = mockService();
    const out = await svc.checkout({ wallet: WALLET, amountPln: parsePln("400") });
    assert.equal(out.provider, "mock");
    assert.equal(out.simulated, true);
    assert.equal(out.amountPln, "400.00");
    assert.equal(out.amountUsdc, "93.023255");
    assert.equal(out.plnPerUsdc, "4.30");
    assert.match(out.url, /^http:\/\/backend\.test\/mock\/onramp\?intent=/);
    assert.ok(svc.intent(out.intent));
    assert.equal(svc.intent(out.intent)!.wallet, WALLET);
  });

  it("refuses an amount below the minimum and above the maximum", async () => {
    const { svc } = mockService();
    for (const pln of ["9.99", "5000.01"]) {
      await assert.rejects(
        () => svc.checkout({ wallet: WALLET, amountPln: parsePln(pln) }),
        (e: unknown) => e instanceof OnrampError && e.code === "amount-out-of-range" && e.status === 400,
      );
    }
    await svc.checkout({ wallet: WALLET, amountPln: parsePln("10") });
    await svc.checkout({ wallet: WALLET, amountPln: parsePln("5000") });
  });

  it("refuses a holdback larger than what the top-up buys", async () => {
    const { svc } = mockService();
    await assert.rejects(
      () => svc.checkout({ wallet: WALLET, amountPln: parsePln("100"), holdbackUsdc: parseUsdc("1000") }),
      (e: unknown) => e instanceof OnrampError && e.code === "holdback-too-large",
    );
    // equal to the whole purchase is allowed
    const out = await svc.checkout({ wallet: WALLET, amountPln: parsePln("43"), holdbackUsdc: parseUsdc("10") });
    assert.equal(out.publicHoldback, "10.000000");
  });

  it("refuses a malformed wallet", async () => {
    const { svc } = mockService();
    await assert.rejects(
      () => svc.checkout({ wallet: "not-an-address", amountPln: parsePln("100") }),
      (e: unknown) => e instanceof OnrampError && e.code === "malformed-wallet",
    );
  });

  it("refuses a top-up that would pass the wallet's daily cap, and stores no intent", async () => {
    const { svc } = mockService({ maxUsdcPerWalletPerDay: parseUsdc("50") });
    await assert.rejects(
      () => svc.checkout({ wallet: WALLET, amountPln: parsePln("400") }),
      (e: unknown) => e instanceof OnrampError && e.code === "wallet-cap" && e.status === 429,
    );
  });

  it("stores no intent when the provider returns no URL", async () => {
    const svc = createOnramp({
      config: baseConfig(),
      treasury: async () => fakeTreasury().treasury,
      provider: { async start() { return { url: "" }; }, async webhook() { throw new Error("unused"); } },
    });
    await assert.rejects(
      () => svc.checkout({ wallet: WALLET, amountPln: parsePln("100") }),
      (e: unknown) => e instanceof OnrampError && e.code === "provider-no-url" && e.status === 502,
    );
  });
});

describe("onramp credit (mock provider)", () => {
  it("credits the intent's wallet and amount once, reserve first", async () => {
    const { svc, calls } = mockService();
    const out = await svc.checkout({ wallet: WALLET, amountPln: parsePln("400") });
    assert.equal(svc.creditForIntent(out.intent), undefined);

    const { credit, replay } = await svc.handleWebhook({}, mockBody(out.intent));
    assert.equal(replay, false);
    assert.equal(credit.status, "credited");
    assert.equal(credit.wallet, WALLET);
    assert.equal(credit.amountUsdc, "93023255");
    assert.equal(credit.amountPln, "40000");
    assert.equal(credit.confidentialPending, true);
    assert.deepEqual(calls.creditReserve, [{ amount: 93_023_255n, ref: `onramp:mock-${out.intent}` }]);
    assert.equal(calls.wrap.length, 1);
    assert.equal(calls.wrap[0]!.wallet, WALLET);
    assert.equal(calls.wrap[0]!.amount, 93_023_255n);
    assert.equal(svc.creditForIntent(out.intent)?.status, "credited");
  });

  it("a replayed event id credits once", async () => {
    const { svc, calls } = mockService();
    const out = await svc.checkout({ wallet: WALLET, amountPln: parsePln("400") });
    const first = await svc.handleWebhook({}, mockBody(out.intent));
    const second = await svc.handleWebhook({}, mockBody(out.intent));
    assert.equal(first.replay, false);
    assert.equal(second.replay, true);
    assert.equal(second.credit, first.credit);
    assert.equal(calls.wrap.length, 1);
    assert.equal(calls.creditReserve.length, 1);
  });

  it("a concurrent duplicate credits once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { svc, calls } = mockService({}, fakeTreasury({ gate }));
    const out = await svc.checkout({ wallet: WALLET, amountPln: parsePln("400") });

    const a = svc.handleWebhook({}, mockBody(out.intent));
    const b = svc.handleWebhook({}, mockBody(out.intent));
    // let both reach the treasury before the first mint finishes
    await new Promise((r) => setImmediate(r));
    release();
    const [ra, rb] = await Promise.all([a, b]);

    assert.equal(calls.wrap.length, 1);
    assert.equal(calls.creditReserve.length, 1);
    assert.deepEqual([ra.replay, rb.replay].sort(), [false, true]);
    assert.equal(ra.credit, rb.credit);
  });

  it("amount and wallet come from the stored intent, never from the request body", async () => {
    const { svc, calls } = mockService();
    const out = await svc.checkout({ wallet: WALLET, amountPln: parsePln("400") });
    const { credit } = await svc.handleWebhook(
      {},
      mockBody(out.intent, { amountUsdc: 999_999_999_999, amount: "999999999999", wallet: OTHER, plnMinor: "99999999999", holdback: "5" }),
    );
    assert.equal(credit.wallet, WALLET);
    assert.equal(credit.amountUsdc, "93023255");
    assert.equal(calls.wrap[0]!.wallet, WALLET);
    assert.equal(calls.wrap[0]!.amount, 93_023_255n);
    assert.equal(credit.publicHoldback, "0");
  });

  it("an unknown intent is refused and credits nothing", async () => {
    const { svc, calls } = mockService();
    await assert.rejects(
      () => svc.handleWebhook({}, mockBody("nope")),
      (e: unknown) => e instanceof WebhookError && e.code === "intent-unknown",
    );
    assert.equal(calls.wrap.length, 0);
    assert.equal(calls.creditReserve.length, 0);
  });

  it("a body that is not { intent } is refused", async () => {
    const { svc, calls } = mockService();
    for (const body of ["not json", "{}", JSON.stringify({ intent: "" }), JSON.stringify({ intent: 5 }), JSON.stringify({ wallet: WALLET, amountUsdc: 5 })]) {
      await assert.rejects(() => svc.handleWebhook({}, body), (e: unknown) => e instanceof WebhookError && e.code === "body-malformed", body);
    }
    assert.equal(calls.wrap.length, 0);
  });

  it("carries the public holdback from the intent", async () => {
    const { svc } = mockService();
    const out = await svc.checkout({ wallet: WALLET, amountPln: parsePln("430"), holdbackUsdc: parseUsdc("25") });
    const { credit } = await svc.handleWebhook({}, mockBody(out.intent));
    assert.equal(credit.publicHoldback, "25000000");
    assert.equal(credit.confidentialAmount, "75000000");
  });

  it("finishes the confidential move when the owner's keys are available", async () => {
    const t = fakeTreasury();
    const owner = { address: WALLET };
    const keys = { k: 1 };
    const svc = createOnramp({
      config: baseConfig(),
      treasury: async () => t.treasury,
      resolveOwner: async (wallet) => (wallet === WALLET ? ({ owner, keys } as never) : null),
    });
    const out = await svc.checkout({ wallet: WALLET, amountPln: parsePln("430"), holdbackUsdc: parseUsdc("25") });
    const { credit } = await svc.handleWebhook({}, mockBody(out.intent));
    assert.equal(credit.confidentialPending, false);
    assert.equal(t.calls.wrap.length, 0);
    assert.equal(t.calls.wrapAndMakeConfidential.length, 1);
    assert.equal(t.calls.wrapAndMakeConfidential[0]!.amount, 100_000_000n);
    assert.equal(t.calls.wrapAndMakeConfidential[0]!.publicHoldback, 25_000_000n);
  });

  it("records a final rejection, without minting, when the daily cap is already used", async () => {
    // cap 100 rUSDC; each ~93.02 rUSDC top-up passes checkout, only one can be credited
    const { svc, calls } = mockService({ maxUsdcPerWalletPerDay: parseUsdc("100") });
    const a = await svc.checkout({ wallet: WALLET, amountPln: parsePln("400") });
    const b = await svc.checkout({ wallet: WALLET, amountPln: parsePln("400") });
    assert.equal((await svc.handleWebhook({}, mockBody(a.intent))).credit.status, "credited");
    const second = await svc.handleWebhook({}, mockBody(b.intent));
    assert.equal(second.credit.status, "rejected");
    assert.match(second.credit.reason ?? "", /daily cap/);
    assert.equal(calls.wrap.length, 1);
    assert.equal(svc.creditForIntent(b.intent)?.status, "rejected");
  });

  it("the daily cap window expires", async () => {
    let clock = 1_000_000;
    const { svc, calls } = mockService({ maxUsdcPerWalletPerDay: parseUsdc("100") }, fakeTreasury(), () => clock);
    const a = await svc.checkout({ wallet: WALLET, amountPln: parsePln("400") });
    await svc.handleWebhook({}, mockBody(a.intent));
    clock += 86_400_001;
    const b = await svc.checkout({ wallet: WALLET, amountPln: parsePln("400") });
    assert.equal((await svc.handleWebhook({}, mockBody(b.intent))).credit.status, "credited");
    assert.equal(calls.wrap.length, 2);
  });

  it("remainingToday shrinks by what was credited", async () => {
    const { svc } = mockService({ maxUsdcPerWalletPerDay: parseUsdc("200") });
    assert.equal(svc.remainingToday(WALLET), 200_000_000n);
    const out = await svc.checkout({ wallet: WALLET, amountPln: parsePln("400") });
    await svc.handleWebhook({}, mockBody(out.intent));
    assert.equal(svc.remainingToday(WALLET), 200_000_000n - 93_023_255n);
    assert.equal(svc.remainingToday(OTHER), 200_000_000n);
  });
});

describe("onramp credit (stripe provider)", () => {
  const stripeSvc = (t = fakeTreasury()) => ({ svc: createOnramp({ config: stripeConfig(), treasury: async () => t.treasury }), ...t });

  it("credits the amount and wallet that the signed event carries", async () => {
    const { svc, calls } = stripeSvc();
    const body = stripeEventBody();
    const { credit, replay } = await svc.handleWebhook(signedHeaders(body), body);
    assert.equal(replay, false);
    assert.equal(credit.ref, "evt_1");
    assert.equal(credit.amountUsdc, "93023255");
    assert.equal(credit.wallet, WALLET);
    assert.equal(calls.wrap[0]!.amount, 93_023_255n);
  });

  it("the same Stripe event id delivered twice credits exactly once", async () => {
    const { svc, calls } = stripeSvc();
    const body = stripeEventBody();
    const first = await svc.handleWebhook(signedHeaders(body), body);
    const second = await svc.handleWebhook(signedHeaders(body), body);
    assert.equal(first.replay, false);
    assert.equal(second.replay, true);
    assert.equal(calls.wrap.length, 1);
    assert.equal(calls.creditReserve.length, 1);
  });

  it("a different event id for the same session is a different credit", async () => {
    const { svc, calls } = stripeSvc();
    for (const id of ["evt_1", "evt_2"]) {
      const body = stripeEventBody({ id });
      await svc.handleWebhook(signedHeaders(body), body);
    }
    assert.equal(calls.wrap.length, 2);
  });

  it("a concurrent duplicate of a signed event credits once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { svc, calls } = stripeSvc(fakeTreasury({ gate }));
    const body = stripeEventBody();
    const a = svc.handleWebhook(signedHeaders(body), body);
    const b = svc.handleWebhook(signedHeaders(body), body);
    await new Promise((r) => setImmediate(r));
    release();
    await Promise.all([a, b]);
    assert.equal(calls.wrap.length, 1);
  });

  it("an unsigned body claiming a huge amount credits nothing", async () => {
    const { svc, calls } = stripeSvc();
    const body = stripeEventBody({ session: { amount_total: 400_000_000 } });
    for (const headers of [{}, signedHeaders(body, "whsec_attacker")]) {
      await assert.rejects(() => svc.handleWebhook(headers, body), (e: unknown) => e instanceof WebhookError);
    }
    assert.equal(calls.wrap.length, 0);
    assert.equal(calls.creditReserve.length, 0);
  });

  it("extra amount fields smuggled into a signed event do not change the credit", async () => {
    const { svc, calls } = stripeSvc();
    const body = stripeEventBody({ session: { amountUsdc: 999_999_999_999, amount: 999_999_999 }, extra: { amountUsdc: 999_999_999_999 } });
    const { credit } = await svc.handleWebhook(signedHeaders(body), body);
    assert.equal(credit.amountUsdc, "93023255");
    assert.equal(calls.wrap[0]!.amount, 93_023_255n);
  });

  it("an eur event is refused with wrong-currency and credits nothing", async () => {
    const { svc, calls } = stripeSvc();
    const body = stripeEventBody({ session: { currency: "eur" } });
    await assert.rejects(
      () => svc.handleWebhook(signedHeaders(body), body),
      (e: unknown) => e instanceof WebhookError && e.code === "wrong-currency",
    );
    assert.equal(calls.wrap.length, 0);
    assert.equal(calls.creditReserve.length, 0);
  });

  it("an event with no currency is refused with wrong-currency", async () => {
    const { svc, calls } = stripeSvc();
    const body = stripeEventBody({ session: { currency: undefined } });
    await assert.rejects(
      () => svc.handleWebhook(signedHeaders(body), body),
      (e: unknown) => e instanceof WebhookError && e.code === "wrong-currency",
    );
    assert.equal(calls.wrap.length, 0);
  });

  it("unpaid, wallet-less, bad-amount and unrelated events credit nothing", async () => {
    const { svc, calls } = stripeSvc();
    const cases: Array<[string, string]> = [
      ["not-paid", stripeEventBody({ session: { payment_status: "unpaid" } })],
      ["wallet-missing", stripeEventBody({ session: { metadata: { plnPerUsdc: "4.30" } } })],
      ["amount-missing", stripeEventBody({ session: { amount_total: 0 } })],
      ["amount-missing", stripeEventBody({ session: { amount_total: -5 } })],
      ["amount-missing", stripeEventBody({ session: { amount_total: 10.5 } })],
      ["event-ignored", stripeEventBody({ extra: { type: "payment_intent.succeeded" } })],
    ];
    for (const [code, body] of cases) {
      await assert.rejects(() => svc.handleWebhook(signedHeaders(body), body), (e: unknown) => e instanceof WebhookError && e.code === code, code);
    }
    assert.equal(calls.wrap.length, 0);
    assert.equal(calls.creditReserve.length, 0);
  });

  it("a signed event naming a non-address wallet is recorded as rejected, not minted", async () => {
    const { svc, calls } = stripeSvc();
    const body = stripeEventBody({ session: { metadata: { wallet: "not-an-address", plnPerUsdc: "4.30" } } });
    const { credit } = await svc.handleWebhook(signedHeaders(body), body);
    assert.equal(credit.status, "rejected");
    assert.equal(calls.wrap.length, 0);
  });

  it("a holdback larger than the credit is clamped, keeping everything public", async () => {
    const { svc } = stripeSvc();
    const body = stripeEventBody({ session: { metadata: { wallet: WALLET, plnPerUsdc: "4.30", holdback: "999999999999" } } });
    const { credit } = await svc.handleWebhook(signedHeaders(body), body);
    assert.equal(credit.publicHoldback, credit.amountUsdc);
    assert.equal(credit.confidentialAmount, "0");
  });
});

describe("createMockOnramp", () => {
  it("start points at the backend's mock page with the intent id", async () => {
    const provider = createMockOnramp({ intent: () => undefined, backendUrl: "http://b.test" });
    const { url } = await provider.start(WALLET, { metadata: { intent: "abc", wallet: WALLET, plnPerUsdc: "4.30", holdback: "0" }, returnBase: "http://app/#/x?topup=" });
    assert.equal(url, `http://b.test/mock/onramp?intent=abc&back=${encodeURIComponent("http://app/#/x?topup=")}`);
  });
});

describe("mockCheckoutPage", () => {
  const intent = {
    id: "i-1",
    wallet: WALLET,
    plnMinor: 40000n,
    amountUsdc: 93_023_255n,
    holdback: 0n,
    rateScaled: parseRate("4.30"),
    provider: "mock" as const,
    createdAt: 0,
  };

  it("renders the server-priced amounts", () => {
    const html = mockCheckoutPage(intent, "http://app.test/#/app?topup=");
    assert.match(html, /400\.00 PLN/);
    assert.match(html, /93\.023255 rUSDC/);
    assert.match(html, /4\.30 PLN \/ USDC/);
    assert.ok(html.includes(WALLET));
  });

  it("posts only the intent id back, never an amount", () => {
    const html = mockCheckoutPage(intent, "http://app.test/#/app?topup=");
    assert.ok(html.includes('JSON.stringify({ intent: "i-1" })'));
    assert.ok(!/amountUsdc/.test(html.split("<script")[1] ?? ""));
  });

  it("escapes the return URL in the cancel link", () => {
    const html = mockCheckoutPage(intent, 'http://app.test/"><b>x</b>');
    const link = html.split("\n").find((line) => line.includes("Cancel and go back")) ?? "";
    assert.ok(link.includes("&quot;&gt;&lt;b&gt;"), link);
  });

  it("a return URL cannot close the inline script block", () => {
    const html = mockCheckoutPage(intent, "http://app.test/</script><img src=x onerror=alert(1)>");
    assert.ok(!html.includes("</script><img"));
  });
});

describe("jsonForScript", () => {
  it("leaves no literal < in the output and round-trips through JSON.parse", () => {
    const value = "http://app/</script><img src=x onerror=alert(1)>&done";
    const out = jsonForScript(value);
    assert.ok(!out.includes("<") && !out.includes(">") && !out.includes("&"), out);
    assert.equal(JSON.parse(out), value);
  });

  it("escapes U+2028 and U+2029 and still round-trips", () => {
    const value = "a\u2028b\u2029c";
    const out = jsonForScript(value);
    assert.ok(!out.includes("\u2028") && !out.includes("\u2029"));
    assert.equal(JSON.parse(out), value);
  });

  it("round-trips objects too", () => {
    const value = { intent: "x</script>" };
    assert.deepEqual(JSON.parse(jsonForScript(value)), value);
  });
});

describe("formatRate", () => {
  it("keeps two places and trims trailing zeros beyond them", () => {
    assert.equal(formatRate(parseRate("4.30")), "4.30");
    assert.equal(formatRate(parseRate("4")), "4.00");
    assert.equal(formatRate(parseRate("4.123456")), "4.123456");
    assert.equal(formatRate(parseRate("4.1200")), "4.12");
  });
});
