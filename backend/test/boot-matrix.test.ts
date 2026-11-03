import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { env, assertEnvConsistent, weakSecret } = await import("../src/env.ts");
const { assertMockKycAllowed, DEVNET_GENESIS_HASH } = await import("../src/boot.ts");
import type { Env } from "../src/env.ts";

const withEnv = (patch: Record<string, unknown> & { kyc?: Partial<Env["kyc"]> } = {}): Env => {
  const { kyc, ...rest } = patch;
  return { ...env, ...rest, kyc: { ...env.kyc, ...kyc } } as unknown as Env;
};

// Strong enough to pass weakSecret (>=32 chars, >=10 distinct): this file is about the auth-mode
// and KYC rules, not secret strength, which gets its own tests below.
const STRONG_SECRET = "9f3a7c1e5b8d2f0a4c6e9b1d3f5a7c9e1b3d5f7a";

// A complete, internally-consistent live config using wallet login and a real Sumsub KYC setup
// (so KYC never needs its own mock-devnet carve-out for these wallet/auth-mode assertions).
const liveWallet = {
  mode: "live",
  authMode: "wallet",
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
