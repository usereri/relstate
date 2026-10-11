import "./noenv.ts";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it } from "node:test";
import type { Address, Signature } from "@solana/kit";

const { KycError, KycUnavailable, createKyc, mockVerificationPage } = await import("../src/providers/kyc.ts");
const { NO_ISSUER } = await import("../src/providers/kyc-chain.ts");
const { WebhookError } = await import("../src/providers/stripe.ts");
import type { KycConfig } from "../src/providers/kyc.ts";
import type { AttestationAccount, AttestationChain, KycPolicy } from "../src/providers/kyc-chain.ts";

const WALLET = "EBMibFLTvr5GDpgxNqt5Gqp9B1xLMr32aNwGDJV2oGJ6" as Address;
const OTHER = "11111111111111111111111111111112" as Address;
const ISSUER = "11111111111111111111111111111113" as Address;
const NOW = 1_750_000_000_000; // ms
const DAY = 86_400;

type AttestCall = { wallet: Address; level: number; expiresAt: number; subjectHash: Uint8Array };

/** A chain in memory: enough state for attest → read → revoke, and a counter per write. */
function fakeChain(patch: { attestError?: Error; policy?: KycPolicy | null } = {}) {
  const store = new Map<string, AttestationAccount>();
  const calls = { attest: [] as AttestCall[], revoke: [] as Address[], read: 0 };
  const chain: AttestationChain = {
    issuer: ISSUER,
    async attest(input) {
      calls.attest.push(input);
      if (patch.attestError !== undefined) throw patch.attestError;
      store.set(input.wallet, {
        wallet: input.wallet,
        issuer: ISSUER,
        level: input.level,
        verifiedAt: Math.floor(NOW / 1000),
        expiresAt: input.expiresAt,
        revoked: false,
        subjectHash: Buffer.from(input.subjectHash).toString("hex"),
      });
      return { signatures: ["sig-attest" as Signature], attestation: "ATT-PDA" as Address };
    },
    async revoke(wallet) {
      calls.revoke.push(wallet);
      const a = store.get(wallet);
      if (a !== undefined) store.set(wallet, { ...a, revoked: true });
      return { signatures: ["sig-revoke" as Signature] };
    },
    async read(wallet) {
      calls.read++;
      return store.get(wallet) ?? null;
    },
    async policy() {
      return patch.policy === undefined ? { issuer: ISSUER, requireKyc: true } : patch.policy;
    },
  };
  return { chain, calls, store };
}

const config = (patch: Partial<KycConfig> = {}): KycConfig => ({
  provider: "mock",
  level: 1,
  validityDays: 365,
  subjectSalt: "pepper-1",
  backendUrl: "http://backend.test",
  appUrl: "http://localhost:5173",
  ...patch,
});

function build(opts: { config?: Partial<KycConfig>; chain?: Parameters<typeof fakeChain>[0]; chainThunk?: () => Promise<AttestationChain> } = {}) {
  const fake = fakeChain(opts.chain);
  const kyc = createKyc({ config: config(opts.config), chain: opts.chainThunk ?? (async () => fake.chain), now: () => NOW, log: () => {} });
  return { kyc, ...fake };
}

const approve = (session: string) => JSON.stringify({ session, decision: "approve" });
const decline = (session: string) => JSON.stringify({ session, decision: "decline" });
const hook = (kyc: ReturnType<typeof build>["kyc"], raw: string) => kyc.handleWebhook({}, raw);
const expectedHash = (applicantId: string, salt: string) => createHash("sha256").update(applicantId).update(salt).digest("hex");

