import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { env, assertEnvConsistent, weakSecret } = await import("../src/env.ts");
const { assertMockKycAllowed, DEVNET_GENESIS_HASH } = await import("../src/boot.ts");
import type { Env } from "../src/env.ts";

const withEnv = (patch: Record<string, unknown> & { kyc?: Partial<Env["kyc"]>; invites?: Partial<Env["invites"]> } = {}): Env => {
  const { kyc, invites, ...rest } = patch;
  return { ...env, ...rest, kyc: { ...env.kyc, ...kyc }, invites: { ...env.invites, ...invites } } as unknown as Env;
};

// Strong enough to pass weakSecret (>=32 chars, >=10 distinct): this file is about the auth-mode
// and KYC rules, not secret strength, which gets its own tests below.
const STRONG_SECRET = "9f3a7c1e5b8d2f0a4c6e9b1d3f5a7c9e1b3d5f7a";

// A complete, internally-consistent live config using wallet login and a real Sumsub KYC setup
// (so KYC never needs its own mock-devnet carve-out for these wallet/auth-mode assertions).
// `databasePath` is part of "complete": live mode refuses a deployment that would keep its webhook
// idempotency keys in memory, and the DATABASE_PATH block below is what tests that on its own.
const liveWallet = {
  mode: "live",
  authMode: "wallet",
  databasePath: "/data/relstate.db",
  appUrlExplicit: true,
  appUrl: "https://app.example",
  corsOrigin: "https://app.example",
  feePayerKeypair: "fp",
  treasuryKeypair: "tr",
  attestationIssuerKeypair: "iss",
  rusdcMint: "mint",
  sessionSecret: STRONG_SECRET,
  adminToken: STRONG_SECRET,
  kyc: { provider: "sumsub", sumsubAppToken: "t", sumsubSecretKey: "k", sumsubWebhookSecret: "w", sumsubLevelName: "lvl", subjectSalt: "salt" },
} as const;

const message = (e: Env): string => {
  try {
    assertEnvConsistent(e);
  } catch (error) {
    return (error as Error).message;
  }
  return "";
};

describe("assertEnvConsistent: auth mode", () => {
  it("accepts a complete live config using wallet auth", () => {
    assert.equal(message(withEnv(liveWallet)), "");
  });

  it("BACKEND_MODE=live refuses AUTH_MODE=mock", () => {
    const msg = message(withEnv({ ...liveWallet, authMode: "mock" }));
    assert.ok(msg.includes("AUTH_MODE=mock is refused when BACKEND_MODE=live"), msg);
  });

  it("BACKEND_MODE=live refuses AUTH_MODE=hmac (no login route)", () => {
    const msg = message(withEnv({ ...liveWallet, authMode: "hmac" }));
    assert.ok(msg.includes("AUTH_MODE=hmac") && msg.includes("refused when BACKEND_MODE=live"), msg);
  });

  it("AUTH_MODE=hmac is fine outside live mode", () => {
    assert.equal(message(withEnv({ authMode: "hmac" })), "");
  });

  it("AUTH_MODE=wallet in live mode requires an explicit APP_URL", () => {
    const msg = message(withEnv({ ...liveWallet, appUrlExplicit: false }));
    assert.ok(msg.includes("APP_URL is required when AUTH_MODE=wallet"), msg);
  });

  it("AUTH_MODE=wallet with an explicit APP_URL passes", () => {
    assert.equal(message(withEnv({ ...liveWallet, appUrlExplicit: true })), "");
  });

  it("does not require an explicit APP_URL outside live mode, even with AUTH_MODE=wallet", () => {
    assert.equal(message(withEnv({ authMode: "wallet", appUrlExplicit: false })), "");
  });
});

