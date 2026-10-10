import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type GetTransactionApi,
  type Instruction,
  type Rpc,
  getAddressDecoder,
  type Signature,
} from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { findPlaintextAmount, isConfidentialTransferInstruction, spliceAfterTransfer, toKitInstruction } from "../src/rentpay.ts";
import { BLOCKHASH, buildTx } from "./txfixtures.ts";

const addr = (n: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(n));

const TOKEN = TOKEN_2022_PROGRAM_ADDRESS as Address;
const OTHER = addr(9);
const ix = (programAddress: Address, ...data: number[]): Instruction => ({ programAddress, data: new Uint8Array(data) });

describe("toKitInstruction", () => {
  const A = AccountRole;
  const key = (n: number) => addr(n) as string;

  it("maps all four signer/writable combinations", () => {
    const out = toKitInstruction({
      programId: key(5),
      keys: [
        { pubkey: key(1), isSigner: true, isWritable: true },
        { pubkey: key(2), isSigner: true, isWritable: false },
        { pubkey: key(3), isSigner: false, isWritable: true },
        { pubkey: key(4), isSigner: false, isWritable: false },
      ],
      data: new Uint8Array([1, 2, 3]),
    });
    assert.deepEqual(
      out.accounts!.map((a) => a.role),
      [A.WRITABLE_SIGNER, A.READONLY_SIGNER, A.WRITABLE, A.READONLY],
    );
  });

  it("keeps the program address and the account order", () => {
    const out = toKitInstruction({
      programId: key(5),
      keys: [3, 1, 2].map((n) => ({ pubkey: key(n), isSigner: false, isWritable: false })),
      data: new Uint8Array(),
    });
    assert.equal(out.programAddress, addr(5));
    assert.deepEqual(out.accounts!.map((a) => a.address), [addr(3), addr(1), addr(2)]);
  });

  it("accepts an instruction with no accounts", () => {
    assert.deepEqual(toKitInstruction({ programId: key(5), keys: [], data: new Uint8Array([7]) }).accounts, []);
  });

  // The Anchor side may reuse its buffer; an aliased array would let that rewrite a queued instruction.
  it("copies the data rather than aliasing it", () => {
    const data = new Uint8Array([1, 2, 3]);
    const out = toKitInstruction({ programId: key(5), keys: [], data });
    data[0] = 99;
    assert.deepEqual([...out.data!], [1, 2, 3]);
  });
});

describe("isConfidentialTransferInstruction", () => {
  it("accepts a Token-2022 instruction starting [27, 7]", () => {
    assert.equal(isConfidentialTransferInstruction(ix(TOKEN, 27, 7, 1, 2)), true);
  });

  it("rejects a different confidential-transfer sub-instruction", () => {
    assert.equal(isConfidentialTransferInstruction(ix(TOKEN, 27, 8)), false);
  });

  it("rejects data shorter than two bytes", () => {
    assert.equal(isConfidentialTransferInstruction(ix(TOKEN, 27)), false);
  });

  it("rejects [27, 7] on another program", () => {
    assert.equal(isConfidentialTransferInstruction(ix(OTHER, 27, 7)), false);
  });

  it("rejects empty and missing data", () => {
    assert.equal(isConfidentialTransferInstruction(ix(TOKEN)), false);
    assert.equal(isConfidentialTransferInstruction({ programAddress: TOKEN, data: undefined }), false);
  });
});

