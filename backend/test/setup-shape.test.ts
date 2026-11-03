import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AccountRole, type Address, type Instruction } from "@solana/kit";
import { assertConfidentialSetupShape } from "../src/treasury.ts";
import { inspectTransaction, RejectedTransaction } from "../src/txinspect.ts";
import { buildTx, ixSignedBy, TOKEN_PROGRAM, twoKeys } from "./txfixtures.ts";

async function shape(data: number[], treasuryRole: "none" | "payer" | "authority") {
  const { sponsor: treasury, user } = await twoKeys();
  const accounts =
    treasuryRole === "authority"
      ? [{ address: treasury.address, role: AccountRole.WRITABLE }]
      : treasuryRole === "payer"
        ? [{ address: user.address, role: AccountRole.WRITABLE }, { address: treasury.address, role: AccountRole.WRITABLE }]
        : [{ address: user.address, role: AccountRole.WRITABLE }];
  const ix = { programAddress: TOKEN_PROGRAM as Address, accounts, data: new Uint8Array(data) } as unknown as Instruction;
  const txBase64 = await buildTx({ feePayer: treasury.address, instructions: [ix, ixSignedBy(user, "ComputeBudget111111111111111111111111111111" as Address, [2, 1, 0, 0, 0])] });
  const tx = inspectTransaction(txBase64, { maxBytes: 1232, maxInstructions: 16 });
  return () => assertConfidentialSetupShape(tx, treasury.address);
}

const rejects = (f: () => void) => assert.throws(f, (e) => e instanceof RejectedTransaction && e.code === "instruction-not-allowed");

describe("confidential setup instruction shape", () => {
  it("rejects MintTo (7), CloseAccount (9), FreezeAccount (10)", async () => {
    for (const tag of [7, 9, 10, 3]) rejects(await shape([tag, 0, 0, 0, 0, 0, 0, 0, 0], "none"));
  });
  it("rejects MintTo even when the treasury is the authority", async () => {
    rejects(await shape([7, 1, 0, 0, 0, 0, 0, 0, 0], "authority"));
  });
  it("rejects other confidential-transfer sub-instructions", async () => {
    rejects(await shape([27, 0], "none"));
  });
  it("allows ConfigureAccount and Reallocate with the treasury as payer", async () => {
    (await shape([27, 2], "none"))();
    (await shape([29, 1, 0], "payer"))();
  });
  it("rejects the treasury in a ConfigureAccount", async () => {
    rejects(await shape([27, 2], "authority"));
  });
});
