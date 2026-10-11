import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { env, assertEnvConsistent } = await import("../src/env.ts");
const { assertMockKycAllowed, DEVNET_GENESIS_HASH } = await import("../src/boot.ts");
import type { Env } from "../src/env.ts";

const withEnv = (patch: Record<string, unknown> & { kyc?: Partial<Env["kyc"]> } = {}): Env => {
  const { kyc, ...rest } = patch;
  return { ...env, ...rest, kyc: { ...env.kyc, ...kyc } } as unknown as Env;
};

// A complete, internally-consistent live config using wallet login and a real Sumsub KYC setup
// (so KYC never needs its own mock-devnet carve-out for these wallet/auth-mode assertions).
const liveWallet = {
  mode: "live",
  authMode: "wallet",
  appUrlExplicit: true,
  appUrl: "https://app.example",
  feePayerKeypair: "fp",
  treasuryKeypair: "tr",
  attestationIssuerKeypair: "iss",
  rusdcMint: "mint",
  sessionSecret: "s",
  adminToken: "a",
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
});