describe("assertEnvConsistent: CORS_ORIGIN in live mode", () => {
  it("BACKEND_MODE=live refuses the default CORS_ORIGIN (*)", () => {
    const msg = message(withEnv({ ...liveWallet, corsOrigin: "*" }));
    assert.ok(msg.includes("CORS_ORIGIN must be set to the app's origin when BACKEND_MODE=live"), msg);
  });

  it("BACKEND_MODE=live refuses an empty CORS_ORIGIN", () => {
    const msg = message(withEnv({ ...liveWallet, corsOrigin: "" }));
    assert.ok(msg.includes("CORS_ORIGIN must be set"), msg);
  });

  it("BACKEND_MODE=live accepts a real origin", () => {
    assert.equal(message(withEnv({ ...liveWallet, corsOrigin: "https://app.example" })), "");
  });

  it("CORS_ORIGIN=* is fine outside live mode", () => {
    assert.equal(message(withEnv({ corsOrigin: "*" })), "");
  });
});

describe("assertEnvConsistent: ALLOW_MOCK_KYC in live mode", () => {
  it("KYC_PROVIDER=mock in live mode is refused without ALLOW_MOCK_KYC", () => {
    const msg = message(withEnv({ ...liveWallet, kyc: { ...liveWallet.kyc, provider: "mock" } }));
    assert.ok(msg.includes("KYC_PROVIDER=mock is refused"), msg);
  });

  it("ALLOW_MOCK_KYC=devnet is refused when the cluster is not devnet", () => {
    const msg = message(withEnv({ ...liveWallet, cluster: "mainnet-beta", kyc: { ...liveWallet.kyc, provider: "mock", allowMock: "devnet" } }));
    assert.ok(msg.includes("KYC_PROVIDER=mock is refused"), msg);
  });

  it("ALLOW_MOCK_KYC=devnet with SOLANA_CLUSTER=devnet is accepted", () => {
    assert.equal(message(withEnv({ ...liveWallet, cluster: "devnet", kyc: { ...liveWallet.kyc, provider: "mock", allowMock: "devnet" } })), "");
  });

  it("ALLOW_MOCK_KYC must be exactly 'devnet'; any other value (e.g. 'mainnet') is refused", () => {
    const msg = message(withEnv({ kyc: { allowMock: "mainnet" } }));
    assert.ok(msg.includes('ALLOW_MOCK_KYC must be exactly "devnet"'), msg);
  });
});

describe("weakSecret", () => {
  it("flags anything under 32 characters, however varied", () => {
    assert.equal(weakSecret("Sh0rt!"), true);
    assert.equal(weakSecret("a".repeat(31)), true);
  });

  it("flags a long but low-variety string (repeated short pattern)", () => {
    assert.equal(weakSecret("a".repeat(40)), true);
    assert.equal(weakSecret("1234".repeat(10)), true); // 40 chars, only 4 distinct
  });

  it("accepts a long, varied string", () => {
    assert.equal(weakSecret(STRONG_SECRET), false);
  });
});

describe("assertEnvConsistent: secret strength in live mode", () => {
  it("refuses a weak SESSION_SECRET", () => {
    const msg = message(withEnv({ ...liveWallet, sessionSecret: "a".repeat(40) }));
    assert.ok(msg.includes("SESSION_SECRET is too weak"), msg);
  });

  it("refuses a weak ADMIN_TOKEN", () => {
    const msg = message(withEnv({ ...liveWallet, adminToken: "1234".repeat(10) }));
    assert.ok(msg.includes("ADMIN_TOKEN is too weak"), msg);
  });

  it("refuses a too-short SESSION_SECRET", () => {
    const msg = message(withEnv({ ...liveWallet, sessionSecret: "short-secret" }));
    assert.ok(msg.includes("SESSION_SECRET is too weak"), msg);
  });

  it("accepts strong secrets", () => {
    assert.equal(message(withEnv(liveWallet)), "");
  });

  it("does not demand secret strength outside live mode", () => {
    assert.equal(message(withEnv({ sessionSecret: "a".repeat(40), adminToken: "1234".repeat(10) })), "");
  });

  it("an empty SESSION_SECRET/ADMIN_TOKEN is reported as missing, not as weak", () => {
    const msg = message(withEnv({ ...liveWallet, sessionSecret: "", adminToken: "" }));
    assert.ok(msg.includes("SESSION_SECRET is required"), msg);
    assert.ok(msg.includes("ADMIN_TOKEN is required"), msg);
    assert.ok(!msg.includes("too weak"), msg);
  });
});

