import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AccountRole, generateKeyPairSigner, type Address } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  COMPUTE_BUDGET_PROGRAM,
  RejectedTransaction,
  assertComputeBudgetWithinPolicy,
  assertOnlySponsorSignatureMissing,
  assertPresentSignaturesValid,
  assertProgramsAllowed,
  assertSponsorNotUsedByInstructions,
  inspectTransaction,
  readComputeBudget,
  worstCaseFeeLamports,
  type SponsorPolicy,
} from "../src/txinspect.ts";
import { TOKEN_PROGRAM, buildTx, wireWithFeePayerAsProgram, corruptSignature, ixSignedBy, ixTouching, twoKeys } from "./txfixtures.ts";

function codeOf(fn: () => unknown): Promise<string | undefined> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => undefined,
      (e: unknown) => {
        assert.ok(e instanceof RejectedTransaction, `expected RejectedTransaction, got ${String(e)}`);
        return e.code;
      },
    );
}

const computeLimit = (units: number) => ({
  programAddress: COMPUTE_BUDGET_PROGRAM,
  data: new Uint8Array([2, units & 255, (units >> 8) & 255, (units >> 16) & 255, (units >> 24) & 255]),
});
const computePrice = (microLamports: bigint) => {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, data };
};

const policy: SponsorPolicy = {
  allowlist: [TOKEN_PROGRAM],
  maxComputeUnits: 400_000,
  maxCuPriceMicroLamports: 10_000n,
  maxFeeLamports: 200_000n,
};

describe("inspectTransaction: shape", () => {
  it("decodes a well-formed transaction", async () => {
    const { sponsor, user } = await twoKeys();
    const tx = inspectTransaction(await buildTx({ feePayer: sponsor.address, instructions: [ixSignedBy(user)] }));
    assert.equal(tx.feePayer, sponsor.address);
    assert.equal(tx.numRequiredSignatures, 2);
    assert.deepEqual(tx.missingSigners, [sponsor.address]);
    assert.equal(tx.instructions.length, 1);
    assert.equal(tx.instructions[0]?.programAddress, TOKEN_PROGRAM);
  });

  it("rejects non-base64 input", async () => {
    assert.equal(await codeOf(() => inspectTransaction("!!! not base64 !!!")), "malformed");
  });

  it("rejects an empty payload", async () => {
    assert.equal(await codeOf(() => inspectTransaction("")), "malformed");
  });

  it("rejects bytes that are not a transaction", async () => {
    assert.equal(await codeOf(() => inspectTransaction(Buffer.from([1, 2, 3, 4]).toString("base64"))), "malformed");
  });

  it("rejects an oversize transaction", async () => {
    const { sponsor, user } = await twoKeys();
    const b64 = await buildTx({ feePayer: sponsor.address, instructions: [ixSignedBy(user)] });
    assert.equal(await codeOf(() => inspectTransaction(b64, { maxBytes: 100 })), "too-large");
  });

  it("rejects too many instructions", async () => {
    const { sponsor, user } = await twoKeys();
    const ixs = Array.from({ length: 4 }, (_, i) => ixSignedBy(user, TOKEN_PROGRAM, [i]));
    const b64 = await buildTx({ feePayer: sponsor.address, instructions: ixs });
    assert.equal(await codeOf(() => inspectTransaction(b64, { maxInstructions: 3 })), "too-many-instructions");
    assert.doesNotThrow(() => inspectTransaction(b64, { maxInstructions: 4 }));
  });

  it("rejects a transaction with no instructions", async () => {
    const { sponsor } = await twoKeys();
    const b64 = await buildTx({ feePayer: sponsor.address, instructions: [] });
    assert.equal(await codeOf(() => inspectTransaction(b64)), "empty");
  });

  it("rejects a version 1 message", async () => {
    const { sponsor, user } = await twoKeys();
    let b64: string;
    try {
      b64 = await buildTx({ feePayer: sponsor.address, instructions: [ixSignedBy(user)], version: 1 });
    } catch (e) {
      // kit may refuse to compile/encode v1 here; that would make this case untestable offline.
      assert.fail(`could not build a v1 transaction with kit: ${String(e)}`);
    }
    assert.equal(await codeOf(() => inspectTransaction(b64)), "unsupported-version");
  });
});

describe("assertProgramsAllowed", () => {
  it("accepts allowlisted programs and ComputeBudget", async () => {
    const { sponsor, user } = await twoKeys();
    const tx = inspectTransaction(await buildTx({ feePayer: sponsor.address, instructions: [computeLimit(1000), ixSignedBy(user)] }));
    assert.doesNotThrow(() => assertProgramsAllowed(tx, [TOKEN_PROGRAM]));
  });

  it("rejects a program that is not on the allowlist", async () => {
    const { sponsor, user } = await twoKeys();
    const other = (await generateKeyPairSigner()).address;
    const tx = inspectTransaction(await buildTx({ feePayer: sponsor.address, instructions: [ixSignedBy(user, other)] }));
    assert.equal(await codeOf(() => assertProgramsAllowed(tx, [TOKEN_PROGRAM])), "program-not-allowed");
  });
});

