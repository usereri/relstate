import "./noenv.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import type { Address, Signature } from "@solana/kit";

// env.ts is read once at import; noenv.ts blanks the secrets and KYC_PROVIDER is unset, so this
// process is the no-secrets mock default. The Sumsub verifier is driven by injecting the real
// Sumsub provider into the service instead of flipping env after the fact.
const { createApp } = await import("../src/server.ts");
const { env, assertEnvConsistent } = await import("../src/env.ts");
const { createSessionToken } = await import("../src/auth.ts");
const { createKyc } = await import("../src/providers/kyc.ts");
const { createSumsubKyc } = await import("../src/providers/kyc-sumsub.ts");
import type { Env } from "../src/env.ts";
import type { KycConfig } from "../src/providers/kyc.ts";
import type { AttestationChain } from "../src/providers/kyc-chain.ts";
import type { Services } from "../src/services.ts";

const WALLET = "EBMibFLTvr5GDpgxNqt5Gqp9B1xLMr32aNwGDJV2oGJ6";
const OTHER = "11111111111111111111111111111112";
const ISSUER = "11111111111111111111111111111113" as Address;
const WEBHOOK_SECRET = "whsec_route_kyc";

const kycConfig = (patch: Partial<KycConfig> = {}): KycConfig => ({
  provider: "mock",
  level: 1,
  validityDays: 365,
  subjectSalt: "pepper",
  backendUrl: "http://backend.test",
  appUrl: "http://localhost:5173",
  ...patch,
});

function fakeChain() {
  const calls = { attest: [] as Array<{ wallet: Address }>, revoke: 0 };
  const store = new Map<string, boolean>();
  const chain: AttestationChain = {
    issuer: ISSUER,
    async attest(input) {
      calls.attest.push({ wallet: input.wallet });
      store.set(input.wallet, true);
      return { signatures: ["sig" as Signature], attestation: "PDA" as Address };
    },
    async revoke() {
      calls.revoke++;
      return { signatures: ["sig" as Signature] };
    },
    async read(wallet) {
      return store.get(wallet)
        ? { wallet, issuer: ISSUER, level: 1, verifiedAt: 1, expiresAt: 0, revoked: false, subjectHash: "00".repeat(32) }
        : null;
    },
    async policy() {
      return { issuer: ISSUER, requireKyc: true };
    },
  };
  return { chain, calls };
}

// The Sumsub fixtures are stamped at this instant (UTC) and the service's clock is pinned to it.
const NOW = Date.UTC(2026, 9, 10, 10, 0, 0);
const CREATED_AT = "2026-10-10 10:00:00.000";

