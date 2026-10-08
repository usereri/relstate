// Confidential-transfer helpers over @solana-program/token-2022, following the
// sequence `spikes/ct/spike.mjs` proved on devnet: create + configure account
// (PubkeyValidity proof) → deposit → apply pending → transfer.
//
// Also holds the auditor side of docs/privacy.md: the amount of every transfer
// is encrypted to the auditor ElGamal key configured on the mint, so we can
// decrypt it after the fact for compliance even though the chain cannot.
import {
  sequentialInstructionPlan,
  type Address,
  type GetAccountInfoApi,
  type GetMinimumBalanceForRentExemptionApi,
  type GetTransactionApi,
  type InstructionPlan,
  type Rpc,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import {
  CONFIDENTIAL_TRANSFER_CONFIDENTIAL_TRANSFER_DISCRIMINATOR,
  CONFIDENTIAL_TRANSFER_DISCRIMINATOR,
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMaybeToken,
  fetchToken,
  findAssociatedTokenPda,
  getConfidentialDepositInstruction,
  getConfidentialTransferInstructionDataDecoder,
  type Mint,
  type Token,
} from "@solana-program/token-2022";
import {
  fetchConfidentialTransferBalance,
  getApplyConfidentialPendingBalanceInstructionFromToken,
  getConfidentialTransferInstructionPlan,
  getConfidentialWithdrawInstructionPlan,
  getCreateConfidentialTransferAccountInstructionPlan,
  type ConfidentialTransferBalance,
} from "@solana-program/token-2022/confidential";
import { ElGamalCiphertext, type ElGamalSecretKey } from "@solana/zk-sdk";
import type { ConfidentialKeyPair } from "./keys.ts";
import { inspectTransaction } from "./txinspect.ts";

export type ConfidentialRpc = Rpc<GetAccountInfoApi & GetMinimumBalanceForRentExemptionApi>;

/** `createPlanRunner`'s shape, taken as a parameter so callers can inject a fake. */
export type RunPlan = (payer: TransactionSigner, plan: InstructionPlan, label: string) => Promise<Signature[]>;

export async function associatedTokenAddress(owner: Address, mint: Address): Promise<Address> {
  const [address] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  return address;
}

/** True once the account exists and carries initialised confidential-transfer state. */
export function isConfidentialAccountConfigured(token: Token): boolean {
  const extensions = token.extensions;
  if (extensions.__option === "None") return false;
  return extensions.value.some((e) => e.__kind === "ConfidentialTransferAccount");
}

/**
 * Creates and configures `owner`'s confidential account for `mint` if it is not
 * already configured, with `payer` funding rent. Idempotent, so first-use setup
 * can be retried safely.
 *
 * The owner must sign: `ConfigureAccount` carries the owner's ElGamal pubkey and
 * the ZK PubkeyValidity proof. In the app the embedded wallet signs and the
 * backend only funds — see `treasury.sponsorConfidentialAccountSetup`.
 */
export async function ensureConfidentialAccount(options: {
  run: RunPlan;
  rpc: ConfidentialRpc;
  payer: TransactionSigner;
  owner: TransactionSigner;
  mint: Address;
  keys: ConfidentialKeyPair;
  label?: string;
}): Promise<{ token: Address; created: boolean }> {
  const token = await associatedTokenAddress(options.owner.address, options.mint);
  const existing = await fetchMaybeToken(options.rpc, token);
  if (existing.exists && isConfidentialAccountConfigured(existing.data)) return { token, created: false };

  const plan = await getCreateConfidentialTransferAccountInstructionPlan({
    payer: options.payer,
    owner: options.owner,
    mint: options.mint,
    token,
    rpc: options.rpc,
    elgamalKeypair: options.keys.elgamal,
    aesKey: options.keys.ae,
  });
  await options.run(options.payer, plan, options.label ?? `create + configure confidential account (${options.owner.address})`);
  return { token, created: true };
}

/**
 * Moves a public token balance into the confidential available balance:
 * `Deposit` parks it in the pending balance, `ApplyPendingBalance` makes it
 * spendable. Two steps because applying needs the owner to re-encrypt the new
 * available balance locally.
 */
export async function depositAndApply(options: {
  run: RunPlan;
  rpc: ConfidentialRpc;
  payer: TransactionSigner;
  owner: TransactionSigner;
  token: Address;
  mint: Address;
  amount: bigint;
  decimals: number;
  keys: ConfidentialKeyPair;
}): Promise<void> {
  await options.run(
    options.payer,
    sequentialInstructionPlan([
      getConfidentialDepositInstruction({
        token: options.token,
        mint: options.mint,
        authority: options.owner,
        amount: options.amount,
        decimals: options.decimals,
      }),
    ]),
    `deposit ${options.amount} to pending confidential balance`,
  );
  await applyPendingBalance(options);
}

export async function applyPendingBalance(options: {
  run: RunPlan;
  rpc: ConfidentialRpc;
  payer: TransactionSigner;
  owner: TransactionSigner;
  token: Address;
  keys: ConfidentialKeyPair;
}): Promise<void> {
  const account = await fetchToken(options.rpc, options.token);
  await options.run(
    options.payer,
    sequentialInstructionPlan([
      getApplyConfidentialPendingBalanceInstructionFromToken({
        token: options.token,
        tokenAccount: account.data,
        authority: options.owner,
        elgamalSecretKey: options.keys.elgamal.secret(),
        aesKey: options.keys.ae,
      }),
    ]),
    "apply pending confidential balance",
  );
}

/** A confidential transfer. The amount is encrypted to source, destination and the mint's auditor. */
export async function confidentialTransfer(options: {
  run: RunPlan;
  rpc: ConfidentialRpc;
  payer: TransactionSigner;
  authority: TransactionSigner;
  sourceToken: Address;
  destinationToken: Address;
  mint: Address;
  mintAccount: Mint;
  amount: bigint;
  sourceKeys: ConfidentialKeyPair;
}): Promise<Signature[]> {
  const [source, destination] = await Promise.all([
    fetchToken(options.rpc, options.sourceToken),
    fetchToken(options.rpc, options.destinationToken),
  ]);
  const plan = await getConfidentialTransferInstructionPlan({
    payer: options.payer,
    rpc: options.rpc,
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
  });
  return options.run(options.payer, plan, `confidential transfer ${options.amount}`);
}

/** Confidential available balance back to the public balance, so it can be burnt on unwrap. */
export async function confidentialWithdraw(options: {
  run: RunPlan;
  rpc: ConfidentialRpc;
  payer: TransactionSigner;
  owner: TransactionSigner;
  token: Address;
  mint: Address;
  amount: bigint;
  decimals: number;
  keys: ConfidentialKeyPair;
}): Promise<Signature[]> {
  const account = await fetchToken(options.rpc, options.token);
  const plan = await getConfidentialWithdrawInstructionPlan({
    payer: options.payer,
    rpc: options.rpc,
    token: options.token,
    mint: options.mint,
    tokenAccount: account.data,
    authority: options.owner,
    amount: options.amount,
    decimals: options.decimals,
    elgamalKeypair: options.keys.elgamal,
    aesKey: options.keys.ae,
  });
  return options.run(options.payer, plan, `confidential withdraw ${options.amount} to public balance`);
}

export async function readConfidentialBalance(
  rpc: Parameters<typeof fetchConfidentialTransferBalance>[0]["rpc"],
  token: Address,
  keys: ConfidentialKeyPair,
): Promise<ConfidentialTransferBalance> {
  return fetchConfidentialTransferBalance({ token, rpc, elgamalSecretKey: keys.elgamal.secret(), aesKey: keys.ae });
}

/**
 * The transfer amount is split into a 16-bit low half and a 32-bit high half,
 * each encrypted separately (ElGamal decryption is a discrete-log search, so the
 * halves keep it tractable). Recombining gives the amount back.
 */
export function recombineLoHi(lo: bigint, hi: bigint): bigint {
  return lo + (hi << 16n);
}

/** Decrypts one auditor ciphertext pair from a `ConfidentialTransfer` instruction. */
export function decryptAuditorAmount(
  auditorSecret: ElGamalSecretKey,
  ciphertextLo: Uint8Array,
  ciphertextHi: Uint8Array,
): bigint {
  const decrypt = (bytes: Uint8Array): bigint => {
    const ciphertext = ElGamalCiphertext.fromBytes(bytes);
    if (ciphertext === undefined) throw new Error("auditor ciphertext is not a valid ElGamal ciphertext");
    return auditorSecret.decrypt(ciphertext);
  };
  return recombineLoHi(decrypt(ciphertextLo), decrypt(ciphertextHi));
}

export type AuditedTransfer = {
  signature: Signature;
  instructionIndex: number;
  sourceToken: Address;
  mint: Address;
  destinationToken: Address;
  amount: bigint;
};

/**
 * Compliance read: given a confirmed signature, decrypts the amount of every
 * confidential transfer in it using the auditor key.
 *
 * This is the mechanism `docs/privacy.md` relies on. `pay_rent` cannot check
 * that a hidden amount equals the rent, so the backend verifies it here after
 * the fact and can flag or revoke.
 */
export async function auditTransaction(
  rpc: Rpc<GetTransactionApi>,
  signature: Signature,
  auditorSecret: ElGamalSecretKey,
): Promise<AuditedTransfer[]> {
  const result = await rpc
    .getTransaction(signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 })
    .send();
  if (result === null) throw new Error(`transaction ${signature} not found`);

  const [wire] = result.transaction;
  // A confirmed transaction is bounded by the wire size limit, but it may carry
  // more instructions than the sponsor's own cap allows; this is a read, not a
  // policy decision, so the cap is only a sanity bound.
  const inspected = inspectTransaction(wire, { maxBytes: 1232, maxInstructions: 64 });
  const decoder = getConfidentialTransferInstructionDataDecoder();

  const found: AuditedTransfer[] = [];
  for (const ix of inspected.instructions) {
    if (ix.programAddress !== TOKEN_2022_PROGRAM_ADDRESS) continue;
    if (ix.data.length < 2) continue;
    if (ix.data[0] !== CONFIDENTIAL_TRANSFER_DISCRIMINATOR || ix.data[1] !== CONFIDENTIAL_TRANSFER_CONFIDENTIAL_TRANSFER_DISCRIMINATOR) continue;

    const decoded = decoder.decode(ix.data);
    const accountAt = (position: number): Address => {
      const account = ix.accounts[position];
      if (account === undefined) throw new Error(`instruction ${ix.index} is missing account ${position}`);
      return account.address;
    };
    found.push({
      signature,
      instructionIndex: ix.index,
      // Account order is fixed by the instruction: source token, mint, destination token.
      sourceToken: accountAt(0),
      mint: accountAt(1),
      destinationToken: accountAt(2),
      amount: decryptAuditorAmount(
        auditorSecret,
        new Uint8Array(decoded.transferAmountAuditorCiphertextLo),
        new Uint8Array(decoded.transferAmountAuditorCiphertextHi),
      ),
    });
  }
  return found;
}