describe("assertSponsorNotUsedByInstructions (the central invariant)", () => {
  it("accepts a transaction where the sponsor is only the fee payer", async () => {
    const { sponsor, user } = await twoKeys();
    const tx = inspectTransaction(await buildTx({ feePayer: sponsor.address, instructions: [ixSignedBy(user)] }));
    assert.doesNotThrow(() => assertSponsorNotUsedByInstructions(tx, sponsor.address));
  });

  it("rejects the fee payer as a writable account", async () => {
    const { sponsor, user } = await twoKeys();
    const tx = inspectTransaction(
      await buildTx({ feePayer: sponsor.address, instructions: [ixSignedBy(user), ixTouching(sponsor.address, AccountRole.WRITABLE)] }),
    );
    assert.equal(await codeOf(() => assertSponsorNotUsedByInstructions(tx, sponsor.address)), "sponsor-in-instruction");
  });

  it("rejects the fee payer as a readonly account", async () => {
    const { sponsor, user } = await twoKeys();
    const tx = inspectTransaction(
      await buildTx({ feePayer: sponsor.address, instructions: [ixSignedBy(user), ixTouching(sponsor.address, AccountRole.READONLY)] }),
    );
    assert.equal(await codeOf(() => assertSponsorNotUsedByInstructions(tx, sponsor.address)), "sponsor-in-instruction");
  });

  it("rejects a System transfer whose destination is the fee payer", async () => {
    const { sponsor, user } = await twoKeys();
    const tx = inspectTransaction(
      await buildTx({
        feePayer: sponsor.address,
        instructions: [getTransferSolInstruction({ source: user, destination: sponsor.address, amount: 1n })],
      }),
    );
    assert.equal(await codeOf(() => assertSponsorNotUsedByInstructions(tx, sponsor.address)), "sponsor-in-instruction");
  });

  it("rejects a System transfer that would pull from the fee payer", async () => {
    const { sponsor, user } = await twoKeys();
    const tx = inspectTransaction(
      await buildTx({
        feePayer: sponsor.address,
        instructions: [
          ixSignedBy(user),
          { programAddress: "11111111111111111111111111111111" as Address, accounts: [
            { address: sponsor.address, role: AccountRole.WRITABLE_SIGNER },
            { address: user.address, role: AccountRole.WRITABLE },
          ], data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) },
        ],
      }),
    );
    assert.equal(await codeOf(() => assertSponsorNotUsedByInstructions(tx, sponsor.address)), "sponsor-in-instruction");
  });

  it("rejects the fee payer named as an instruction's program", async () => {
    const { sponsor } = await twoKeys();
    const tx = inspectTransaction(wireWithFeePayerAsProgram(sponsor.address));
    assert.equal(await codeOf(() => assertSponsorNotUsedByInstructions(tx, sponsor.address)), "sponsor-as-program");
  });
});

describe("signature checks", () => {
  it("accepts a transaction whose only empty slot is the sponsor's", async () => {
    const { sponsor, user } = await twoKeys();
    const tx = inspectTransaction(await buildTx({ feePayer: sponsor.address, instructions: [ixSignedBy(user)] }));
    assert.doesNotThrow(() => assertOnlySponsorSignatureMissing(tx, sponsor.address));
    await assertPresentSignaturesValid(tx);
  });

  it("rejects a different fee payer", async () => {
    const { sponsor, user } = await twoKeys();
    const tx = inspectTransaction(await buildTx({ feePayer: user.address, instructions: [ixSignedBy(user)] }));
    assert.equal(await codeOf(() => assertOnlySponsorSignatureMissing(tx, sponsor.address)), "wrong-fee-payer");
  });

  it("rejects when another signer has not signed", async () => {
    const { sponsor, user } = await twoKeys();
    // Only an address is given for the user's account, so no signer signs it.
    const unsigned = { programAddress: TOKEN_PROGRAM, accounts: [{ address: user.address, role: AccountRole.WRITABLE_SIGNER }], data: new Uint8Array([1]) };
    const tx = inspectTransaction(await buildTx({ feePayer: sponsor.address, instructions: [unsigned] }));
    assert.equal(await codeOf(() => assertOnlySponsorSignatureMissing(tx, sponsor.address)), "incomplete-signatures");
  });

  it("rejects when the fee payer slot is already filled", async () => {
    const { sponsor, user } = await twoKeys();
    // A signer as fee payer fills its own slot; here the "sponsor" is the one that already signed.
    const tx = inspectTransaction(await buildTx({ feePayer: sponsor.address, instructions: [ixSignedBy(sponsor), ixSignedBy(user)] }));
    assert.equal(tx.missingSigners.length, 0, "fixture: both slots filled");
    assert.equal(await codeOf(() => assertOnlySponsorSignatureMissing(tx, sponsor.address)), "already-signed");
  });

  it("rejects a tampered signature from another signer", async () => {
    const { sponsor, user } = await twoKeys();
    const good = await buildTx({ feePayer: sponsor.address, instructions: [ixSignedBy(user)] });
    // Slot 0 is the (empty) fee payer; slot 1 is the user.
    const tx = inspectTransaction(corruptSignature(good, 1));
    assert.doesNotThrow(() => assertOnlySponsorSignatureMissing(tx, sponsor.address));
    assert.equal(await codeOf(() => assertPresentSignaturesValid(tx)), "bad-signature");
  });

  it("rejects a signature that was made over a different message", async () => {
    const { sponsor, user } = await twoKeys();
    const a = inspectTransaction(await buildTx({ feePayer: sponsor.address, instructions: [ixSignedBy(user, TOKEN_PROGRAM, [1])] }));
    const b = inspectTransaction(await buildTx({ feePayer: sponsor.address, instructions: [ixSignedBy(user, TOKEN_PROGRAM, [2])] }));
    const spliced = { ...a, transaction: { ...a.transaction, signatures: b.transaction.signatures } };
    assert.equal(await codeOf(() => assertPresentSignaturesValid(spliced)), "bad-signature");
  });
});