function build(opts: { sumsub?: boolean; maxStarts?: number } = {}) {
  const { chain, calls } = fakeChain();
  const sumsub = {
    appToken: "tok",
    secretKey: "sk",
    webhookSecret: WEBHOOK_SECRET,
    apiBase: "https://sumsub.test",
    levelName: "basic-kyc-level",
    linkTtlSeconds: 60,
    digestAlg: "",
    maxEventAgeSeconds: 600,
  };
  const kyc = createKyc({
    config: kycConfig({ ...(opts.sumsub ? { provider: "sumsub" as const, sumsub } : {}), ...(opts.maxStarts === undefined ? {} : { maxStartsPerWalletPerHour: opts.maxStarts }) }),
    chain: async () => chain,
    provider: opts.sumsub ? createSumsubKyc(sumsub, { now: () => NOW, fetch: (async () => Response.json({ url: "https://in.sumsub.test/l" })) as unknown as typeof fetch }) : undefined,
    now: () => NOW,
    log: () => {},
  });
  const services = {
    kyc: () => kyc,
    onramp: () => ({ rateScaled: 4_300_000n }),
    keyReport: async () => ({ feePayer: "fp", attestationIssuer: "ai", treasury: "tr", ephemeral: [] }),
  } as unknown as Services;
  return { app: createApp(services), kyc, calls };
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

describe("session-required KYC routes", () => {
  const { app } = build();

  it("POST /api/kyc/start and GET /api/kyc/status are 401 without a bearer token", async () => {
    for (const res of [await post(app, "/api/kyc/start", {}), await get(app, "/api/kyc/status")]) {
      assert.equal(res.status, 401);
      assert.equal((await json(res)).code, "unauthorized");
    }
  });

  it("a forged token is 401", async () => {
    assert.equal((await post(app, "/api/kyc/start", {}, { authorization: "Bearer aaaa.bbbb" })).status, 401);
  });

  it("start works with a session and uses the session's wallet even when the body names another", async () => {
    const { app, kyc } = build();
    const res = await post(app, "/api/kyc/start", { wallet: OTHER }, bearer(WALLET));
    assert.equal(res.status, 200);
    const out = await json(res);
    assert.equal(out.simulated, true);
    assert.equal(kyc.session(out.session)?.wallet, WALLET);
    assert.equal((await json(await get(app, "/api/kyc/status", bearer(OTHER)))).pending, false);
  });

  it("start answers 429 rate-limited past the per-wallet limit, and only for that wallet", async () => {
    const { app } = build({ maxStarts: 2 });
    for (let i = 0; i < 2; i++) assert.equal((await post(app, "/api/kyc/start", {}, bearer(WALLET))).status, 200);
    const res = await post(app, "/api/kyc/start", {}, bearer(WALLET));
    assert.equal(res.status, 429);
    assert.equal((await json(res)).code, "rate-limited");
    assert.equal((await post(app, "/api/kyc/start", {}, bearer(OTHER))).status, 200);
  });

  it("status reports the session's wallet and is pending after a start", async () => {
    const { app } = build();
    await post(app, "/api/kyc/start", {}, bearer(WALLET));
    const res = await get(app, "/api/kyc/status", bearer(WALLET));
    assert.equal(res.status, 200);
    const out = await json(res);
    assert.equal(out.wallet, WALLET);
    assert.equal(out.pending, true);
    assert.equal(out.verified, false);
  });
});

describe("POST /api/webhooks/kyc (mock)", () => {
  it("needs no auth: the mock page's decision attests the session's wallet, and a replay says so", async () => {
    const { app, calls } = build();
    const { session } = await json(await post(app, "/api/kyc/start", {}, bearer(WALLET)));

    const res = await post(app, "/api/webhooks/kyc", { session, decision: "approve" });
    assert.equal(res.status, 200);
    const out = await json(res);
    assert.equal(out.received, true);
    assert.equal(out.replay, false);
    assert.equal(out.record.status, "attested");
    assert.equal(calls.attest.length, 1);

    const again = await json(await post(app, "/api/webhooks/kyc", { session, decision: "approve" }));
    assert.equal(again.replay, true);
    assert.equal(calls.attest.length, 1);

    assert.equal((await json(await get(app, "/api/kyc/status", bearer(WALLET)))).verified, true);
  });

  it("answers an unknown session with 400 session-unknown and writes nothing", async () => {
    const { app, calls } = build();
    const res = await post(app, "/api/webhooks/kyc", { session: "nope", decision: "approve" });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, "session-unknown");
    assert.equal(calls.attest.length, 0);
  });
});

describe("POST /api/webhooks/kyc (sumsub)", () => {
  const sign = (raw: string, secret = WEBHOOK_SECRET) => ({ "x-payload-digest": createHmac("sha256", secret).update(raw).digest("hex"), "x-payload-digest-alg": "HMAC_SHA256_HEX" });
  const reviewed = (patch: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "applicantReviewed", applicantId: "a1", correlationId: "c1", externalUserId: WALLET, reviewResult: { reviewAnswer: "GREEN" }, createdAtMs: CREATED_AT, ...patch });

  it("a signed GREEN attests the wallet named by externalUserId", async () => {
    const { app, calls } = build({ sumsub: true });
    const raw = reviewed();
    const res = await post(app, "/api/webhooks/kyc", raw, sign(raw));
    assert.equal(res.status, 200);
    assert.equal(calls.attest[0]!.wallet, WALLET);
  });

  it("a bad signature is 400, and nothing is written", async () => {
    const { app, calls } = build({ sumsub: true });
    const raw = reviewed();
    const res = await post(app, "/api/webhooks/kyc", raw, sign(raw, "someone-elses-secret"));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, "signature-invalid");
    assert.equal(calls.attest.length, 0);
  });

  it("a missing signature is 400", async () => {
    const { app } = build({ sumsub: true });
    const res = await post(app, "/api/webhooks/kyc", reviewed());
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, "signature-missing");
  });

  it("a validly signed body that was re-serialised after signing is 400", async () => {
    const { app } = build({ sumsub: true });
    const raw = reviewed();
    const res = await post(app, "/api/webhooks/kyc", JSON.stringify(JSON.parse(raw), null, 1), sign(raw));
    assert.equal(res.status, 400);
  });

  it("an ignored event type answers 200 with ignored, so Sumsub does not retry it forever", async () => {
    const { app, calls } = build({ sumsub: true });
    const raw = reviewed({ type: "applicantPending" });
    const res = await post(app, "/api/webhooks/kyc", raw, sign(raw));
    assert.equal(res.status, 200);
    const out = await json(res);
    assert.equal(out.received, true);
    assert.equal(out.code, "event-ignored");
    assert.ok(typeof out.ignored === "string");
    assert.equal(calls.attest.length, 0);
  });

  it("a non-final review answer is likewise ignored with 200", async () => {
    const { app } = build({ sumsub: true });
    const raw = reviewed({ reviewResult: { reviewAnswer: "PENDING" } });
    assert.equal((await post(app, "/api/webhooks/kyc", raw, sign(raw))).status, 200);
  });

  it("a signed event with no externalUserId is 400 wallet-missing, not silently dropped", async () => {
    const { app } = build({ sumsub: true });
    const raw = reviewed({ externalUserId: undefined });
    const res = await post(app, "/api/webhooks/kyc", raw, sign(raw));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, "wallet-missing");
  });

  it("a stale but correctly signed delivery is 400 event-stale and writes nothing", async () => {
    const { app, calls } = build({ sumsub: true });
    const raw = reviewed({ createdAtMs: "2026-10-10 09:00:00.000" });
    const res = await post(app, "/api/webhooks/kyc", raw, sign(raw));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, "event-stale");
    assert.equal(calls.attest.length, 0);
  });

  it("start returns the url Sumsub issued", async () => {
    const { app } = build({ sumsub: true });
    const out = await json(await post(app, "/api/kyc/start", {}, bearer(WALLET)));
    assert.equal(out.url, "https://in.sumsub.test/l");
    assert.equal(out.simulated, false);
  });
});