// DATABASE_PATH decides whether a restart forgets the webhook idempotency keys, the outstanding
// appraiser invitations and every spend budget (backend/src/store.ts). So the rules are: live mode
// must have made a choice, and whatever is set must be openable.
describe("assertEnvConsistent: DATABASE_PATH", () => {
  it("refuses a live deployment that never set it", () => {
    // The failure it prevents is quiet and expensive: a redeploy between a provider's first webhook
    // delivery and its retry would mint rUSDC twice for one payment.
    const msg = message(withEnv({ ...liveWallet, databasePath: "" }));
    assert.ok(msg.includes("DATABASE_PATH is required when BACKEND_MODE=live"), msg);
  });

  it("accepts an explicit :memory: in live mode, because that is a choice rather than an oversight", () => {
    assert.equal(message(withEnv({ ...liveWallet, databasePath: ":memory:" })), "");
  });

  it("accepts an absolute path in live mode", () => {
    assert.equal(message(withEnv({ ...liveWallet, databasePath: "/data/relstate.db" })), "");
  });

  it("does not demand one outside live mode", () => {
    // `npm run dev` and the tests run with it unset, and must stay bootable.
    assert.equal(message(withEnv({ databasePath: "" })), "");
  });

  it("refuses a relative path in any mode", () => {
    // It would resolve against `backend/` under `npm run dev` and `/app/backend` in the container,
    // so one setting would name two files and a deployment would look like it had forgotten everything.
    for (const databasePath of ["relstate.db", "./data/relstate.db", "../relstate.db"]) {
      const msg = message(withEnv({ databasePath }));
      assert.ok(msg.includes("DATABASE_PATH must be an absolute path"), `${databasePath}: ${msg}`);
      assert.ok(msg.includes(databasePath), `${databasePath}: the message should name the offending value, got ${msg}`);
    }
  });

  it("refuses a directory, since SQLite is about to open it as a file", () => {
    const msg = message(withEnv({ databasePath: "/data/" }));
    assert.ok(msg.includes("DATABASE_PATH must name the database file"), msg);
  });

  it("accepts an absolute path outside live mode", () => {
    assert.equal(message(withEnv({ databasePath: "/tmp/relstate.db" })), "");
  });
});

describe("assertEnvConsistent: mock-KYC budget", () => {
  it("requires a positive hourly attest cap", () => {
    for (const mockMaxAttestsPerHour of [0, -1, Number.NaN]) {
      assert.ok(message(withEnv({ kyc: { mockMaxAttestsPerHour } })).includes("KYC_MOCK_MAX_ATTESTS_PER_HOUR"), String(mockMaxAttestsPerHour));
    }
    assert.equal(message(withEnv({ kyc: { mockMaxAttestsPerHour: 1 } })), "");
  });

  it("requires a positive daily lamport cap", () => {
    for (const mockMaxLamportsPerDay of [0n, -1n]) {
      assert.ok(message(withEnv({ kyc: { mockMaxLamportsPerDay } })).includes("KYC_MOCK_MAX_LAMPORTS_PER_DAY"), String(mockMaxLamportsPerDay));
    }
    assert.equal(message(withEnv({ kyc: { mockMaxLamportsPerDay: 1n } })), "");
  });

  it("requires a positive per-attest lamport cost", () => {
    for (const mockLamportsPerAttest of [0n, -1n]) {
      assert.ok(message(withEnv({ kyc: { mockLamportsPerAttest } })).includes("KYC_MOCK_LAMPORTS_PER_ATTEST"), String(mockLamportsPerAttest));
    }
    assert.equal(message(withEnv({ kyc: { mockLamportsPerAttest: 1n } })), "");
  });

  it("the no-secrets mock default already satisfies the budget invariants", () => {
    assert.equal(message(withEnv()), "");
  });
});