describe("compute budget", () => {
  const build = async (extra: unknown[], count = 1) => {
    const { sponsor, user } = await twoKeys();
    const ixs = [...(extra as never[]), ...Array.from({ length: count }, (_, i) => ixSignedBy(user, TOKEN_PROGRAM, [i]))];
    return inspectTransaction(await buildTx({ feePayer: sponsor.address, instructions: ixs }));
  };

  it("reads limit and price", async () => {
    const tx = await build([computeLimit(300_000), computePrice(5_000n)]);
    assert.deepEqual(readComputeBudget(tx), { unitLimit: 300_000n, unitPriceMicroLamports: 5_000n });
  });

  it("rejects a truncated SetComputeUnitLimit instead of ignoring it", async () => {
    const tx = await build([{ programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array([2, 1, 0]) }]);
    assert.equal(await codeOf(() => readComputeBudget(tx)), "malformed-compute-budget");
    assert.equal(await codeOf(() => assertComputeBudgetWithinPolicy(tx, policy)), "malformed-compute-budget");
  });

  it("rejects a truncated SetComputeUnitPrice instead of ignoring it", async () => {
    const tx = await build([{ programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array([3, 1, 0, 0, 0]) }]);
    assert.equal(await codeOf(() => readComputeBudget(tx)), "malformed-compute-budget");
    assert.equal(await codeOf(() => worstCaseFeeLamports(tx)), "malformed-compute-budget");
  });

  it("rejects a unit limit above the cap", async () => {
    const tx = await build([computeLimit(400_001)]);
    assert.equal(await codeOf(() => assertComputeBudgetWithinPolicy(tx, policy)), "compute-limit");
  });

  it("accepts a unit limit exactly at the cap", async () => {
    const tx = await build([computeLimit(400_000)]);
    assert.doesNotThrow(() => assertComputeBudgetWithinPolicy(tx, policy));
  });

  it("rejects a priority-fee price above the cap", async () => {
    const tx = await build([computePrice(10_001n)]);
    assert.equal(await codeOf(() => assertComputeBudgetWithinPolicy(tx, policy)), "compute-price");
  });

  it("rejects a worst-case fee above the fee cap", async () => {
    const tx = await build([computeLimit(400_000), computePrice(10_000n)]);
    // 5000*2 + ceil(400000*10000/1e6) = 10_000 + 4_000
    assert.equal(worstCaseFeeLamports(tx), 14_000n);
    assert.equal(await codeOf(() => assertComputeBudgetWithinPolicy(tx, { ...policy, maxFeeLamports: 13_999n })), "fee-too-high");
    assert.equal(assertComputeBudgetWithinPolicy(tx, policy), 14_000n);
  });

  it("worstCaseFeeLamports: base fee only without a price", async () => {
    assert.equal(worstCaseFeeLamports(await build([])), 10_000n); // two signatures
  });

  it("worstCaseFeeLamports: rounds the priority fee up", async () => {
    // 1 unit at 1 micro-lamport is a fraction of a lamport; it still costs one.
    const tx = await build([computeLimit(1), computePrice(1n)]);
    assert.equal(worstCaseFeeLamports(tx), 10_001n);
  });

  it("worstCaseFeeLamports: assumes the runtime default per instruction when no limit is set", async () => {
    // 3 instructions (price + 2 token) => 600_000 units * 1_000 micro = 600 lamports
    const tx = await build([computePrice(1_000n)], 2);
    assert.equal(tx.instructions.length, 3);
    assert.equal(worstCaseFeeLamports(tx), 10_000n + 600n);
  });

  it("worstCaseFeeLamports: default units are clamped to 1.4M", async () => {
    const tx = await build([computePrice(1_000_000n)], 9); // 10 ix * 200k = 2M -> clamp 1.4M
    assert.equal(worstCaseFeeLamports(tx), 10_000n + 1_400_000n);
  });
});