describe("mock flow, end to end", () => {
  it("start() returns a /mock/kyc url for a session and says what an approval would write", async () => {
    const { kyc } = build();
    const out = await kyc.start({ wallet: WALLET });
    assert.ok(out.url.startsWith("http://backend.test/mock/kyc?session="));
    assert.ok(out.url.includes(`session=${out.session}`));
    assert.equal(out.simulated, true);
    assert.equal(out.provider, "mock");
    assert.equal(out.level, 1);
    assert.equal(out.expiresAt, NOW / 1000 + 365 * DAY);
    assert.equal(kyc.session(out.session)?.wallet, WALLET);
  });

  it("approving attests once with level, a 32-byte subject hash and the configured expiry", async () => {
    const { kyc, calls } = build({ config: { level: 2, validityDays: 30 } });
    const { session } = await kyc.start({ wallet: WALLET });
    const { record, replay } = await hook(kyc, approve(session));

    assert.equal(replay, false);
    assert.equal(calls.attest.length, 1);
    const call = calls.attest[0]!;
    assert.equal(call.wallet, WALLET);
    assert.equal(call.level, 2);
    assert.equal(call.expiresAt, NOW / 1000 + 30 * DAY);
    assert.equal(call.subjectHash.length, 32);

    assert.equal(record.status, "attested");
    assert.equal(record.decision, "approved");
    assert.equal(record.level, 2);
    assert.equal(record.expiresAt, call.expiresAt);
    assert.equal(record.subjectHash, Buffer.from(call.subjectHash).toString("hex"));
    assert.equal(record.attestation, "ATT-PDA");
    assert.deepEqual(record.signatures, ["sig-attest"]);
  });

  it("validityDays 0 writes expiresAt 0 (never), in the preview and on chain", async () => {
    const { kyc, calls } = build({ config: { validityDays: 0 } });
    const started = await kyc.start({ wallet: WALLET });
    assert.equal(started.expiresAt, 0);
    const { record } = await hook(kyc, approve(started.session));
    assert.equal(calls.attest[0]!.expiresAt, 0);
    assert.equal(record.expiresAt, 0);
  });

  it("rejects a malformed wallet at start()", async () => {
    const { kyc } = build();
    await assert.rejects(() => kyc.start({ wallet: "not-a-wallet" }), (e: unknown) => e instanceof KycError && e.code === "malformed-wallet");
  });
});

describe("the webhook decides the session, not the wallet", () => {
  it("ignores a wallet named in the body and attests the session's wallet", async () => {
    const { kyc, calls } = build();
    const { session } = await kyc.start({ wallet: WALLET });
    const { record } = await hook(kyc, JSON.stringify({ session, decision: "approve", wallet: OTHER, level: 2, expiresAt: 0 }));
    assert.equal(record.wallet, WALLET);
    assert.equal(calls.attest[0]!.wallet, WALLET);
    assert.equal(calls.attest[0]!.level, 1);
  });

  it("answers an unknown session with session-unknown and writes nothing", async () => {
    const { kyc, calls } = build();
    await assert.rejects(() => hook(kyc, approve("no-such-session")), (e: unknown) => e instanceof WebhookError && e.code === "session-unknown");
    assert.equal(calls.attest.length, 0);
  });

  it("rejects a body that is not JSON or names no session", async () => {
    const { kyc } = build();
    for (const raw of ["nope", "{}", JSON.stringify({ session: "" }), JSON.stringify({ session: 3 })]) {
      await assert.rejects(() => hook(kyc, raw), (e: unknown) => e instanceof WebhookError && e.code === "body-malformed", raw);
    }
  });
});

describe("idempotency", () => {
  it("the same event twice attests once and replays the identical record", async () => {
    const { kyc, calls } = build();
    const { session } = await kyc.start({ wallet: WALLET });
    const first = await hook(kyc, approve(session));
    const second = await hook(kyc, approve(session));
    assert.equal(calls.attest.length, 1);
    assert.equal(second.replay, true);
    assert.equal(second.record, first.record);
  });

  it("two concurrent deliveries of one event attest once", async () => {
    const { kyc, calls } = build();
    const { session } = await kyc.start({ wallet: WALLET });
    const [a, b] = await Promise.all([hook(kyc, approve(session)), hook(kyc, approve(session))]);
    assert.equal(calls.attest.length, 1);
    assert.deepEqual([a.replay, b.replay].sort(), [false, true]);
    assert.equal(a.record, b.record);
  });

  it("an approval and a later decline of one session are different events", async () => {
    // Otherwise a rejection after an approval would replay the approval and never revoke.
    const { kyc, calls } = build();
    const { session } = await kyc.start({ wallet: WALLET });
    await hook(kyc, approve(session));
    const out = await hook(kyc, decline(session));
    assert.equal(out.replay, false);
    assert.equal(out.record.status, "revoked");
    assert.equal(calls.attest.length, 1);
    assert.equal(calls.revoke.length, 1);
  });
});