describe("GET /mock/kyc", () => {
  it("serves the page for a known session", async () => {
    const { app } = build();
    const { session } = await json(await post(app, "/api/kyc/start", {}, bearer(WALLET)));
    const res = await get(app, `/mock/kyc?session=${session}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes(session));
    assert.ok(html.includes(WALLET));
  });

  it("404s for an unknown or missing session", async () => {
    const { app } = build();
    assert.equal((await get(app, "/mock/kyc?session=nope")).status, 404);
    assert.equal((await get(app, "/mock/kyc")).status, 404);
  });

  it("does not echo the page-supplied session into HTML on a 404 as markup", async () => {
    const { app } = build();
    const res = await get(app, `/mock/kyc?session=${encodeURIComponent("<script>alert(1)</script>")}`);
    assert.equal(res.status, 404);
    assert.ok(!res.headers.get("content-type")?.includes("html"));
  });

  it("ignores a back parameter on a foreign origin", async () => {
    const { app } = build();
    const { session } = await json(await post(app, "/api/kyc/start", {}, bearer(WALLET)));
    for (const back of ["https://evil.test/x", "http://localhost:5173.evil.test/", "http://localhost:5173@evil.test/", "javascript:alert(1)"]) {
      const html = await (await get(app, `/mock/kyc?session=${session}&back=${encodeURIComponent(back)}`)).text();
      assert.ok(!html.includes("evil.test"), back);
      assert.ok(!html.includes("javascript:"), back);
      // The fallback is the app's own identity tab (the page HTML-escapes the `&`).
      assert.ok(html.includes("http://localhost:5173/#/app?tab=identity&amp;kyc="), back);
    }
  });

  it("keeps a back parameter on the app's own origin", async () => {
    const { app } = build();
    const { session } = await json(await post(app, "/api/kyc/start", {}, bearer(WALLET)));
    const back = "http://localhost:5173/#/app?tab=identity&kyc=";
    const html = await (await get(app, `/mock/kyc?session=${session}&back=${encodeURIComponent(back)}`)).text();
    assert.ok(html.includes("tab=identity"));
  });
});

describe("GET /health", () => {
  it("reports kycProvider", async () => {
    const { app } = build();
    const out = await json(await get(app, "/health"));
    assert.equal(out.kycProvider, "mock");
  });
});

describe("assertEnvConsistent: identity rules", () => {
  // The default env is the no-secrets mock config, which must itself be valid.
  const withEnv = (patch: { kyc?: Partial<Env["kyc"]> } & Record<string, unknown> = {}): Env => {
    const { kyc, ...rest } = patch;
    return { ...env, ...rest, kyc: { ...env.kyc, ...kyc } } as unknown as Env;
  };
  const sumsubFull = { provider: "sumsub", sumsubAppToken: "t", sumsubSecretKey: "k", sumsubWebhookSecret: "w", sumsubLevelName: "lvl" } as const;
  // Live mode refuses the mock verifier, so a valid live config is a Sumsub one.
  const liveBase = {
    mode: "live",
    authMode: "privy",
    feePayerKeypair: "fp",
    treasuryKeypair: "tr",
    attestationIssuerKeypair: "iss",
    rusdcMint: "mint",
    sessionSecret: "s",
    adminToken: "a",
    kyc: { ...sumsubFull, subjectSalt: "salt" },
  };
  const message = (e: Env): string => {
    try {
      assertEnvConsistent(e);
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  };

  it("accepts the no-secrets mock default and a complete live config", () => {
    assert.equal(message(withEnv()), "");
    assert.equal(message(withEnv(liveBase)), "");
  });

  it("accepts a fully configured Sumsub", () => {
    assert.equal(message(withEnv({ kyc: sumsubFull })), "");
  });

  for (const [field, name] of [
    ["sumsubAppToken", "SUMSUB_APP_TOKEN"],
    ["sumsubSecretKey", "SUMSUB_SECRET_KEY"],
    ["sumsubWebhookSecret", "SUMSUB_WEBHOOK_SECRET"],
  ] as const) {
    it(`KYC_PROVIDER=sumsub without ${name} fails naming it`, () => {
      const msg = message(withEnv({ kyc: { ...sumsubFull, [field]: "" } }));
      assert.ok(msg.includes(name), msg);
    });
  }

  it("does not demand Sumsub keys in mock mode", () => {
    assert.equal(message(withEnv({ kyc: { provider: "mock", sumsubAppToken: "" } })), "");
  });

  it("KYC_LEVEL outside 1..2 fails", () => {
    for (const level of [3, 0, -1, 1.5]) assert.ok(message(withEnv({ kyc: { level } })).includes("KYC_LEVEL"), String(level));
    for (const level of [1, 2]) assert.equal(message(withEnv({ kyc: { level } })), "");
  });

  it("a negative or fractional KYC_VALIDITY_DAYS fails, and 0 (never expires) is fine", () => {
    for (const validityDays of [-1, 0.5]) assert.ok(message(withEnv({ kyc: { validityDays } })).includes("KYC_VALIDITY_DAYS"), String(validityDays));
    assert.equal(message(withEnv({ kyc: { validityDays: 0 } })), "");
  });

  it("BACKEND_MODE=live without ATTESTATION_ISSUER_KEYPAIR fails", () => {
    assert.ok(message(withEnv({ ...liveBase, attestationIssuerKeypair: "" })).includes("ATTESTATION_ISSUER_KEYPAIR"));
  });

  it("BACKEND_MODE=live without KYC_SUBJECT_SALT fails", () => {
    assert.ok(message(withEnv({ ...liveBase, kyc: { ...liveBase.kyc, subjectSalt: "" } })).includes("KYC_SUBJECT_SALT"));
  });

  it("BACKEND_MODE=live refuses KYC_PROVIDER=mock", () => {
    // The mock verifier's unsigned Approve button would otherwise write real attestations.
    const msg = message(withEnv({ ...liveBase, kyc: { ...liveBase.kyc, provider: "mock" } }));
    assert.ok(msg.includes("KYC_PROVIDER=mock is refused"), msg);
    assert.equal(message(withEnv({ kyc: { provider: "mock" } })), "");
  });

  it("FEE_PAYER_KEYPAIR equal to ATTESTATION_ISSUER_KEYPAIR fails", () => {
    const msg = message(withEnv({ feePayerKeypair: "same", attestationIssuerKeypair: "same" }));
    assert.ok(msg.includes("FEE_PAYER_KEYPAIR") && msg.includes("ATTESTATION_ISSUER_KEYPAIR"), msg);
  });

  it("SUMSUB_WEBHOOK_MAX_AGE_SECONDS at or below zero (or not a number) fails", () => {
    for (const sumsubMaxEventAgeSeconds of [0, -1, Number.NaN]) {
      assert.ok(message(withEnv({ kyc: { sumsubMaxEventAgeSeconds } })).includes("SUMSUB_WEBHOOK_MAX_AGE_SECONDS"), String(sumsubMaxEventAgeSeconds));
    }
    assert.equal(message(withEnv({ kyc: { sumsubMaxEventAgeSeconds: 1 } })), "");
  });

  it("KYC_MAX_STARTS_PER_WALLET_PER_HOUR at or below zero (or not a number) fails", () => {
    for (const maxStartsPerWalletPerHour of [0, -5, Number.NaN]) {
      assert.ok(message(withEnv({ kyc: { maxStartsPerWalletPerHour } })).includes("KYC_MAX_STARTS_PER_WALLET_PER_HOUR"), String(maxStartsPerWalletPerHour));
    }
    assert.equal(message(withEnv({ kyc: { maxStartsPerWalletPerHour: 1 } })), "");
  });

  it("does not require the salt or issuer outside live mode", () => {
    assert.equal(message(withEnv({ kyc: { subjectSalt: "" }, attestationIssuerKeypair: "" })), "");
  });

  it("TREASURY_KEYPAIR equal to ATTESTATION_ISSUER_KEYPAIR fails", () => {
    const msg = message(withEnv({ treasuryKeypair: "same", attestationIssuerKeypair: "same" }));
    assert.ok(msg.includes("TREASURY_KEYPAIR") && msg.includes("ATTESTATION_ISSUER_KEYPAIR"), msg);
  });
});