describe("assertEnvConsistent: INVITE_EMAIL_SENDER", () => {
  it("accepts console, none and blank", () => {
    assert.equal(message(withEnv({ invites: { emailSender: "console" } })), "");
    assert.equal(message(withEnv({ invites: { emailSender: "none" } })), "");
    assert.equal(message(withEnv({ invites: { emailSender: "" } })), "");
  });

  it("accepts resend when fully configured", () => {
    assert.equal(message(withEnv({ invites: { emailSender: "resend", resendApiKey: "re_test_0123456789abcdef", emailFrom: "invites@relstate.casa" } })), "");
  });

  it("refuses a typo, naming the valid values", () => {
    const msg = message(withEnv({ invites: { emailSender: "resnd" } }));
    assert.ok(msg.includes('INVITE_EMAIL_SENDER must be "console", "resend", "none" or unset'), msg);
  });

  it("resend without RESEND_API_KEY is refused with its own problem", () => {
    const msg = message(withEnv({ invites: { emailSender: "resend", resendApiKey: "", emailFrom: "invites@relstate.casa" } }));
    assert.ok(msg.includes("RESEND_API_KEY is required when INVITE_EMAIL_SENDER=resend"), msg);
  });

  it("resend without INVITE_EMAIL_FROM is refused with its own problem", () => {
    const msg = message(withEnv({ invites: { emailSender: "resend", resendApiKey: "re_test_0123456789abcdef", emailFrom: "" } }));
    assert.ok(msg.includes("INVITE_EMAIL_FROM is required when INVITE_EMAIL_SENDER=resend"), msg);
  });

  it("resend with a malformed INVITE_EMAIL_FROM is refused", () => {
    const msg = message(withEnv({ invites: { emailSender: "resend", resendApiKey: "re_test_0123456789abcdef", emailFrom: "not-an-address" } }));
    assert.ok(msg.includes("INVITE_EMAIL_FROM must be an e-mail address"), msg);
  });

  it("resend accepts a bare address and a 'Name <addr@host>' form", () => {
    assert.equal(message(withEnv({ invites: { emailSender: "resend", resendApiKey: "re_test_0123456789abcdef", emailFrom: "invites@relstate.casa" } })), "");
    assert.equal(message(withEnv({ invites: { emailSender: "resend", resendApiKey: "re_test_0123456789abcdef", emailFrom: "Relstate <invites@relstate.casa>" } })), "");
  });

  // INVITE_EMAIL_TIMEOUT_MS and RESEND_API_BASE have their own describe below, which covers the
  // whole range of bad values rather than one of them.

  it("none of the resend requirements fire when the sender is not resend", () => {
    assert.equal(message(withEnv({ invites: { emailSender: "console", resendApiKey: "", emailFrom: "", emailTimeoutMs: 0, resendApiBase: "not a url" } })), "");
    assert.equal(message(withEnv({ invites: { emailSender: "", resendApiKey: "", emailFrom: "", emailTimeoutMs: 0.5, resendApiBase: "http://x" } })), "");
  });
});