describe("decline", () => {
  it("revokes an existing attestation", async () => {
    const { kyc, calls, store } = build();
    const first = await kyc.start({ wallet: WALLET });
    await hook(kyc, approve(first.session));
    const { record } = await hook(kyc, decline(first.session));
    assert.equal(record.status, "revoked");
    assert.equal(record.decision, "rejected");
    assert.equal(record.reason, "SIMULATED");
    assert.deepEqual(calls.revoke, [WALLET]);
    assert.equal(store.get(WALLET)!.revoked, true);
  });

  it("records nothing-to-revoke, and sends no transaction, when there is no attestation", async () => {
    const { kyc, calls } = build();
    const { session } = await kyc.start({ wallet: WALLET });
    const { record } = await hook(kyc, decline(session));
    assert.equal(record.status, "nothing-to-revoke");
    assert.equal(calls.revoke.length, 0);
    assert.equal(calls.attest.length, 0);
  });
});

describe("a failed chain write", () => {
  it("propagates, is not stored, and the retried delivery writes again", async () => {
    // The deliberate difference from the on-ramp: a person who should be verified and is not is
    // worth retrying, whereas money already taken must never be taken twice.
    const fake = fakeChain({ attestError: new Error("blockhash expired") });
    const kyc = createKyc({ config: config(), chain: async () => fake.chain, now: () => NOW, log: () => {} });
    const { session } = await kyc.start({ wallet: WALLET });

    await assert.rejects(() => hook(kyc, approve(session)), /blockhash expired/);
    assert.equal(kyc.record(`mock-${session}-approve`), undefined);
    await assert.rejects(() => hook(kyc, approve(session)), /blockhash expired/);
    assert.equal(fake.calls.attest.length, 2);

    const status = await kyc.status(WALLET);
    assert.equal(status.last, null);
    assert.equal(status.pending, true);
  });

  it("succeeds on the retry once the chain recovers", async () => {
    const fake = fakeChain();
    let fail = true;
    const flaky: AttestationChain = {
      ...fake.chain,
      async attest(input) {
        if (fail) {
          fail = false;
          throw new Error("rpc down");
        }
        return fake.chain.attest(input);
      },
    };
    const kyc = createKyc({ config: config(), chain: async () => flaky, now: () => NOW, log: () => {} });
    const { session } = await kyc.start({ wallet: WALLET });
    await assert.rejects(() => hook(kyc, approve(session)), /rpc down/);
    const { record, replay } = await hook(kyc, approve(session));
    assert.equal(replay, false);
    assert.equal(record.status, "attested");
  });
});

describe("KycUnavailable", () => {
  const unavailable = () => Promise.reject(new KycUnavailable("no issuer key"));

  it("yields a final not-written record with the reason, and a replay returns it without retrying", async () => {
    let asked = 0;
    const { kyc } = build({
      chainThunk: () => {
        asked++;
        return unavailable();
      },
    });
    const { session } = await kyc.start({ wallet: WALLET });
    const first = await hook(kyc, approve(session));
    assert.equal(first.record.status, "not-written");
    assert.equal(first.record.decision, "approved");
    assert.equal(first.record.reason, "no issuer key");
    assert.equal(first.record.subjectHash, undefined);

    const second = await hook(kyc, approve(session));
    assert.equal(second.replay, true);
    assert.equal(second.record, first.record);
    assert.equal(asked, 1);
  });

  it("is also final for a decline", async () => {
    const { kyc } = build({ chainThunk: unavailable });
    const { session } = await kyc.start({ wallet: WALLET });
    assert.equal((await hook(kyc, decline(session))).record.status, "not-written");
  });

  it("is a KycError with status 503", () => {
    const error = new KycUnavailable("x");
    assert.ok(error instanceof KycError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "kyc-unavailable");
  });
});

