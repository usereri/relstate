import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as anchor from "@anchor-lang/core";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { MINT } from "../config";
import { localKeypair } from "../wallet";

const { PublicKey } = anchor.web3;

// chain.ts builds a Connection at module load and config.ts needs an RPC; neither touches the
// network until a read is made, and the one read here (getAccountInfo) is stubbed.
beforeEach(() => vi.stubEnv("VITE_RPC", "http://127.0.0.1:8899"));
afterEach(() => vi.unstubAllEnvs());

async function load(owner: anchor.web3.PublicKey | null | Error) {
  vi.resetModules();
  const chain = await import("../chain");
  const spy = vi.spyOn(chain.connection, "getAccountInfo").mockImplementation((async () => {
    if (owner instanceof Error) throw owner;
    return owner ? { owner } : null;
  }) as never);
  return { chain, spy };
}

describe("tokenProgram", () => {
  it("resolves a Token-2022 mint to TOKEN_2022_PROGRAM_ID", async () => {
    const { chain } = await load(TOKEN_2022_PROGRAM_ID);
    expect((await chain.tokenProgram()).toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  });

  it("resolves a classic mint to TOKEN_PROGRAM_ID", async () => {
    const { chain } = await load(TOKEN_PROGRAM_ID);
    expect((await chain.tokenProgram()).toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
  });

  it("resolves a foreign-program owner to TOKEN_PROGRAM_ID (a real answer, not a fallback)", async () => {
    const { chain } = await load(PublicKey.default);
    expect((await chain.tokenProgram()).toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
  });

  it("rejects a missing mint with a message naming the mint", async () => {
    const { chain } = await load(null);
    await expect(chain.tokenProgram()).rejects.toThrow(new RegExp(`${MINT}.*does not exist`));
  });

  it("propagates an RPC error instead of falling back to classic", async () => {
    const { chain } = await load(new Error("rpc down"));
    await expect(chain.tokenProgram()).rejects.toThrow("rpc down");
  });

  it("a failed read is not cached: the next call re-reads and succeeds", async () => {
    const { chain, spy } = await load(TOKEN_2022_PROGRAM_ID);
    spy.mockRejectedValueOnce(new Error("blip"));
    await expect(chain.tokenProgram()).rejects.toThrow("blip");
    expect((await chain.tokenProgram()).toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("a missing mint is retried too, once it exists", async () => {
    const { chain, spy } = await load(TOKEN_2022_PROGRAM_ID);
    spy.mockResolvedValueOnce(null);
    await expect(chain.tokenProgram()).rejects.toThrow(/does not exist/);
    expect((await chain.tokenProgram()).toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  });

  it("reads the mint once and caches the answer", async () => {
    const { chain, spy } = await load(TOKEN_2022_PROGRAM_ID);
    await Promise.all([chain.tokenProgram(), chain.tokenProgram()]);
    await chain.tokenProgram();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].toBase58()).toBe(MINT);
  });
});

describe("tokenAccountFor", () => {
  // Locked-in literals: what getAssociatedTokenAddressSync(MINT, wallet) returned before the
  // token-program change. A wrong ATA silently breaks the local demo flow.
  const LANDLORD_ATA = "3tGRbBEkBD64ihcfeP7u4G4WDfGcgcgviwSEdb9hv1GL";
  const TENANT_ATA = "2RNz6yazJAzwTJo2HFa39s2buH5nbsWmiGBfYAF6i6Av";

  it("on the classic path returns the literal pre-change ATAs", async () => {
    const { chain } = await load(TOKEN_PROGRAM_ID);
    expect((await chain.tokenAccountFor(localKeypair("landlord").publicKey)).toBase58()).toBe(LANDLORD_ATA);
    expect((await chain.tokenAccountFor(localKeypair("tenant").publicKey)).toBase58()).toBe(TENANT_ATA);
  });

  it("on the classic path equals getAssociatedTokenAddressSync(mint, wallet)", async () => {
    const { chain } = await load(TOKEN_PROGRAM_ID);
    const w = localKeypair("tenant").publicKey;
    expect((await chain.tokenAccountFor(w)).toBase58()).toBe(getAssociatedTokenAddressSync(new PublicKey(MINT), w).toBase58());
  });

  it("on Token-2022 derives the ATA under that program, which differs", async () => {
    const { chain } = await load(TOKEN_2022_PROGRAM_ID);
    const w = localKeypair("tenant").publicKey;
    const got = await chain.tokenAccountFor(w);
    expect(got.toBase58()).toBe(getAssociatedTokenAddressSync(new PublicKey(MINT), w, false, TOKEN_2022_PROGRAM_ID).toBase58());
    expect(got.toBase58()).not.toBe(TENANT_ATA);
  });
});

describe("loadBalances", () => {
  it("reports usdc: null, not a rejection, when the token program cannot be resolved", async () => {
    const { chain } = await load(new Error("rpc down"));
    vi.spyOn(chain.connection, "getBalance").mockResolvedValue(2_000_000_000);
    expect(await chain.loadBalances(localKeypair("tenant").publicKey.toBase58())).toEqual({ sol: 2, usdc: null });
  });
});
