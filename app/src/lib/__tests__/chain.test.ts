import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as anchor from "@anchor-lang/core";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { localKeypair } from "../wallet";

const { PublicKey } = anchor.web3;

// chain.ts builds a Connection at module load and config.ts needs an RPC; neither touches the
// network until a read is made, and the one read here (getAccountInfo) is stubbed.
// The mint is pinned here rather than read from config.ts: a developer's app/.env.local sets VITE_MINT, and the ATA literals below are derived from this one.
const MINT = "Gco8ivBzZTq9U4iBLEApWxy8bcHbtenNP6crmYQcPCXH";
beforeEach(() => {
  vi.stubEnv("VITE_RPC", "http://127.0.0.1:8899");
  vi.stubEnv("VITE_MINT", MINT);
});
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
  // Locked-in literals: what getAssociatedTokenAddressSync(MINT, wallet) returned for the current MINT (config.ts) before the
  // token-program change. A wrong ATA silently breaks the local demo flow.
  const LANDLORD_ATA = "8rEpxbk94jdbhmesi8s1CrPtsYkAEGzWdG5PCmPtFU3j";
  const TENANT_ATA = "4wbV4ucvkXG5DXD5ZkbWg9eVdWwgQ8PQuj4zgYQA9YgB";

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

describe("withComputeBudget", () => {
  const { ComputeBudgetInstruction, ComputeBudgetProgram, SystemProgram, Transaction } = anchor.web3;
  const transfer = () =>
    SystemProgram.transfer({ fromPubkey: localKeypair("tenant").publicKey, toPubkey: localKeypair("landlord").publicKey, lamports: 1 });
  // The sponsor's defaults (backend/src/env.ts): a budget above any of them is refused before
  // the sponsor simulates, so the app must stay inside all three on a backend left at defaults.
  const SPONSOR_DEFAULT_MAX_UNITS = 400_000;
  const SPONSOR_DEFAULT_MAX_PRICE = 10_000;
  const SPONSOR_DEFAULT_MAX_FEE = 200_000;

  it("prepends a unit limit and a price, ahead of the program's instructions", async () => {
    const { chain } = await load(null);
    const tx = chain.withComputeBudget(new Transaction().add(transfer()));
    expect(tx.instructions).toHaveLength(3);
    expect(tx.instructions.slice(0, 2).every((ix) => ix.programId.equals(ComputeBudgetProgram.programId))).toBe(true);
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(tx.instructions[0]).units).toBe(200_000);
    expect(ComputeBudgetInstruction.decodeSetComputeUnitPrice(tx.instructions[1]).microLamports).toBe(BigInt(chain.SPONSORED_CU_PRICE_MICRO_LAMPORTS));
    expect(tx.instructions[2].programId.equals(SystemProgram.programId)).toBe(true);
  });

  it("matches the runtime default for two instructions and stops at the sponsor's cap above that", async () => {
    const { chain } = await load(null);
    const units = (n: number) =>
      ComputeBudgetInstruction.decodeSetComputeUnitLimit(chain.withComputeBudget(new Transaction().add(...Array.from({ length: n }, transfer))).instructions[0]).units;
    expect(units(2)).toBe(400_000);
    expect(units(5)).toBe(SPONSOR_DEFAULT_MAX_UNITS);
  });

  it("leaves a transaction that already sets a budget alone", async () => {
    const { chain } = await load(null);
    const own = ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 });
    const tx = chain.withComputeBudget(new Transaction().add(own, transfer()));
    expect(tx.instructions).toHaveLength(2);
    expect(tx.instructions[0]).toBe(own);
  });

  it("stays inside the sponsor's default unit, price and worst-case fee caps", async () => {
    const { chain } = await load(null);
    expect(chain.SPONSORED_MAX_COMPUTE_UNITS).toBeLessThanOrEqual(SPONSOR_DEFAULT_MAX_UNITS);
    expect(chain.SPONSORED_CU_PRICE_MICRO_LAMPORTS).toBeLessThanOrEqual(SPONSOR_DEFAULT_MAX_PRICE);
    // Two signatures (sponsor + wallet) at 5,000 lamports, plus the priority fee rounded up.
    const fee = 2 * 5_000 + Math.ceil((chain.SPONSORED_MAX_COMPUTE_UNITS * chain.SPONSORED_CU_PRICE_MICRO_LAMPORTS) / 1_000_000);
    expect(fee).toBeLessThanOrEqual(SPONSOR_DEFAULT_MAX_FEE);
  });
});