describe("subject hash", () => {
  it("is sha256(applicantId || salt), checked against an independent computation", async () => {
    const { kyc, calls } = build({ config: { subjectSalt: "fixed-salt" } });
    const { session } = await kyc.start({ wallet: WALLET });
    const { record } = await hook(kyc, approve(session));
    const want = expectedHash(`mock-applicant-${session}`, "fixed-salt");
    assert.equal(record.subjectHash, want);
    assert.equal(Buffer.from(calls.attest[0]!.subjectHash).toString("hex"), want);
  });

  it("changes with the salt for the same applicant, so the salt genuinely matters", async () => {
    const hashes: string[] = [];
    for (const subjectSalt of ["salt-a", "salt-b"]) {
      // The mock derives the applicant id from the session, so pin it by driving a custom provider.
      const { record } = await createKyc({
        config: config({ subjectSalt }),
        chain: async () => fakeChain().chain,
        provider: { start: async () => ({ url: "u" }), webhook: async () => ({ kind: "kyc.approved", wallet: WALLET, ref: "r1", applicantId: "same-applicant" }) },
        now: () => NOW,
        log: () => {},
      }).handleWebhook({}, "{}");
      hashes.push(record.subjectHash!);
    }
    assert.notEqual(hashes[0], hashes[1]);
    assert.equal(hashes[0], expectedHash("same-applicant", "salt-a"));
    assert.equal(hashes[1], expectedHash("same-applicant", "salt-b"));
  });

  it("is not the bare sha256 of the applicant id", async () => {
    const { kyc } = build();
    const { session } = await kyc.start({ wallet: WALLET });
    const { record } = await hook(kyc, approve(session));
    assert.notEqual(record.subjectHash, createHash("sha256").update(`mock-applicant-${session}`).digest("hex"));
  });

  it("never puts the applicant id in the record", async () => {
    const { kyc } = build();
    const { session } = await kyc.start({ wallet: WALLET });
    const { record } = await hook(kyc, approve(session));
    assert.ok(!JSON.stringify(record).includes("applicant"));
  });
});

describe("provider events the service must not act on", () => {
  const withEvent = (event: Record<string, unknown>) =>
    createKyc({
      config: config(),
      chain: async () => fakeChain().chain,
      provider: { start: async () => ({ url: "u" }), webhook: async () => event as never },
      now: () => NOW,
      log: () => {},
    });

  it("ignores an event kind that is neither approved nor rejected", async () => {
    await assert.rejects(() => withEvent({ kind: "kyc.pending", wallet: WALLET, ref: "r", applicantId: "a" }).handleWebhook({}, ""), { code: "event-ignored" });
  });

  it("refuses an event with no ref, since it cannot be made idempotent", async () => {
    await assert.rejects(() => withEvent({ kind: "kyc.approved", wallet: WALLET, ref: "", applicantId: "a" }).handleWebhook({}, ""), { code: "ref-missing" });
  });

  it("records not-written, and writes nothing, when the event's wallet is not an address", async () => {
    const fake = fakeChain();
    const kyc = createKyc({
      config: config(),
      chain: async () => fake.chain,
      provider: { start: async () => ({ url: "u" }), webhook: async () => ({ kind: "kyc.approved", wallet: "not-an-address", ref: "r", applicantId: "a" }) as never },
      now: () => NOW,
      log: () => {},
    });
    const { record } = await kyc.handleWebhook({}, "");
    assert.equal(record.status, "not-written");
    assert.equal(fake.calls.attest.length, 0);
  });
});

