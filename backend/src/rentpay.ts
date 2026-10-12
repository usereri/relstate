// Paying rent confidentially from Node: the transfer, with `pay_rent` riding immediately behind it.
//
// This is the backend/script counterpart of the app's `planTransfer({ rightAfterTransfer })`. It
// exists as a module rather than inline in `scripts/exit-gate.ts` for one practical reason: the
// confidential stack is `@solana/kit` + `@solana-program/token-2022` + the `@solana/zk-sdk` **wasm**,
// and `scripts/` resolves its dependencies from the repo root while `backend/` has its own copy.
// Two copies of the wasm cannot exchange ElGamal objects, so every confidential operation in a
// script has to run on this side of the boundary. The script passes plain strings and bytes in.
//
// The position rule is the whole point. `pay_rent` finds the transfer by looking at the instruction
// directly before itself — not by searching the transaction — so a rider appended at the end of the
// plan, where the planner puts the context-state closes, fails as `MissingConfidentialTransfer`
// (docs/contracts/program-interface.md §3).
import {
  AccountRole,
  createTransactionMessage,
  createTransactionPlanner,
  appendTransactionMessageInstructions,
  createNoopSigner,
  partiallySignTransactionMessageWithSigners,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type GetTransactionApi,
  type Instruction,
  type Rpc,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import {
  CONFIDENTIAL_TRANSFER_CONFIDENTIAL_TRANSFER_DISCRIMINATOR,
  CONFIDENTIAL_TRANSFER_DISCRIMINATOR,
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchToken,
  type Mint,
} from "@solana-program/token-2022";
import { getConfidentialTransferInstructionPlan } from "@solana-program/token-2022/confidential";
import type { ConfidentialRpc } from "./confidential.ts";
import type { ConfidentialKeyPair } from "./keys.ts";
import { sendAndConfirmByPolling, type SolanaClient } from "./rpc.ts";
import { inspectTransaction } from "./txinspect.ts";

/**
 * An instruction built by the web3.js/Anchor side, in the only vocabulary both stacks share:
 * base58 strings and bytes. Converted to a kit instruction by {@link toKitInstruction}.
 */
export type ForeignInstruction = {
  programId: string;
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: Uint8Array;
};

/**
 * `signers` attaches a signer object to the matching signer accounts. Without it a rider such as
 * `pay_rent` names the tenant as a signer but nothing can produce the signature, and
 * `signTransactionMessageWithSigners` leaves the slot empty.
 */
export function toKitInstruction(ix: ForeignInstruction, signers: readonly TransactionSigner[] = []): Instruction {
  return {
    programAddress: ix.programId as Address,
    accounts: ix.keys.map((k) => {
      const role = k.isSigner
        ? k.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : k.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY;
      const signer = k.isSigner ? signers.find((x) => x.address === k.pubkey) : undefined;
      return signer ? { address: k.pubkey as Address, role, signer } : { address: k.pubkey as Address, role };
    }),
    data: new Uint8Array(ix.data),
  };
}

export const isConfidentialTransferInstruction = (ix: {
  programAddress: string;
  data?: ArrayLike<number> | undefined;
}): boolean =>
  ix.programAddress === TOKEN_2022_PROGRAM_ADDRESS &&
  ix.data !== undefined &&
  ix.data.length >= 2 &&
  ix.data[0] === CONFIDENTIAL_TRANSFER_DISCRIMINATOR &&
  ix.data[1] === CONFIDENTIAL_TRANSFER_CONFIDENTIAL_TRANSFER_DISCRIMINATOR;

type PlannedMessage = Parameters<typeof signTransactionMessageWithSigners>[0];
/** The planner's messages carry a readonly instruction list; this is that list, narrowed once. */
type WithInstructions = { instructions: readonly Instruction[] };

/** Walks a transaction plan in execution order. Running it sequentially is always safe. */
const flatten = (plan: { kind: string; message?: unknown; plans?: unknown[] }): PlannedMessage[] =>
  plan.kind === "single" ? [plan.message as PlannedMessage] : (plan.plans as (typeof plan)[]).flatMap(flatten);

/**
 * Puts `rider` directly after the `ConfidentialTransfer` instruction in a planned message list.
 *
 * Throws rather than guessing when the plan carries no transfer: a silently wrong position is only
 * visible on chain, as a `MissingConfidentialTransfer` several transactions later.
 */
export function spliceAfterTransfer(messages: PlannedMessage[], rider: Instruction[]): PlannedMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const instructions = (messages[i] as unknown as WithInstructions).instructions;
    const at = instructions.findIndex((ix) => isConfidentialTransferInstruction(ix));
    if (at < 0) continue;
    const reordered = [...instructions.slice(0, at + 1), ...rider, ...instructions.slice(at + 1)];
    // `appendTransactionMessageInstructions` only adds, so the list is rebuilt from empty.
    messages[i] = appendTransactionMessageInstructions(reordered, {
      ...(messages[i] as object),
      instructions: [],
    } as unknown as PlannedMessage) as PlannedMessage;
    return messages;
  }
  throw new Error("the transfer plan carries no ConfidentialTransfer instruction, so pay_rent has nothing to sit behind");
}

