import "./noenv.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

// env.ts is read once at import; noenv.ts already blanked every secret and
// ONRAMP_PROVIDER is unset, i.e. the no-secrets mock default.
const { createApp, safeReturnBase } = await import("../src/server.ts");
const { createSessionToken } = await import("../src/auth.ts");
const { createOnramp } = await import("../src/providers/onramp.ts");
const { createOfframp } = await import("../src/providers/offramp.ts");
const { parsePln, parseRate, parseUsdc } = await import("../src/providers/money.ts");
import type { OnrampConfig, OnrampTreasury } from "../src/providers/onramp.ts";
import type { Services } from "../src/services.ts";

const WALLET = "EBMibFLTvr5GDpgxNqt5Gqp9B1xLMr32aNwGDJV2oGJ6";
const OTHER = "11111111111111111111111111111111";
const SECRET = "whsec_route_secret";

const report = { supply: 1n, reserve: 1n, ok: true, headroom: 0n, reserveSource: "mock-ledger" as const };
function fakeTreasury() {
  const calls = { creditReserve: [] as bigint[], wrap: [] as Array<{ wallet: string; amount: bigint }> };
  const treasury = {
    mode: "mock" as const,
    creditReserve(amount: bigint) {
      calls.creditReserve.push(amount);
      return amount;
    },
    async wrap(args: { wallet: string; amount: bigint }) {
      calls.wrap.push(args);
      return { token: WALLET, signatures: ["sig"], invariantBefore: report, invariantAfter: report };
    },
    async wrapAndMakeConfidential() {
      throw new Error("not expected: no owner signer in the route tests");
    },
    async invariant() {
      return report;
    },
  };
  return { treasury: treasury as unknown as OnrampTreasury, calls };
}

// Mirrors the env defaults (ONRAMP_MIN_PLN=10, ONRAMP_MAX_PLN=5000, rate 4.30), which
// /api/onramp/config reports straight from env.
const config = (patch: Partial<OnrampConfig> = {}): OnrampConfig => ({
  provider: "mock",
  rateScaled: parseRate("4.30"),
  minPln: parsePln("10"),
  maxPln: parsePln("5000"),
  maxUsdcPerWalletPerDay: parseUsdc("2000"),
  backendUrl: "http://backend.test",
  appUrl: "http://localhost:5173",
  ...patch,
});

function build(patch: Partial<OnrampConfig> = {}, offrampCap = "2000") {
  const t = fakeTreasury();
  const onramp = createOnramp({ config: config(patch), treasury: async () => t.treasury });
  const offramp = createOfframp({ config: { rateScaled: parseRate("4.30"), maxUsdcPerWalletPerDay: parseUsdc(offrampCap) } });
  const services = {
    onramp: () => onramp,
    offramp: () => offramp,
    treasury: async () => t.treasury,
    keyReport: async () => ({ feePayer: "fp", attestationIssuer: "ai", treasury: "tr", ephemeral: ["feePayer"] }),
    sponsor: async () => {
      throw new Error("unused");
    },
    client: () => {
      throw new Error("unused");
    },
  } as unknown as Services;
  return { app: createApp(services), onramp, offramp, ...t };
}

