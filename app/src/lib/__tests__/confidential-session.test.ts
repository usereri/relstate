import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as kit from "@solana/kit";

// confidential.ts and sponsor.ts read VITE_API / VITE_FEE_PAYER / VITE_RUSDC_MINT at module load,
// so each case stubs env and re-imports, exactly as fiat.test.ts and chain.test.ts do.
const FEE_PAYER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const TREASURY = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const RUSDC_MINT = "EBMibFLTvr5GDpgxNqt5Gqp9B1xLMr32aNwGDJV2oGJ6";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function load() {
  vi.resetModules();
  vi.stubEnv("VITE_API", "http://b");
  vi.stubEnv("VITE_FEE_PAYER", FEE_PAYER);
  vi.stubEnv("VITE_RUSDC_MINT", RUSDC_MINT);
  return import("../confidential");
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(json({ treasury: TREASURY, rusdcMint: RUSDC_MINT, auditorConfigured: true })),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("openSession", () => {
  it("gives the token-account owner a noop signer as the authority, not a bare address", async () => {
    const { openSession } = await load();
    const { localWallet } = await import("../wallet");
    const wallet = localWallet("tenant");

    const session = await openSession({ wallet, mint: RUSDC_MINT, rpcUrl: "http://127.0.0.1:9" });

    // A bare Address is a string; the owner must be marked as signing so the token program accepts
    // its instructions (configure/deposit/apply/transfer), with the wallet filling in the real
    // signature afterwards exactly like the sponsored fee payer.
    expect(typeof session.authority).toBe("object");
    const authority = session.authority as kit.TransactionSigner;
    expect(authority.address).toBe(kit.address(wallet.publicKey.toBase58()));
    expect(typeof authority.signTransactions).toBe("function");

    // A genuine noop signer produces no signature of its own.
    const sig = await authority.signTransactions([]);
    expect(sig).toEqual([]);
  });

  it("uses the backend's fee payer and treasury as noop signers for payer and setupPayer", async () => {
    const { openSession } = await load();
    const { localWallet } = await import("../wallet");
    const wallet = localWallet("landlord");

    const session = await openSession({ wallet, mint: RUSDC_MINT, rpcUrl: "http://127.0.0.1:9" });

    expect(session.payer.address).toBe(kit.address(FEE_PAYER));
    expect(session.setupPayer.address).toBe(kit.address(TREASURY));
  });
});