export type SentPlan = {
  signatures: Signature[];
  /** The one carrying the transfer and the rider — the transaction a receipt should link to. */
  transferSignature: Signature;
  /** Per transaction: how many instructions and how many wire bytes, for the sponsor's caps. */
  shape: { instructions: number; bytes: number }[];
};

export type RentPaymentOptions = {
  client: SolanaClient;
  payer: TransactionSigner;
  authority: TransactionSigner;
  sourceToken: Address;
  destinationToken: Address;
  mint: Address;
  mintAccount: Mint;
  amount: bigint;
  sourceKeys: ConfidentialKeyPair;
  rider: ForeignInstruction[];
  log?: (...args: unknown[]) => void;
};

/**
 * Builds the transfer plan and splices `rider` in directly behind the transfer, without sending
 * anything. Separate from {@link payRentConfidentially} so a caller can measure and inspect the
 * transactions first: the exit-gate script does, to check each one against the sponsor's policy.
 */
export async function planRentPayment(options: RentPaymentOptions): Promise<{ messages: PlannedMessage[]; carriesTransfer: number }> {
  const rpc = options.client.rpc as unknown as ConfidentialRpc;
  const [source, destination] = await Promise.all([
    fetchToken(rpc, options.sourceToken),
    fetchToken(rpc, options.destinationToken),
  ]);

  const planner = createTransactionPlanner({
    createTransactionMessage: () =>
      pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(options.payer, m)),
  });
  const planned = await planner(
    await getConfidentialTransferInstructionPlan({
      payer: options.payer,
      rpc,
      sourceToken: options.sourceToken,
      destinationToken: options.destinationToken,
      mint: options.mint,
      mintAccount: options.mintAccount,
      authority: options.authority,
      amount: options.amount,
      sourceTokenAccount: source.data,
      destinationTokenAccount: destination.data,
      sourceElgamalKeypair: options.sourceKeys.elgamal,
      aesKey: options.sourceKeys.ae,
    }),
  );

  // The tenant signs both the transfer and pay_rent, so the rider is handed the authority signer.
  const messages = spliceAfterTransfer(
    flatten(planned),
    options.rider.map((ix) => toKitInstruction(ix, [options.authority])),
  );
  const carriesTransfer = messages.findIndex((m) =>
    (m as unknown as WithInstructions).instructions.some((ix) => isConfidentialTransferInstruction(ix)),
  );
  return { messages, carriesTransfer };
}

/** A signer that signs nothing, standing in for a key the backend holds (the sponsor, the treasury). */
export const noopSigner = (address: Address): TransactionSigner => createNoopSigner(address);

/**
 * What a wallet posts to a co-signing route: signed by every signer it has (the tenant, the
 * ephemeral context-state keys), with the payer's slot left empty for the backend to fill.
 */