describe("status", () => {
  it("is not verified before the webhook, and pending after a start", async () => {
    const { kyc } = build();
    assert.equal((await kyc.status(WALLET)).pending, false);
    const { session } = await kyc.start({ wallet: WALLET });
    const before = await kyc.status(WALLET);
    assert.equal(before.pending, true);
    assert.equal(before.verified, false);
    assert.equal(before.attestation, null);

    await hook(kyc, approve(session));
    const after = await kyc.status(WALLET);
    assert.equal(after.pending, false);
    assert.equal(after.verified, true);
    assert.equal(after.requireKyc, true);
    assert.equal(after.issuer, ISSUER);
    assert.equal(after.attestation?.level, 1);
    assert.equal(after.last?.status, "attested");
    assert.equal(after.provider, "mock");
  });

  it("reports verified from the chain, not from the service's own record", async () => {
    const { kyc, store } = build();
    const { session } = await kyc.start({ wallet: WALLET });
    await hook(kyc, approve(session));
    store.set(WALLET, { ...store.get(WALLET)!, revoked: true });
    assert.equal((await kyc.status(WALLET)).verified, false);
  });

  it("is not verified once the attestation has expired", async () => {
    const { kyc, store } = build();
    const { session } = await kyc.start({ wallet: WALLET });
    await hook(kyc, approve(session));
    store.set(WALLET, { ...store.get(WALLET)!, expiresAt: NOW / 1000 - 1 });
    assert.equal((await kyc.status(WALLET)).verified, false);
  });

  it("is not verified when the attestation was signed by an issuer the policy no longer names", async () => {
    const { kyc } = build({ chain: { policy: { issuer: OTHER, requireKyc: true } } });
    const { session } = await kyc.start({ wallet: WALLET });
    await hook(kyc, approve(session));
    assert.equal((await kyc.status(WALLET)).verified, false);
  });

  it("reports requireKyc false and no issuer when the config has none", async () => {
    const off = build({ chain: { policy: { issuer: NO_ISSUER, requireKyc: false } } });
    assert.equal((await off.kyc.status(WALLET)).requireKyc, false);
    const none = build({ chain: { policy: null } });
    const s = await none.kyc.status(WALLET);
    assert.equal(s.requireKyc, false);
    assert.equal(s.issuer, null);
  });

  it("carries the unavailable reason, and no attestation, when the chain is unavailable", async () => {
    const { kyc } = build({ chainThunk: () => Promise.reject(new KycUnavailable("no issuer key")) });
    const s = await kyc.status(WALLET);
    assert.equal(s.unavailable, "no issuer key");
    assert.equal(s.verified, false);
    assert.equal(s.attestation, null);
  });

  it("propagates a chain error that is not KycUnavailable", async () => {
    const { kyc } = build({ chainThunk: () => Promise.reject(new Error("rpc exploded")) });
    await assert.rejects(() => kyc.status(WALLET), /rpc exploded/);
  });

  it("rejects a malformed wallet with a KycError", async () => {
    const { kyc } = build();
    await assert.rejects(() => kyc.status("nope"), (e: unknown) => e instanceof KycError && e.code === "malformed-wallet");
  });

  it("keeps wallets apart", async () => {
    const { kyc } = build();
    const { session } = await kyc.start({ wallet: WALLET });
    await hook(kyc, approve(session));
    const other = await kyc.status(OTHER);
    assert.equal(other.verified, false);
    assert.equal(other.last, null);
  });
});