describe("spliceAfterTransfer", () => {
  type Planned = Parameters<typeof spliceAfterTransfer>[0][number];
  const feePayer = addr(7);
  const msg = (...instructions: Instruction[]) =>
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(BLOCKHASH, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ) as unknown as Planned;
  const tags = (m: Planned) => (m as unknown as { instructions: readonly Instruction[] }).instructions.map((i) => [...(i.data ?? [])].join(","));
  const transfer = () => ix(TOKEN, 27, 7, 1);
  const proof = ix(OTHER, 1);
  const closes = [ix(OTHER, 50), ix(OTHER, 51)];
  const rider = ix(OTHER, 99);

  // If the closes landed between the transfer and pay_rent, the program would not see the transfer
  // directly before it: MissingConfidentialTransfer on chain.
  it("puts the rider directly after the transfer and keeps the closes after the rider", () => {
    const [out] = spliceAfterTransfer([msg(proof, transfer(), ...closes)], [rider]);
    assert.deepEqual(tags(out!), ["1", "27,7,1", "99", "50", "51"]);
  });

  it("keeps the relative order of several riders", () => {
    const [out] = spliceAfterTransfer([msg(transfer(), closes[0]!)], [ix(OTHER, 98), rider]);
    assert.deepEqual(tags(out!), ["27,7,1", "98", "99", "50"]);
  });

  it("works when the transfer is the last instruction", () => {
    const [out] = spliceAfterTransfer([msg(proof, transfer())], [rider]);
    assert.deepEqual(tags(out!), ["1", "27,7,1", "99"]);
  });

  it("edits only the message that holds the transfer", () => {
    const out = spliceAfterTransfer([msg(proof), msg(transfer(), closes[0]!), msg(closes[1]!)], [rider]);
    assert.deepEqual(out.map(tags), [["1"], ["27,7,1", "99", "50"], ["51"]]);
  });

  it("takes the last message when more than one carries a transfer", () => {
    const out = spliceAfterTransfer([msg(transfer()), msg(proof, transfer())], [rider]);
    assert.deepEqual(out.map(tags), [["27,7,1"], ["1", "27,7,1", "99"]]);
  });

  it("does not mistake lookalike instructions for the transfer", () => {
    assert.throws(() => spliceAfterTransfer([msg(ix(TOKEN, 27, 8), ix(OTHER, 27, 7))], [rider]), /ConfidentialTransfer/);
  });

  it("throws when the plan has no transfer, including an empty plan", () => {
    assert.throws(() => spliceAfterTransfer([msg(proof), msg(...closes)], [rider]), /ConfidentialTransfer/);
    assert.throws(() => spliceAfterTransfer([], [rider]), /ConfidentialTransfer/);
  });

  // The rebuild starts from an empty instruction list; it must not shed what made the message sendable.
  it("keeps the fee payer, version and lifetime of the message it rebuilds", () => {
    const original = msg(proof, transfer()) as unknown as Record<string, unknown>;
    const [out] = spliceAfterTransfer([original as unknown as Planned], [rider]) as unknown as Record<string, unknown>[];
    assert.deepEqual(out!.feePayer, original.feePayer);
    assert.equal((out!.feePayer as { address: Address }).address, feePayer);
    assert.equal(out!.version, 0);
    assert.deepEqual(out!.lifetimeConstraint, BLOCKHASH);
  });
});

describe("findPlaintextAmount", () => {
  const AMOUNT = 2_000_000n;
  const u64 = (n: bigint) => [...new Uint8Array(new BigUint64Array([n]).buffer)];
  const rpcFor = (wire: string) =>
    ({ getTransaction: () => ({ send: async () => ({ transaction: [wire, "base64"] }) }) }) as unknown as Rpc<GetTransactionApi>;
  const SIG = "5".repeat(88) as Signature;

  async function wireWith(...instructions: Instruction[]) {
    return buildTx({ feePayer: (await generateKeyPairSigner()).address, instructions });
  }

  // A search that never matched would make the privacy gate pass for the wrong reason, so the
  // positive case is the one that proves the search can fail.
  it("finds the amount where a plain transfer_checked-style instruction carries it", async () => {
    const wire = await wireWith(ix(OTHER, 12, ...u64(AMOUNT), 6));
    const { hits, instructions } = await findPlaintextAmount(rpcFor(wire), SIG, AMOUNT);
    assert.equal(instructions, 1);
    assert.deepEqual(hits, [{ instructionIndex: 0, programAddress: OTHER, offset: 1 }]);
  });

  it("reports the instruction index of each hit, across instructions", async () => {
    const wire = await wireWith(ix(OTHER, 1), ix(OTHER, ...u64(AMOUNT)), ix(TOKEN, 3, 3, ...u64(AMOUNT)));
    const { hits } = await findPlaintextAmount(rpcFor(wire), SIG, AMOUNT);
    assert.deepEqual(hits.map((h) => [h.instructionIndex, h.offset]), [[1, 0], [2, 2]]);
  });

  it("finds nothing when the amount is absent from every instruction", async () => {
    const wire = await wireWith(ix(TOKEN, 27, 7, ...u64(AMOUNT + 1n)), ix(OTHER, 1, 2, 3));
    const { hits, instructions } = await findPlaintextAmount(rpcFor(wire), SIG, AMOUNT);
    assert.deepEqual(hits, []);
    assert.equal(instructions, 2);
  });

  it("does not match the big-endian spelling of the amount", async () => {
    const wire = await wireWith(ix(OTHER, ...u64(AMOUNT).reverse()));
    assert.deepEqual((await findPlaintextAmount(rpcFor(wire), SIG, AMOUNT)).hits, []);
  });

  it("throws when the transaction is not found", async () => {
    const rpc = { getTransaction: () => ({ send: async () => null }) } as unknown as Rpc<GetTransactionApi>;
    await assert.rejects(findPlaintextAmount(rpc, SIG, AMOUNT), /not found/);
  });
});