type App = ReturnType<typeof build>["app"];
const bearer = (wallet: string) => ({ authorization: `Bearer ${createSessionToken(wallet).token}` });
const post = (app: App, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const get = (app: App, path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
const json = async <T = Record<string, any>>(res: Response) => (await res.json()) as T;

describe("session-required fiat routes", () => {
  const { app } = build();
  const cases: Array<[string, string, () => Response | Promise<Response>]> = [
    ["POST /api/onramp/checkout", "checkout", () => post(app, "/api/onramp/checkout", { amountPln: "100" })],
    ["GET /api/onramp/status", "status", () => get(app, "/api/onramp/status?intent=x")],
    ["POST /api/offramp/payout", "payout", () => post(app, "/api/offramp/payout", { amountUsdc: "1" })],
    ["GET /api/offramp/history", "history", () => get(app, "/api/offramp/history")],
  ];
  for (const [name, , call] of cases) {
    it(`${name} is 401 without a bearer token`, async () => {
      const res = await call();
      assert.equal(res.status, 401);
      assert.equal((await json(res)).code, "unauthorized");
    });
  }

  it("a forged token is 401", async () => {
    const res = await post(app, "/api/onramp/checkout", { amountPln: "100" }, { authorization: "Bearer aaaa.bbbb" });
    assert.equal(res.status, 401);
  });
});

describe("GET /api/onramp/config", () => {
  it("is public and reports the mock provider, the rate and the limits", async () => {
    const { app } = build();
    const res = await get(app, "/api/onramp/config");
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.provider, "mock");
    assert.equal(body.simulated, true);
    assert.equal(body.plnPerUsdc, "4.30");
    assert.equal(body.minPln, "10.00");
    assert.equal(body.maxPln, "5000.00");
    assert.equal(body.maxUsdcPerWalletPerDay, "2000.000000");
  });
});

describe("POST /api/onramp/checkout", () => {
  const { app } = build();
  const auth = bearer(WALLET);

  it("rejects malformed bodies with malformed-body", async () => {
    for (const body of [
      "not json",
      "{}",
      JSON.stringify({ amountPln: "abc" }),
      JSON.stringify({ amountPln: "1e3" }),
      JSON.stringify({ amountPln: "-5" }),
      JSON.stringify({ amountPln: "10.999" }),
      JSON.stringify({ amountPln: "" }),
      JSON.stringify({ amountPln: {} }),
      JSON.stringify({ amountPln: "100", depositHoldbackUsdc: "-1" }),
      JSON.stringify({ amountPln: "100", depositHoldbackUsdc: "1e3" }),
    ]) {
      const res = await post(app, "/api/onramp/checkout", body, auth);
      assert.equal(res.status, 400, body);
      assert.equal((await json(res)).code, "malformed-body", body);
    }
  });

  it("rejects amounts outside ONRAMP_MIN_PLN..ONRAMP_MAX_PLN with amount-out-of-range", async () => {
    for (const amountPln of ["9.99", "0", "5000.01", 5001]) {
      const res = await post(app, "/api/onramp/checkout", { amountPln }, auth);
      assert.equal(res.status, 400, String(amountPln));
      assert.equal((await json(res)).code, "amount-out-of-range", String(amountPln));
    }
  });

  it("rejects a holdback larger than what the top-up buys with holdback-too-large", async () => {
    const res = await post(app, "/api/onramp/checkout", { amountPln: "100", depositHoldbackUsdc: "1000" }, auth);
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, "holdback-too-large");
  });

  it("past the wallet's daily cap is 429 wallet-cap", async () => {
    const { app: tight } = build({ maxUsdcPerWalletPerDay: parseUsdc("50") });
    const res = await post(tight, "/api/onramp/checkout", { amountPln: "400" }, auth);
    assert.equal(res.status, 429);
    assert.equal((await json(res)).code, "wallet-cap");
  });

  it("takes the wallet from the session, ignoring one in the body", async () => {
    const { app: a, onramp } = build();
    const res = await post(a, "/api/onramp/checkout", { amountPln: "100", wallet: OTHER }, auth);
    assert.equal(res.status, 200);
    const { intent } = await json(res);
    assert.equal(onramp.intent(intent)?.wallet, WALLET);
  });

  it("a session for a non-address wallet is 400 malformed-wallet", async () => {
    const res = await post(app, "/api/onramp/checkout", { amountPln: "100" }, bearer("SomeWallet"));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, "malformed-wallet");
  });
});

