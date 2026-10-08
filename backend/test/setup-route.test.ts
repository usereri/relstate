import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPairSigner, type Address, type Instruction } from "@solana/kit";
import { createRateLimiter } from "../src/limits.ts";
import { createTreasury, type TreasuryRpc } from "../src/treasury.ts";
import { COMPUTE_BUDGET_PROGRAM, RejectedTransaction } from "../src/txinspect.ts";
import { buildTx, ixSignedBy } from "./txfixtures.ts";

const MINT = "EBMibFLTvr5GDpgxNqt5Gqp9B1xLMr32aNwGDJV2oGJ6" as Address;
const RENT = 2_000_000n;

const u64 = (n: bigint) => Array.from(new Uint8Array(new BigUint64Array([n]).buffer));
const budgetIx = (data: number[]) => ({ programAddress: COMPUTE_BUDGET_PROGRAM as Address, data: new Uint8Array(data) }) as unknown as Instruction;
const cuLimit = (n: number) => budgetIx([2, n & 255, (n >> 8) & 255, (n >> 16) & 255, 0]);
const cuPrice = (n: bigint) => budgetIx([3, ...u64(n)]);

async function fixture(limiter = createRateLimiter({ maxPerWalletPerHour: 2, maxGlobalPerHour: 10, maxLamportsPerWalletPerDay: 10n ** 12n, maxLamportsGlobalPerDay: 10n ** 12n })) {
  const treasurySigner = await generateKeyPairSigner();
  const user = await generateKeyPairSigner();
  let sent = 0;
  let balance = 10n ** 9n;
  const rpc = {
    getBalance: () => ({ send: async () => ({ context: { slot: 1n }, value: balance }) }),
    simulateTransaction: () => ({
      send: async () => ({ context: { slot: 1n }, value: { err: null, accounts: [{ lamports: balance - RENT }] } }),
    }),
    sendTransaction: () => ({ send: async () => (sent++, "sig") }),
  } as unknown as TreasuryRpc;
  const treasury = createTreasury({
    rpc,
    run: (async () => []) as never,
    treasury: treasurySigner,
    mint: MINT,
    decimals: 6,
    mode: "live",
    maxRentLamports: 5_000_000n,
    setupLimiter: limiter,
  });
  const tx = (extra: Instruction[] = []) =>
    buildTx({ feePayer: treasurySigner.address, instructions: [...extra, ixSignedBy(user, undefined, [27, 2])] });
  return { treasury, user, tx, sent: () => sent };
}

const code = (c: string) => (e: unknown) => e instanceof RejectedTransaction && e.code === c;

describe("sponsorConfidentialAccountSetup: route-level guards", () => {
  it("co-signs and broadcasts a well-formed setup for its signer", async () => {
    const f = await fixture();
    const r = await f.treasury.sponsorConfidentialAccountSetup({ txBase64: await f.tx(), wallet: f.user.address });
    assert.equal(r.broadcast, true);
    assert.equal(r.rentLamports, RENT.toString());
    assert.equal(f.sent(), 1);
  });

  it("rejects a session wallet that did not sign the transaction", async () => {
    const f = await fixture();
    const other = await generateKeyPairSigner();
    await assert.rejects(f.treasury.sponsorConfidentialAccountSetup({ txBase64: await f.tx(), wallet: other.address }), code("wallet-mismatch"));
    assert.equal(f.sent(), 0);
  });

  it("rejects a session issued for the treasury's own address", async () => {
    const f = await fixture();
    await assert.rejects(f.treasury.sponsorConfidentialAccountSetup({ txBase64: await f.tx(), wallet: f.treasury.treasuryAddress }), code("wallet-mismatch"));
  });

  it("rejects a priority-fee price above the cap", async () => {
    const f = await fixture();
    const txBase64 = await f.tx([cuLimit(200_000), cuPrice(10_000_000n)]);
    await assert.rejects(f.treasury.sponsorConfidentialAccountSetup({ txBase64, wallet: f.user.address }), RejectedTransaction);
    assert.equal(f.sent(), 0);
  });

  it("rejects a compute-unit limit above the cap", async () => {
    const f = await fixture();
    // 1.4M compute units is far above the 400k unit cap, so the transaction cannot be sponsored.
    const txBase64 = await f.tx([cuLimit(1_400_000), cuPrice(10_000n)]);
    await assert.rejects(f.treasury.sponsorConfidentialAccountSetup({ txBase64, wallet: f.user.address }), RejectedTransaction);
    assert.equal(f.sent(), 0);
  });

  it("rate-limits a wallet after its hourly cap and reports rate-limited", async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i++) {
      await f.treasury.sponsorConfidentialAccountSetup({ txBase64: await f.tx(), wallet: f.user.address });
    }
    await assert.rejects(f.treasury.sponsorConfidentialAccountSetup({ txBase64: await f.tx(), wallet: f.user.address }), code("rate-limited"));
    assert.equal(f.sent(), 2);
  });

  it("does not spend budget on a rejected transaction", async () => {
    const limiter = createRateLimiter({ maxPerWalletPerHour: 1, maxGlobalPerHour: 10, maxLamportsPerWalletPerDay: 10n ** 12n, maxLamportsGlobalPerDay: 10n ** 12n });
    const f = await fixture(limiter);
    const other = await generateKeyPairSigner();
    await assert.rejects(f.treasury.sponsorConfidentialAccountSetup({ txBase64: await f.tx(), wallet: other.address }), code("wallet-mismatch"));
    await f.treasury.sponsorConfidentialAccountSetup({ txBase64: await f.tx(), wallet: f.user.address });
    assert.equal(f.sent(), 1);
  });

  it("enforces the global cap across different wallets", async () => {
    const limiter = createRateLimiter({ maxPerWalletPerHour: 5, maxGlobalPerHour: 1, maxLamportsPerWalletPerDay: 10n ** 12n, maxLamportsGlobalPerDay: 10n ** 12n });
    const f = await fixture(limiter);
    await f.treasury.sponsorConfidentialAccountSetup({ txBase64: await f.tx(), wallet: f.user.address });
    await assert.rejects(f.treasury.sponsorConfidentialAccountSetup({ txBase64: await f.tx(), wallet: f.user.address }), code("rate-limited"));
  });
});
