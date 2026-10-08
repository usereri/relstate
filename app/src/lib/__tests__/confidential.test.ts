import { describe, expect, it } from "vitest";
import * as kit from "@solana/kit";
import { fromWeb3Instruction, spliceAfterTransfer, TOKEN_2022_PROGRAM, type PlannedMessage } from "../confidential";

// spliceAfterTransfer only touches `kit`; passing the real kit keeps the zk-sdk wasm unloaded.
const libs = { kit } as unknown as Parameters<typeof spliceAfterTransfer>[2];

const addr = (n: number) => kit.address(kit.getAddressDecoder().decode(new Uint8Array(32).fill(n)));
const OTHER = addr(9);
const ix = (programAddress: kit.Address, ...data: number[]): kit.Instruction => ({ programAddress, data: new Uint8Array(data) });
const transfer = () => ix(TOKEN_2022_PROGRAM as kit.Address, 27, 7, 1);
const msg = (...instructions: kit.Instruction[]) =>
  kit.pipe(kit.createTransactionMessage({ version: 0 }), (m) => kit.appendTransactionMessageInstructions(instructions, m)) as unknown as PlannedMessage;
const tags = (m: PlannedMessage) => (m.instructions as readonly kit.Instruction[]).map((i) => [...(i.data ?? [])].join(","));

describe("spliceAfterTransfer", () => {
  const proof = ix(OTHER, 1);
  const close = [ix(OTHER, 50), ix(OTHER, 51), ix(OTHER, 52)];
  const payRent = ix(OTHER, 99);

  it("puts the extra instructions directly after the transfer and keeps the closes after them", () => {
    const [out] = spliceAfterTransfer([msg(proof, transfer(), ...close)], [payRent], libs);
    expect(tags(out)).toEqual(["1", "27,7,1", "99", "50", "51", "52"]);
  });

  it("keeps order of several extras", () => {
    const [out] = spliceAfterTransfer([msg(transfer(), close[0])], [ix(OTHER, 98), payRent], libs);
    expect(tags(out)).toEqual(["27,7,1", "98", "99", "50"]);
  });

  it("works when the transfer is the last instruction", () => {
    const [out] = spliceAfterTransfer([msg(proof, transfer())], [payRent], libs);
    expect(tags(out)).toEqual(["1", "27,7,1", "99"]);
  });

  it("edits only the message that holds the transfer", () => {
    const first = msg(proof);
    const out = spliceAfterTransfer([first, msg(transfer(), close[0])], [payRent], libs);
    expect(tags(out[0])).toEqual(["1"]);
    expect(tags(out[1])).toEqual(["27,7,1", "99", "50"]);
  });

  it("does not mistake other Token-2022 instructions or other programs for the transfer", () => {
    const notTransfer = [ix(TOKEN_2022_PROGRAM as kit.Address, 27, 8), ix(OTHER, 27, 7)];
    expect(() => spliceAfterTransfer([msg(...notTransfer)], [payRent], libs)).toThrow(/No ConfidentialTransfer/);
  });

  it("throws rather than guessing when there is no transfer", () => {
    expect(() => spliceAfterTransfer([msg(proof), msg(...close)], [payRent], libs)).toThrow(/No ConfidentialTransfer/);
    expect(() => spliceAfterTransfer([], [payRent], libs)).toThrow(/No ConfidentialTransfer/);
  });
});

describe("fromWeb3Instruction", () => {
  const key = (n: number) => ({ toBase58: () => addr(n) as string });
  const A = kit.AccountRole;

  it("maps all four signer/writable combinations", async () => {
    const out = await fromWeb3Instruction({
      programId: key(5),
      keys: [
        { pubkey: key(1), isSigner: true, isWritable: true },
        { pubkey: key(2), isSigner: true, isWritable: false },
        { pubkey: key(3), isSigner: false, isWritable: true },
        { pubkey: key(4), isSigner: false, isWritable: false },
      ],
      data: new Uint8Array([1, 2, 3]),
    });
    expect(out.accounts!.map((a) => a.role)).toEqual([A.WRITABLE_SIGNER, A.READONLY_SIGNER, A.WRITABLE, A.READONLY]);
    expect(out.accounts!.map((a) => a.address)).toEqual([addr(1), addr(2), addr(3), addr(4)]);
  });

  it("round-trips programAddress and data, copying the buffer", async () => {
    const data = new Uint8Array([9, 8, 7]);
    const out = await fromWeb3Instruction({ programId: key(5), keys: [], data });
    expect(out.programAddress).toBe(addr(5));
    expect([...out.data!]).toEqual([9, 8, 7]);
    data[0] = 0;
    expect(out.data![0]).toBe(9);
  });
});