describe("the mock path, end to end (ONRAMP_PROVIDER unset)", () => {
  it("checkout -> /mock/onramp -> webhook credits once -> status goes pending to credited", async () => {
    const { app, calls } = build();
    const auth = bearer(WALLET);

    const checkout = await post(app, "/api/onramp/checkout", { amountPln: "400" }, auth);
    assert.equal(checkout.status, 200);
    const out = await json(checkout);
    assert.equal(out.provider, "mock");
    assert.equal(out.simulated, true);
    assert.equal(out.amountUsdc, "93.023255");
    const url = new URL(out.url);
    assert.equal(url.pathname, "/mock/onramp");
    assert.equal(url.searchParams.get("intent"), out.intent);

    const page = await get(app, `${url.pathname}${url.search}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.match(html, /400\.00 PLN/);
    assert.match(html, /93\.023255 rUSDC/);
    assert.ok(html.includes(WALLET));

    const pending = await json(await get(app, `/api/onramp/status?intent=${out.intent}`, auth));
    assert.equal(pending.state, "pending");
    assert.equal(pending.credit, null);
    assert.equal(calls.wrap.length, 0, "opening the checkout page credits nothing");

    const hook = await post(app, "/api/webhooks/stripe", { intent: out.intent });
    assert.equal(hook.status, 200);
    const hookBody = await json(hook);
    assert.equal(hookBody.received, true);
    assert.equal(hookBody.replay, false);
    assert.equal(hookBody.credit.status, "credited");

    const done = await json(await get(app, `/api/onramp/status?intent=${out.intent}`, auth));
    assert.equal(done.state, "credited");
    assert.equal(done.credit.amountUsdc, "93023255");
    assert.equal(done.remainingToday, "1906.976745");

    const again = await json(await post(app, "/api/webhooks/stripe", { intent: out.intent }));
    assert.equal(again.replay, true);
    assert.equal(calls.wrap.length, 1);
    assert.equal(calls.creditReserve.length, 1);
    assert.deepEqual(calls.wrap[0], { wallet: WALLET, amount: 93_023_255n, ref: `onramp:mock-${out.intent}` });
  });

  it("the webhook ignores any amount or wallet in the request body", async () => {
    const { app, calls, onramp } = build();
    const out = await json(await post(app, "/api/onramp/checkout", { amountPln: "400" }, bearer(WALLET)));
    const res = await post(app, "/api/webhooks/stripe", {
      intent: out.intent,
      amountUsdc: 999_999_999_999,
      amount: "999999999999",
      amountPln: "99999999",
      wallet: OTHER,
    });
    assert.equal(res.status, 200);
    assert.equal(calls.wrap.length, 1);
    assert.equal(calls.wrap[0]!.wallet, WALLET, "only the intent's wallet is credited");
    assert.equal(calls.wrap[0]!.amount, 93_023_255n, "only the intent's amount is credited");
    assert.equal(onramp.remainingToday(OTHER), parseUsdc("2000"));
  });

  it("the webhook cannot credit a wallet by naming it, without an intent", async () => {
    const { app, calls } = build();
    for (const body of [{ wallet: OTHER, amountUsdc: 5_000_000 }, { intent: "does-not-exist", wallet: OTHER, amountUsdc: 5_000_000 }, "not json", {}]) {
      const res = await post(app, "/api/webhooks/stripe", body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(calls.wrap.length, 0);
    assert.equal(calls.creditReserve.length, 0);
  });

  it("an unauthenticated caller can trigger the webhook only for an intent that exists", async () => {
    const { app } = build();
    const res = await post(app, "/api/webhooks/stripe", { intent: "nope" });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, "intent-unknown");
  });

  it("a Stripe-shaped body is not a valid mock confirmation", async () => {
    const { app, calls } = build();
    const res = await post(app, "/api/webhooks/stripe", {
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: { amount_total: 40000, currency: "pln", payment_status: "paid", metadata: { wallet: WALLET } } },
    });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, "body-malformed");
    assert.equal(calls.wrap.length, 0);
  });

  it("GET /mock/onramp is 404 for an unknown intent", async () => {
    const { app } = build();
    const res = await get(app, "/mock/onramp?intent=nope");
    assert.equal(res.status, 404);
    assert.equal((await get(app, "/mock/onramp")).status, 404);
  });

  it("a return URL on a foreign origin is not echoed by the mock page", async () => {
    const { app } = build();
    const out = await json(await post(app, "/api/onramp/checkout", { amountPln: "100" }, bearer(WALLET)));
    const html = await (await get(app, `/mock/onramp?intent=${out.intent}&back=${encodeURIComponent("https://evil.test/x")}`)).text();
    assert.ok(!html.includes("evil.test"));
  });

  it("a return URL that merely starts with the app origin is not echoed", async () => {
    const { app } = build();
    const out = await json(await post(app, "/api/onramp/checkout", { amountPln: "100" }, bearer(WALLET)));
    const html = await (await get(app, `/mock/onramp?intent=${out.intent}&back=${encodeURIComponent("http://localhost:5173.evil.test/")}`)).text();
    assert.ok(!html.includes("evil.test"));
  });
});

describe("safeReturnBase", () => {
  const APP = "http://localhost:5173";
  const FALLBACK = `${APP}/#/app?tab=wallet&topup=`;
  const own = [`${APP}/#/app?tab=wallet&topup=`, `${APP}/other/path#frag`, `${APP}`];
  for (const url of own) it(`keeps the app's own origin: ${url}`, () => assert.equal(safeReturnBase(url, APP), url));

  const bad: Array<[string, string | undefined]> = [
    ["a host that merely starts with the origin", "http://localhost:5173.evil.test/"],
    ["a different scheme", "https://localhost:5173/x"],
    ["a different port", "http://localhost:5174/x"],
    ["undefined", undefined],
    ["an empty string", ""],
    ["a relative URL", "/#/app"],
    ["garbage", "not a url at all"],
    ["a userinfo trick", "http://localhost:5173@evil.test/"],
    ["a foreign origin", "https://evil.test/x"],
  ];
  for (const [label, url] of bad) {
    it(`falls back on ${label}`, () => {
      const out = safeReturnBase(url as string, APP);
      assert.equal(out, FALLBACK);
      assert.ok(!out.includes("evil"));
    });
  }
});

describe("GET /api/onramp/status", () => {
  it("requires an intent", async () => {
    const { app } = build();
    const res = await get(app, "/api/onramp/status", bearer(WALLET));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, "malformed-body");
  });

  it("another wallet's intent is 404 and indistinguishable from one that does not exist", async () => {
    const { app } = build();
    const out = await json(await post(app, "/api/onramp/checkout", { amountPln: "100" }, bearer(WALLET)));

    const foreign = await get(app, `/api/onramp/status?intent=${out.intent}`, bearer(OTHER));
    const missing = await get(app, "/api/onramp/status?intent=00000000-0000-0000-0000-000000000000", bearer(OTHER));
    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    const foreignBody = await json(foreign);
    const missingBody = await json(missing);
    assert.equal(foreignBody.code, "intent-unknown");
    assert.equal(foreignBody.code, missingBody.code);
    assert.deepEqual(Object.keys(foreignBody).sort(), Object.keys(missingBody).sort());
    const text = JSON.stringify(foreignBody);
    assert.ok(!text.includes(WALLET), "does not name the owner");
    assert.ok(!text.includes("amount"), "does not leak the priced amount");

    // and the owner still sees it
    assert.equal((await get(app, `/api/onramp/status?intent=${out.intent}`, bearer(WALLET))).status, 200);
  });
});

describe("POST /api/webhooks/stripe in stripe mode", () => {
  const stripeConfig = (): Partial<OnrampConfig> => ({
    provider: "stripe",
    stripe: {
      secretKey: "sk_test_x",
      webhookSecret: SECRET,
      apiBase: "https://stripe.invalid",
      toleranceSeconds: 300,
      plnPerUsdc: parseRate("4.30"),
    },
  });
  const rawEvent = (patch: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: "evt_route_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          amount_total: 40000,
          currency: "pln",
          payment_status: "paid",
          metadata: { wallet: WALLET, plnPerUsdc: "4.30", holdback: "0", intent: "i-1" },
          ...patch,
        },
      },
    });
  const sigFor = (body: string, secret = SECRET, t = Math.floor(Date.now() / 1000)) =>
    `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  const hook = (app: App, body: string, signature?: string) =>
    app.request("/api/webhooks/stripe", {
      method: "POST",
      headers: { "content-type": "application/json", ...(signature === undefined ? {} : { "stripe-signature": signature }) },
      body,
    });

  it("credits a correctly signed event from the exact raw bytes", async () => {
    const { app, calls } = build(stripeConfig());
    const body = rawEvent();
    const res = await hook(app, body, sigFor(body));
    assert.equal(res.status, 200);
    assert.equal((await json(res)).credit.amountUsdc, "93023255");
    assert.equal(calls.wrap.length, 1);
  });

  it("re-delivery of the same event id credits once", async () => {
    const { app, calls } = build(stripeConfig());
    const body = rawEvent();
    const first = await json(await hook(app, body, sigFor(body)));
    const second = await json(await hook(app, body, sigFor(body)));
    assert.equal(first.replay, false);
    assert.equal(second.replay, true);
    assert.equal(calls.wrap.length, 1);
  });

  it("a missing, wrong or malformed signature is 400 and credits nothing", async () => {
    const { app, calls } = build(stripeConfig());
    const body = rawEvent();
    const attempts: Array<[string | undefined, string]> = [
      [undefined, "signature-missing"],
      [sigFor(body, "whsec_other"), "signature-invalid"],
      ["garbage", "signature-malformed"],
      [`t=${Math.floor(Date.now() / 1000)}`, "signature-malformed"],
      [sigFor(body, SECRET, Math.floor(Date.now() / 1000) - 3600), "signature-expired"],
    ];
    for (const [signature, code] of attempts) {
      const res = await hook(app, body, signature);
      assert.equal(res.status, 400, code);
      assert.equal((await json(res)).code, code);
    }
    assert.equal(calls.wrap.length, 0);
  });

  it("a re-serialised body fails verification, because the route verifies the raw text", async () => {
    const { app, calls } = build(stripeConfig());
    const body = rawEvent();
    const signature = sigFor(body);
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    const res = await hook(app, reserialised, signature);
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, "signature-invalid");
    assert.equal(calls.wrap.length, 0);
  });

  it("an eur event is 400 wrong-currency", async () => {
    const { app, calls } = build(stripeConfig());
    const body = rawEvent({ currency: "eur" });
    const res = await hook(app, body, sigFor(body));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, "wrong-currency");
    assert.equal(calls.wrap.length, 0);
  });

  it("does not echo the signing secret in an error", async () => {
    const { app } = build(stripeConfig());
    const body = rawEvent();
    const text = await (await hook(app, body, sigFor(body, "whsec_other"))).text();
    assert.ok(!text.includes(SECRET));
  });
});

describe("offramp routes", () => {
  const auth = bearer(WALLET);

  it("POST /api/offramp/payout returns a simulated receipt", async () => {
    const { app } = build();
    const res = await post(app, "/api/offramp/payout", { amountUsdc: "93.023255", destination: "PL00" }, auth);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.simulated, true);
    assert.equal(body.status, "paid-simulated");
    assert.equal(body.wallet, WALLET);
    assert.equal(body.amountUsdc, "93023255");
    assert.equal(body.amountPln, "40000");
    assert.equal(body.unwrap.burned, false);
  });

  it("takes the wallet from the session, ignoring one in the body", async () => {
    const { app } = build();
    const body = await json(await post(app, "/api/offramp/payout", { amountUsdc: "1", wallet: OTHER }, auth));
    assert.equal(body.wallet, WALLET);
  });

  it("rejects malformed bodies with malformed-body", async () => {
    const { app } = build();
    for (const body of ["not json", "{}", JSON.stringify({ amountUsdc: "abc" }), JSON.stringify({ amountUsdc: "-1" }), JSON.stringify({ amountUsdc: "1e3" }), JSON.stringify({ amountUsdc: "1.1234567" })]) {
      const res = await post(app, "/api/offramp/payout", body, auth);
      assert.equal(res.status, 400, body);
      assert.equal((await json(res)).code, "malformed-body", body);
    }
  });

  it("a zero payout is 400 amount-out-of-range", async () => {
    const { app } = build();
    const res = await post(app, "/api/offramp/payout", { amountUsdc: "0" }, auth);
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, "amount-out-of-range");
  });

  it("past the daily cap is 429 wallet-cap", async () => {
    const { app } = build({}, "10");
    assert.equal((await post(app, "/api/offramp/payout", { amountUsdc: "6" }, auth)).status, 200);
    const res = await post(app, "/api/offramp/payout", { amountUsdc: "5" }, auth);
    assert.equal(res.status, 429);
    assert.equal((await json(res)).code, "wallet-cap");
  });

  it("a session for a non-address wallet is 400 malformed-wallet", async () => {
    const { app } = build();
    const res = await post(app, "/api/offramp/payout", { amountUsdc: "1" }, bearer("SomeWallet"));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, "malformed-wallet");
  });

  it("GET /api/offramp/history lists only the session wallet's receipts", async () => {
    const { app } = build();
    const mine = await json(await post(app, "/api/offramp/payout", { amountUsdc: "1" }, auth));
    await post(app, "/api/offramp/payout", { amountUsdc: "2" }, bearer(OTHER));

    const res = await get(app, "/api/offramp/history", auth);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.simulated, true);
    assert.equal(body.plnPerUsdc, "4.30");
    assert.deepEqual(body.receipts.map((r: { reference: string }) => r.reference), [mine.reference]);
    assert.equal(body.remainingToday, "1999.000000");

    const theirs = await json(await get(app, "/api/offramp/history", bearer(OTHER)));
    assert.equal(theirs.receipts.length, 1);
    assert.equal(theirs.receipts[0].wallet, OTHER);
  });
});

describe("GET /health with the fiat fields", () => {
  it("reports the providers and the demo rate", async () => {
    const { app } = build();
    const body = await json(await get(app, "/health"));
    assert.equal(body.onrampProvider, "mock");
    assert.equal(body.offrampProvider, "mock");
    assert.equal(body.plnPerUsdc, "4.30");
  });

  it("still leaks no secret", async () => {
    const { app } = build(stripeConfigWithSecrets());
    const text = await (await get(app, "/health")).text();
    assert.doesNotMatch(text, /api-key|secret|ikm|whsec_|sk_test/i);
  });
});

function stripeConfigWithSecrets(): Partial<OnrampConfig> {
  return {
    provider: "stripe",
    stripe: {
      secretKey: "sk_test_do_not_leak",
      webhookSecret: "whsec_do_not_leak",
      apiBase: "https://stripe.invalid",
      toleranceSeconds: 300,
      plnPerUsdc: parseRate("4.30"),
    },
  };
}
