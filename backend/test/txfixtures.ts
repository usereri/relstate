// Builds real wire transactions for the sponsor tests.
import {
  AccountRole,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";

export const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1n } as never;

export const TOKEN_PROGRAM = TOKEN_2022_PROGRAM_ADDRESS as Address;

/** An instruction against an allowlisted program that marks `signer` as a writable signer. */
export function ixSignedBy(signer: TransactionSigner, program: Address = TOKEN_PROGRAM, data = [1, 2, 3]): Instruction {
  return {
    programAddress: program,
    accounts: [{ address: signer.address, role: AccountRole.WRITABLE_SIGNER, signer }],
    data: new Uint8Array(data),
  } as unknown as Instruction;
}

/** An instruction that mentions `address` (not as a signer) with the given role. */
export function ixTouching(address: Address, role: AccountRole = AccountRole.WRITABLE, program: Address = TOKEN_PROGRAM): Instruction {
  return { programAddress: program, accounts: [{ address, role }], data: new Uint8Array([9]) } as Instruction;
}

/**
 * Builds a v0 transaction. `feePayer` is an *address*, which is what leaves its
 * signature slot null; any signer attached to an instruction account is signed.
 */
export async function buildTx(options: {
  feePayer: Address;
  instructions: Instruction[];
  version?: 0 | "legacy" | 1;
}): Promise<string> {
  const message = pipe(
    createTransactionMessage({ version: (options.version ?? 0) as 0 }),
    (m) => setTransactionMessageFeePayer(options.feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(BLOCKHASH, m),
    (m) => appendTransactionMessageInstructions(options.instructions, m),
  );
  const signed = await partiallySignTransactionMessageWithSigners(message);
  return getBase64EncodedWireTransaction(signed);
}

export async function twoKeys(): Promise<{ sponsor: KeyPairSigner; user: KeyPairSigner }> {
  return { sponsor: await generateKeyPairSigner(), user: await generateKeyPairSigner() };
}

/** Flips one byte of the `index`th 64-byte signature slot in a wire transaction. */
export function corruptSignature(txBase64: string, index: number): string {
  const bytes = new Uint8Array(getBase64Encoder().encode(txBase64));
  // Fewer than 128 signatures, so the signature count is a single byte.
  bytes[1 + index * 64 + 5] = (bytes[1 + index * 64 + 5] ?? 0) ^ 0xff;
  return Buffer.from(bytes).toString("base64");
}

/**
 * A hand-assembled legacy transaction in which the fee payer (account 0) is also
 * the program id of the only instruction. kit refuses to compile this, which is
 * exactly why it has to be written out by hand: the sponsor must still reject
 * it when a client sends one.
 */
export function wireWithFeePayerAsProgram(feePayer: Address): string {
  const key = new Uint8Array(getAddressEncoder().encode(feePayer));
  const bytes = new Uint8Array([
    1, ...new Uint8Array(64), // one empty signature slot
    1, 0, 0, // header: 1 signer, 0 readonly signers, 0 readonly non-signers
    1, ...key, // one static account
    ...new Uint8Array(32), // blockhash
    1, 0, 0, 1, 7, // one instruction: program index 0, no accounts, 1 data byte
  ]);
  return Buffer.from(bytes).toString("base64");
}