describe("mockVerificationPage", () => {
  const session = { id: "sess-1", wallet: WALLET as string, provider: "mock" as const, createdAt: NOW };
  const back = "http://localhost:5173/#/app?tab=identity&kyc=";

  it("shows the session id and the wallet", () => {
    const html = mockVerificationPage(session, back);
    assert.ok(html.includes(WALLET));
    assert.ok(html.includes("sess-1"));
  });

  it("escapes HTML in the wallet and the session id", () => {
    const evil = { ...session, id: `"><img src=x onerror=alert(1)>`, wallet: `<script>alert('w')</script>` };
    const html = mockVerificationPage(evil, back);
    assert.ok(!html.includes("<script>alert('w')"));
    assert.ok(!html.includes(`"><img`));
    assert.ok(html.includes("&lt;script&gt;alert(&#39;w&#39;)"));
  });

  it("cannot be broken out of its inline script by a session id containing </script>", () => {
    const html = mockVerificationPage({ ...session, id: "x</script><script>alert(1)" }, back);
    assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
  });

  it("posts only the session and the decision, never the typed name", () => {
    const html = mockVerificationPage(session, back);
    const body = /body:\s*JSON\.stringify\(\{([^}]*)\}\)/.exec(html);
    assert.ok(body, "fetch body not found");
    assert.deepEqual(
      body[1]!.split(",").map((part) => part.split(":")[0]!.trim()),
      ["session", "decision"],
    );
    assert.ok(!/getElementById\("name"\)|\.value/.test(html), "the name input is never read");
  });
});

describe("construction", () => {
  it("throws, rather than falling back to the mock verifier, when sumsub is named without settings", () => {
    // The click-to-approve provider must never be what answers when real verification was intended.
    assert.throws(() => createKyc({ config: config({ provider: "sumsub" }), chain: async () => fakeChain().chain, log: () => {} }), /sumsub/);
  });

  it("accepts the same config when a provider is injected", () => {
    const provider = { start: async () => ({ url: "u" }), webhook: async () => ({}) as never };
    assert.doesNotThrow(() => createKyc({ config: config({ provider: "sumsub" }), chain: async () => fakeChain().chain, provider, log: () => {} }));
  });
});

describe("mock attest budget", () => {
  const HOUR = 3_600_000;
  type MockBudget = NonNullable<KycConfig["mockBudget"]>;

  function clocked(mockBudget: MockBudget | undefined) {
    let t = NOW;
    const fake = fakeChain();
    const kyc = createKyc({ config: config({ mockBudget }), chain: async () => fake.chain, now: () => t, log: () => {} });
    return { kyc, fake, advance: (ms: number) => void (t += ms) };
  }
  const budgetExhausted = (e: unknown) => e instanceof KycError && e.code === "attest-budget" && e.status === 429;

  it("refuses once the hourly cap is reached, and the attest call (so the on-chain write) never happens", async () => {
    const { kyc, fake } = clocked({ maxPerHour: 2, maxLamportsPerDay: 1_000_000_000n, lamportsPerAttest: 1n });
    for (let i = 0; i < 2; i++) {
      const { session } = await kyc.start({ wallet: WALLET });
      await hook(kyc, approve(session));
    }
    const { session } = await kyc.start({ wallet: WALLET });
    await assert.rejects(() => hook(kyc, approve(session)), budgetExhausted);
    assert.equal(fake.calls.attest.length, 2);
  });

  it("the hourly window slides with the injected clock, like the start-rate limiter", async () => {
    const { kyc, fake, advance } = clocked({ maxPerHour: 1, maxLamportsPerDay: 1_000_000_000n, lamportsPerAttest: 1n });
    const s1 = await kyc.start({ wallet: WALLET });
    await hook(kyc, approve(s1.session));
    const s2 = await kyc.start({ wallet: WALLET });
    await assert.rejects(() => hook(kyc, approve(s2.session)), budgetExhausted);
    advance(HOUR + 1);
    const s3 = await kyc.start({ wallet: WALLET });
    await assert.doesNotReject(() => hook(kyc, approve(s3.session)));
    assert.equal(fake.calls.attest.length, 2);
  });

  it("refuses once the daily lamport cap would be exceeded, independent of the hourly cap", async () => {
    const { kyc, fake } = clocked({ maxPerHour: 100, maxLamportsPerDay: 10n, lamportsPerAttest: 6n });
    const s1 = await kyc.start({ wallet: WALLET });
    await hook(kyc, approve(s1.session)); // 1st: running total 6 <= 10, ok
    const s2 = await kyc.start({ wallet: WALLET });
    await assert.rejects(() => hook(kyc, approve(s2.session)), budgetExhausted); // 2nd would be 12 > 10
    assert.equal(fake.calls.attest.length, 1);
  });

  it("is not applied when the provider is sumsub, even if mockBudget is configured", async () => {
    const fake = fakeChain();
    const tinyBudget: MockBudget = { maxPerHour: 1, maxLamportsPerDay: 1n, lamportsPerAttest: 1n };
    const sumsubLike = (ref: string) =>
      createKyc({
        config: config({ provider: "sumsub", mockBudget: tinyBudget }),
        chain: async () => fake.chain,
        provider: { start: async () => ({ url: "u" }), webhook: async () => ({ kind: "kyc.approved", wallet: WALLET, ref, applicantId: ref }) },
        now: () => NOW,
        log: () => {},
      });
    await sumsubLike("r1").handleWebhook({}, "{}");
    await sumsubLike("r2").handleWebhook({}, "{}"); // a budget of 1/hour would have refused this on the mock provider
    assert.equal(fake.calls.attest.length, 2);
  });

  it("is not applied when mockBudget is undefined (today's default outside live mode)", async () => {
    const { kyc, fake } = clocked(undefined);
    for (let i = 0; i < 5; i++) {
      const { session } = await kyc.start({ wallet: WALLET });
      await assert.doesNotReject(() => hook(kyc, approve(session)));
    }
    assert.equal(fake.calls.attest.length, 5);
  });

  it("a rejection (revoke path) is never budgeted: only approvals book an attest", async () => {
    const { kyc, fake } = clocked({ maxPerHour: 1, maxLamportsPerDay: 1_000_000_000n, lamportsPerAttest: 1n });
    const s1 = await kyc.start({ wallet: WALLET });
    await hook(kyc, decline(s1.session)); // nothing-to-revoke; must not count against the budget
    const s2 = await kyc.start({ wallet: WALLET });
    await assert.doesNotReject(() => hook(kyc, approve(s2.session)));
    assert.equal(fake.calls.attest.length, 1);
  });
});