describe("assertEnvConsistent: resend transport settings", () => {
  const resend = { emailSender: "resend", resendApiKey: "re_test_0123456789abcdef", emailFrom: "invites@relstate.casa" } as const;
  const problem = (patch: Partial<Env["invites"]>): string => message(withEnv({ invites: { ...resend, ...patch } }));

  it("accepts a whole number of milliseconds up to the 32-bit signed maximum", () => {
    for (const emailTimeoutMs of [1, 10_000, 2_147_483_647]) {
      assert.equal(problem({ emailTimeoutMs }), "", `INVITE_EMAIL_TIMEOUT_MS=${emailTimeoutMs} should be accepted`);
    }
  });

  /**
   * `AbortSignal.timeout` rejects a fraction outright, but **accepts** anything above 2^31-1 and
   * then collapses the timer to 1 ms with only a `TimeoutOverflowWarning`. So 4294967295 — the
   * unsigned maximum, and the obvious bound to reach for — would boot cleanly and make every single
   * send time out instantly, which the operator would read as the network being down. It is in this
   * list for exactly that reason.
   */
  it("refuses a fraction, zero, a negative, NaN, and anything above the 32-bit signed maximum", () => {
    for (const emailTimeoutMs of [0, -1, 500.5, 5e9, NaN, 2_147_483_648, 4_294_967_295]) {
      assert.match(problem({ emailTimeoutMs }), /INVITE_EMAIL_TIMEOUT_MS must be a whole number of milliseconds between 1 and 2147483647/, `INVITE_EMAIL_TIMEOUT_MS=${emailTimeoutMs} should be refused`);
    }
  });

  it("accepts an https RESEND_API_BASE", () => {
    for (const resendApiBase of ["https://api.resend.com", "https://resend.internal/v1"]) {
      assert.equal(problem({ resendApiBase }), "", `RESEND_API_BASE=${resendApiBase} should be accepted`);
    }
  });

  // The base carries the bearer key and a live invite token, so plain http is refused rather than
  // merely discouraged — and a value that is not a URL at all would otherwise fail at the first send.
  it("refuses a plain-http or unparseable RESEND_API_BASE", () => {
    assert.match(problem({ resendApiBase: "http://api.resend.com" }), /RESEND_API_BASE must be https/);
    assert.match(problem({ resendApiBase: "not a url" }), /RESEND_API_BASE must be a URL/);
    assert.match(problem({ resendApiBase: "" }), /RESEND_API_BASE must be a URL/);
  });
});

describe("assertMockKycAllowed", () => {
  const warnings: string[] = [];
  const warn = (line: string) => warnings.push(line);

  it("skips (no RPC call) when not in live mode", async () => {
    warnings.length = 0;
    await assertMockKycAllowed(async () => {
      throw new Error("should not be called");
    }, warn, withEnv({ mode: "mock", kyc: { provider: "mock" } }));
    assert.equal(warnings.length, 0);
  });

  it("skips (no RPC call) when the KYC provider is not mock", async () => {
    warnings.length = 0;
    await assertMockKycAllowed(async () => {
      throw new Error("should not be called");
    }, warn, withEnv({ ...liveWallet, kyc: { provider: "sumsub" } }));
    assert.equal(warnings.length, 0);
  });

  const liveMock = withEnv({ ...liveWallet, cluster: "devnet", kyc: { ...liveWallet.kyc, provider: "mock", allowMock: "devnet" } });

  it("throws when the RPC's genesis hash is not devnet's", async () => {
    await assert.rejects(
      () => assertMockKycAllowed(async () => "SomeOtherGenesisHash1111111111111111111111", warn, liveMock),
      /not devnet/,
    );
  });

  it("throws when getGenesisHash itself rejects", async () => {
    await assert.rejects(
      () => assertMockKycAllowed(async () => {
        throw new Error("rpc down");
      }, warn, liveMock),
      /cannot confirm the RPC is devnet/,
    );
  });

  it("passes and warns loudly when the RPC confirms devnet", async () => {
    warnings.length = 0;
    await assertMockKycAllowed(async () => DEVNET_GENESIS_HASH, warn, liveMock);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes("WARNING"));
    assert.ok(warnings[0]!.includes("MOCK KYC"));
  });

  it("the warning calls out the lack of sybil resistance", async () => {
    warnings.length = 0;
    await assertMockKycAllowed(async () => DEVNET_GENESIS_HASH, warn, liveMock);
    assert.ok(warnings[0]!.toLowerCase().includes("sybil"), warnings[0]);
  });
});
