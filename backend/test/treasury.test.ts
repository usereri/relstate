import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AccountState, TOKEN_2022_PROGRAM_ADDRESS, getMintEncoder, getTokenEncoder } from "@solana-program/token-2022";
import { generateKeyPairSigner, none, some, type Address } from "@solana/kit";
import { associatedTokenAddress } from "../src/confidential.ts";
import { InvariantViolation, confidentialMoveAmount, createTreasury, type TreasuryRpc } from "../src/treasury.ts";

describe("confidentialMoveAmount", () => {
  it("moves everything with no holdback", () => assert.equal(confidentialMoveAmount(1000n, 0n), 1000n));
  it("keeps the holdback public", () => assert.equal(confidentialMoveAmount(1000n, 300n), 700n));
  it("moves nothing when the holdback equals the total", () => assert.equal(confidentialMoveAmount(1000n, 1000n), 0n));
  it("throws when the holdback exceeds the total", () => assert.throws(() => confidentialMoveAmount(1000n, 1001n), /exceeds/));
  it("throws on a negative holdback", () => assert.throws(() => confidentialMoveAmount(1000n, -1n), /negative/));
});

describe("treasury (mock mode) against a fake RPC", () => {
  const MINT = "EBMibFLTvr5GDpgxNqt5Gqp9B1xLMr32aNwGDJV2oGJ6" as Address;

  async function fixture(supply: bigint) {
    const treasurySigner = await generateKeyPairSigner();
    const owner = await generateKeyPairSigner();
    const token = await associatedTokenAddress(owner.address, MINT);
    const accounts = new Map<string, Uint8Array>([
      [
        MINT,
        new Uint8Array(
          getMintEncoder().encode({
            mintAuthority: some(treasurySigner.address),
            supply,
            decimals: 6,
            isInitialized: true,
            freezeAuthority: none(),
            extensions: none(),
          }),
        ),
      ],
      [
        token,
        new Uint8Array(
          getTokenEncoder().encode({
            mint: MINT,
            owner: owner.address,
            amount: supply,
            delegate: none(),
            state: AccountState.Initialized,
            isNative: none(),
            delegatedAmount: 0n,
            closeAuthority: none(),
            extensions: none(),
          }),
        ),
      ],
    ]);
    const rpc = {
      getAccountInfo: (address: string) => ({
        send: async () => {
          const data = accounts.get(address);
          return {
            context: { slot: 1n },
            value:
              data === undefined
                ? null
                : { data: [Buffer.from(data).toString("base64"), "base64"], executable: false, lamports: 1n, owner: TOKEN_2022_PROGRAM_ADDRESS, space: BigInt(data.length) },
          };
        },
      }),
    } as unknown as TreasuryRpc;
    const runs: string[] = [];
    const run = async (_payer: unknown, _plan: unknown, label: string) => {
      runs.push(label);
      return [] as never[];
    };
    const treasury = createTreasury({ rpc, run: run as never, treasury: treasurySigner, mint: MINT, decimals: 6, mode: "mock" });
    return { treasury, owner, runs };
  }

  it("seeds the mock reserve from the mint's existing supply: zero headroom, ok", async () => {
    const { treasury } = await fixture(1_000n);
    const report = await treasury.invariant();
    assert.equal(report.supply, 1_000n);
    assert.equal(report.reserve, 1_000n);
    assert.equal(report.headroom, 0n);
    assert.equal(report.ok, true);
  });

  it("a wrap still needs a fresh credit even though the reserve was seeded", async () => {
    const { treasury, owner, runs } = await fixture(1_000n);
    await assert.rejects(treasury.wrap({ wallet: owner.address, amount: 1n }), InvariantViolation);
    assert.deepEqual(runs, [], "nothing was minted");
  });

  it("a credit made before the first read is not lost to seeding", async () => {
    const { treasury } = await fixture(1_000n);
    treasury.creditReserve(500n);
    const report = await treasury.invariant();
    assert.equal(report.reserve, 1_500n);
    assert.equal(report.headroom, 500n);
  });

  it("unwrap refuses before burning when the reserve cannot pay out", async () => {
    const { treasury, owner, runs } = await fixture(1_000n);
    await assert.rejects(treasury.unwrap({ owner, amount: 1_001n }), /exceeds the reserve/);
    assert.deepEqual(runs, [], "no burn was attempted");
    assert.equal((await treasury.invariant()).supply, 1_000n);
    assert.deepEqual(treasury.ledger(), [], "and nothing was recorded");
  });

  it("unwrap within the reserve burns and releases", async () => {
    const { treasury, owner, runs } = await fixture(1_000n);
    await treasury.unwrap({ owner, amount: 400n });
    assert.equal(runs.length, 1);
    assert.equal((await treasury.reserve()), 600n);
  });
});