describe("start rate limit", () => {
  const HOUR = 3_600_000;
  function clocked(limit: number) {
    let t = NOW;
    const kyc = createKyc({ config: config({ maxStartsPerWalletPerHour: limit }), chain: async () => fakeChain().chain, now: () => t, log: () => {} });
    return { kyc, advance: (ms: number) => void (t += ms) };
  }
  const refused = (e: unknown) => e instanceof KycError && e.code === "rate-limited" && e.status === 429;

  it("refuses the start after the limit, and leaves another wallet alone", async () => {
    const { kyc } = clocked(3);
    for (let i = 0; i < 3; i++) await kyc.start({ wallet: WALLET });
    await assert.rejects(() => kyc.start({ wallet: WALLET }), refused);
    await assert.doesNotReject(() => kyc.start({ wallet: OTHER }));
  });

  it("slides: a start frees up once the oldest falls out of the hour", async () => {
    const { kyc, advance } = clocked(2);
    await kyc.start({ wallet: WALLET });
    advance(HOUR / 2);
    await kyc.start({ wallet: WALLET });
    await assert.rejects(() => kyc.start({ wallet: WALLET }), refused);
    advance(HOUR / 2 + 1); // the first start is now just over an hour old, the second is not
    await kyc.start({ wallet: WALLET });
    await assert.rejects(() => kyc.start({ wallet: WALLET }), refused);
  });

  it("does not count a start the provider failed to issue", async () => {
    let fail = true;
    const kyc = createKyc({
      config: config({ maxStartsPerWalletPerHour: 1 }),
      chain: async () => fakeChain().chain,
      provider: { start: async () => (fail ? { url: "" } : { url: "u" }), webhook: async () => ({}) as never },
      now: () => NOW,
      log: () => {},
    });
    await assert.rejects(() => kyc.start({ wallet: WALLET }), { code: "provider-no-url" });
    fail = false;
    await assert.doesNotReject(() => kyc.start({ wallet: WALLET }));
  });

  it("defaults to ten an hour", async () => {
    const kyc = createKyc({ config: config(), chain: async () => fakeChain().chain, now: () => NOW, log: () => {} });
    for (let i = 0; i < 10; i++) await kyc.start({ wallet: WALLET });
    await assert.rejects(() => kyc.start({ wallet: WALLET }), refused);
  });
});