export async function partiallySignPlanned(client: SolanaClient, message: PlannedMessage) {
  const { value: blockhash } = await client.rpc.getLatestBlockhash().send();
  const transaction = await partiallySignTransactionMessageWithSigners(setTransactionMessageLifetimeUsingBlockhash(blockhash, message));
  const wire = getBase64EncodedWireTransaction(transaction);
  return { wire, blockhash, bytes: Buffer.from(wire, "base64").length };
}

/** Signs a planned message under a fresh blockhash and returns it with its wire size. */
export async function signPlanned(client: SolanaClient, message: PlannedMessage) {
  const { value: blockhash } = await client.rpc.getLatestBlockhash().send();
  const transaction = await signTransactionMessageWithSigners(setTransactionMessageLifetimeUsingBlockhash(blockhash, message));
  assertIsSendableTransaction(transaction);
  assertIsTransactionWithBlockhashLifetime(transaction);
  const wire = getBase64EncodedWireTransaction(transaction);
  return { transaction, blockhash, wire, bytes: Buffer.from(wire, "base64").length };
}

/**
 * Plans, then sends every transaction in order under one fee payer.
 *
 * Strictly sequential and deliberately polled rather than confirmed over a websocket: the public
 * devnet endpoint drops that socket partway through a proof plan and takes the rest of the plan
 * with it, which is how Phase 0 found this (`rpc.ts`, `sendAndConfirmByPolling`).
 */
export async function payRentConfidentially(options: RentPaymentOptions): Promise<SentPlan> {
  const log = options.log ?? (() => {});
  const { messages, carriesTransfer } = await planRentPayment(options);
  const signatures: Signature[] = [];
  const shape: SentPlan["shape"] = [];
  for (const [index, message] of messages.entries()) {
    const { transaction, blockhash, bytes } = await signPlanned(options.client, message);
    const instructions = (message as unknown as WithInstructions).instructions.length;
    shape.push({ instructions, bytes });
    log(`   tx ${index + 1}/${messages.length}: ${instructions} instructions, ${bytes} bytes`);
    signatures.push(await sendAndConfirmByPolling(options.client, transaction, { blockhash: blockhash.blockhash }));
    log(`   ${signatures[signatures.length - 1]}`);
  }
  return { signatures, transferSignature: signatures[carriesTransfer]!, shape };
}

export type PlaintextHit = { instructionIndex: number; programAddress: Address; offset: number };

/**
 * Looks for `amount` as a little-endian u64 anywhere in a confirmed transaction's instruction data.
 *
 * This is the assertion the privacy claim rests on, phrased so that it cannot pass for the wrong
 * reason: rather than trusting that the instruction we built was confidential, it re-reads what the
 * chain actually stored and shows that the figure is not in it. A classic `transfer_checked` would
 * carry the amount in eight bytes right there; a confidential transfer carries only ciphertexts.
 *
 * A 64-bit value matching encrypted bytes by chance is a 1-in-2^64 event per offset, so a hit means
 * the amount really is in the clear.
 */
export async function findPlaintextAmount(
  rpc: Rpc<GetTransactionApi>,
  signature: Signature,
  amount: bigint,
): Promise<{ hits: PlaintextHit[]; instructions: number }> {
  const result = await rpc.getTransaction(signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 }).send();
  if (result === null) throw new Error(`transaction ${signature} not found`);
  const inspected = inspectTransaction(result.transaction[0], { maxBytes: 1232, maxInstructions: 64 });

  const needle = new Uint8Array(8);
  new DataView(needle.buffer).setBigUint64(0, amount, true);
  const hits: PlaintextHit[] = [];
  for (const ix of inspected.instructions) {
    for (let offset = 0; offset + needle.length <= ix.data.length; offset++) {
      if (needle.every((b, i) => ix.data[offset + i] === b)) {
        hits.push({ instructionIndex: ix.index, programAddress: ix.programAddress, offset });
      }
    }
  }
  return { hits, instructions: inspected.instructions.length };
}