describe("session pruning", () => {
  it("drops sessions older than 24 hours on the next start, and keeps younger ones", async () => {
    let t = NOW;
    const kyc = createKyc({ config: config(), chain: async () => fakeChain().chain, now: () => t, log: () => {} });
    const old = await kyc.start({ wallet: WALLET });
    t += 12 * 3_600_000;
    const mid = await kyc.start({ wallet: OTHER });
    t += 13 * 3_600_000; // old is 25h, mid is 13h
    await kyc.start({ wallet: OTHER });
    assert.equal(kyc.session(old.session), undefined);
    assert.ok(kyc.session(mid.session));
    await assert.rejects(() => hook(kyc, approve(old.session)), (e: unknown) => e instanceof WebhookError && e.code === "session-unknown");
  });
});

describe("replay of a captured Sumsub delivery after a restart", () => {
  const SECRET = "whsec_restart";
  const sumsub = { appToken: "t", secretKey: "k", webhookSecret: SECRET, apiBase: "https://s.test", levelName: "l", linkTtlSeconds: 60, digestAlg: "", maxEventAgeSeconds: 600 };
  const stamp = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");
  const delivery = (answer: "GREEN" | "RED", createdMs: number) => {
    const raw = JSON.stringify({
      type: "applicantReviewed",
      applicantId: "app-1",
      correlationId: `corr-${answer}`,
      externalUserId: WALLET,
      reviewResult: { reviewAnswer: answer, ...(answer === "RED" ? { reviewRejectType: "FINAL" } : {}) },
      createdAtMs: stamp(createdMs),
    });
    return { raw, headers: { "x-payload-digest": createHmac("sha256", SECRET).update(raw).digest("hex") } };
  };
  const boot = (chain: AttestationChain, clock: { t: number }) =>
    createKyc({ config: config({ provider: "sumsub", sumsub }), chain: async () => chain, now: () => clock.t, log: () => {} });

  it("is refused as stale by a fresh instance, does not attest, and the wallet stays revoked", async () => {
    const fake = fakeChain();
    const clock = { t: NOW };
    const first = boot(fake.chain, clock);

    const green = delivery("GREEN", NOW);
    assert.equal((await first.handleWebhook(green.headers, green.raw)).record.status, "attested");
    clock.t += 60_000;
    const red = delivery("RED", clock.t);
    assert.equal((await first.handleWebhook(red.headers, red.raw)).record.status, "revoked");
    assert.equal(fake.calls.attest.length, 1);

    // A restart empties the dedupe store, so the only thing left between the captured GREEN and the
    // revoked wallet is the freshness window.
    const restarted = boot(fake.chain, { t: clock.t + 20 * 60_000 });
    await assert.rejects(() => restarted.handleWebhook(green.headers, green.raw), (e: unknown) => e instanceof WebhookError && e.code === "event-stale");
    assert.equal(fake.calls.attest.length, 1);
    assert.equal(fake.store.get(WALLET)!.revoked, true);
    assert.equal((await restarted.status(WALLET)).verified, false);
  });

  it("the same replay inside the window is caught by the dedupe store of a live instance instead", async () => {
    const fake = fakeChain();
    const clock = { t: NOW };
    const kyc = boot(fake.chain, clock);
    const green = delivery("GREEN", NOW);
    await kyc.handleWebhook(green.headers, green.raw);
    const again = await kyc.handleWebhook(green.headers, green.raw);
    assert.equal(again.replay, true);
    assert.equal(fake.calls.attest.length, 1);
  });
});
