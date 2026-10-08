// Static analysis of a wire transaction submitted by a client. Everything here
// is pure: no RPC, no signing. sponsor.ts composes these checks with simulation.
import {
  getAddressEncoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  verifySignature,
  type Address,
  type CompiledTransactionMessage,
  type LegacyCompiledTransactionMessage,
  type SignatureBytes,
  type Transaction,
  type V0CompiledTransactionMessage,
} from "@solana/kit";

/**
 * The message versions the sponsor inspects. Version 1 (SIMD-0385) encodes its
 * instructions as separate header and payload arrays rather than one list, so
 * every check below would need a second implementation. Nothing in the demo
 * builds v1 — the confidential-transfer plans are all v0 — so it is refused
 * explicitly rather than mis-inspected.
 */
export type InspectableCompiledMessage = LegacyCompiledTransactionMessage | V0CompiledTransactionMessage;

export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111" as Address;
export const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;

/** Lamports per signature on Solana; the fee a sponsor always pays. */
export const LAMPORTS_PER_SIGNATURE = 5_000n;
/** Runtime default when a transaction sets no explicit limit. */
export const DEFAULT_CU_PER_INSTRUCTION = 200_000n;
export const MAX_CU_PER_TRANSACTION = 1_400_000n;

export class RejectedTransaction extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

// A function declaration, not an arrow: TypeScript only treats a call as
// control-flow-terminating when the callee's `never` return type is declared.
function reject(code: string, message: string): never {
  throw new RejectedTransaction(message, code);
}

export type AccountRole = { index: number; address: Address; isSigner: boolean; isWritable: boolean };

export type InspectedInstruction = {
  index: number;
  programAddress: Address;
  accounts: AccountRole[];
  data: Uint8Array;
};

export type InspectedTransaction = {
  transaction: Transaction;
  compiled: InspectableCompiledMessage;
  /** Raw wire bytes, as counted against the size cap. */
  bytes: Uint8Array;
  accounts: AccountRole[];
  instructions: InspectedInstruction[];
  /** `staticAccounts[0]`: the account the runtime debits the fee from. */
  feePayer: Address;
  numRequiredSignatures: number;
  /** Required signers whose signature slot is still empty. */
  missingSigners: Address[];
};

/**
 * Derives signer/writable for every static account from the message header.
 * Static accounts are ordered: writable signers, readonly signers, writable
 * non-signers, readonly non-signers.
 */
export function accountRoles(compiled: InspectableCompiledMessage): AccountRole[] {
  const { numSignerAccounts: signers, numReadonlySignerAccounts: readonlySigners, numReadonlyNonSignerAccounts: readonlyNonSigners } =
    compiled.header;
  const total = compiled.staticAccounts.length;
  return compiled.staticAccounts.map((address, index) => ({
    index,
    address,
    isSigner: index < signers,
    isWritable: index < signers - readonlySigners || (index >= signers && index < total - readonlyNonSigners),
  }));
}

/**
 * Decodes a base64 wire transaction and resolves every instruction's accounts.
 *
 * Address lookup tables are refused. The fee-payer and allowlist checks below
 * reason over resolved addresses, and a lookup table would hide some of them
 * behind an account we would have to fetch (and trust to be unchanged between
 * our read and execution). Nothing in the demo needs them.
 */
export function inspectTransaction(txBase64: string, { maxBytes = 1232, maxInstructions = 16 } = {}): InspectedTransaction {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(getBase64Encoder().encode(txBase64));
  } catch (cause) {
    return reject("malformed", `not valid base64: ${String(cause)}`);
  }
  if (bytes.length === 0) reject("malformed", "empty transaction");
  if (bytes.length > maxBytes) reject("too-large", `transaction is ${bytes.length} bytes, cap is ${maxBytes}`);

  let transaction: Transaction;
  let decoded: CompiledTransactionMessage;
  try {
    transaction = getTransactionDecoder().decode(bytes);
    decoded = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  } catch (cause) {
    return reject("malformed", `could not decode the transaction: ${String(cause)}`);
  }
  if (decoded.version !== "legacy" && decoded.version !== 0) {
    reject("unsupported-version", `message version ${String(decoded.version)} is not supported; build a legacy or version 0 transaction`);
  }
  const compiled: InspectableCompiledMessage = decoded;

  const lookups = "addressTableLookups" in compiled ? (compiled.addressTableLookups ?? []) : [];
  if (lookups.length > 0) reject("lookup-tables", "address lookup tables are not supported by the sponsor");

  if (compiled.instructions.length === 0) reject("empty", "transaction has no instructions");
  if (compiled.instructions.length > maxInstructions) {
    reject("too-many-instructions", `transaction has ${compiled.instructions.length} instructions, cap is ${maxInstructions}`);
  }

  const accounts = accountRoles(compiled);
  const at = (index: number): AccountRole => {
    const role = accounts[index];
    if (role === undefined) reject("malformed", `account index ${index} is out of range`);
    return role;
  };

  const instructions: InspectedInstruction[] = compiled.instructions.map((ix, index) => ({
    index,
    programAddress: at(ix.programAddressIndex).address,
    accounts: (ix.accountIndices ?? []).map(at),
    data: new Uint8Array(ix.data ?? []),
  }));

  const feePayer = at(0).address;
  const numRequiredSignatures = compiled.header.numSignerAccounts;
  const missingSigners = accounts
    .filter((a) => a.isSigner && transaction.signatures[a.address] == null)
    .map((a) => a.address);

  return { transaction, compiled, bytes, accounts, instructions, feePayer, numRequiredSignatures, missingSigners };
}

export type ComputeBudget = {
  /** Explicit `SetComputeUnitLimit`, if the transaction set one. */
  unitLimit: bigint | undefined;
  /** Explicit `SetComputeUnitPrice` in micro-lamports per unit, if set. */
  unitPriceMicroLamports: bigint | undefined;
};

/**
 * Reads the ComputeBudget instructions. Their layout is a 1-byte tag plus a
 * little-endian value.
 *
 * A truncated SetComputeUnitLimit or SetComputeUnitPrice is rejected rather than
 * ignored. Silently skipping one would make `worstCaseFeeLamports` underestimate
 * the fee we are agreeing to pay, which is exactly the number the caps are
 * applied to; the runtime would reject the instruction anyway.
 */
export function readComputeBudget(tx: InspectedTransaction): ComputeBudget {
  let unitLimit: bigint | undefined;
  let unitPriceMicroLamports: bigint | undefined;
  for (const ix of tx.instructions) {
    if (ix.programAddress !== COMPUTE_BUDGET_PROGRAM) continue;
    const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    const tag = ix.data[0];
    if (tag === 2) {
      if (ix.data.length < 5) reject("malformed-compute-budget", `instruction ${ix.index}: SetComputeUnitLimit needs 5 bytes`);
      unitLimit = BigInt(view.getUint32(1, true));
    } else if (tag === 3) {
      if (ix.data.length < 9) reject("malformed-compute-budget", `instruction ${ix.index}: SetComputeUnitPrice needs 9 bytes`);
      unitPriceMicroLamports = view.getBigUint64(1, true);
    }
  }
  return { unitLimit, unitPriceMicroLamports };
}

/**
 * Upper bound on what the fee payer can be charged: base fee per signature plus
 * the priority fee the transaction asks for. When no unit limit is set the
 * runtime's own default applies, so we bound with that.
 */
export function worstCaseFeeLamports(tx: InspectedTransaction, budget = readComputeBudget(tx)): bigint {
  const baseFee = LAMPORTS_PER_SIGNATURE * BigInt(tx.numRequiredSignatures);
  const price = budget.unitPriceMicroLamports ?? 0n;
  if (price === 0n) return baseFee;
  const units =
    budget.unitLimit ??
    (DEFAULT_CU_PER_INSTRUCTION * BigInt(tx.instructions.length) > MAX_CU_PER_TRANSACTION
      ? MAX_CU_PER_TRANSACTION
      : DEFAULT_CU_PER_INSTRUCTION * BigInt(tx.instructions.length));
  // Priority fee rounds up to the next whole lamport.
  return baseFee + (units * price + 999_999n) / 1_000_000n;
}

export type SponsorPolicy = {
  allowlist: readonly string[];
  maxComputeUnits: number;
  maxCuPriceMicroLamports: bigint;
  maxFeeLamports: bigint;
};

/** Every instruction must target an allowlisted program. ComputeBudget is always allowed. */
export function assertProgramsAllowed(tx: InspectedTransaction, allowlist: readonly string[]): void {
  const allowed = new Set<string>([...allowlist, COMPUTE_BUDGET_PROGRAM]);
  for (const ix of tx.instructions) {
    if (!allowed.has(ix.programAddress)) {
      reject("program-not-allowed", `instruction ${ix.index} targets ${ix.programAddress}, which is not on the allowlist`);
    }
  }
}

/**
 * The central sponsor invariant: **the sponsor key may appear only as the
 * message fee payer, never inside an instruction.**
 *
 * The fee payer is `staticAccounts[0]`, which the runtime always marks writable
 * and signer. So any instruction that references it hands that program a
 * writable, signed account — enough to drain the sponsor with a System transfer,
 * or to have it authorise a token or program action. Refusing the reference
 * outright is the only version of this rule with no holes.
 *
 * Flows where the sponsor legitimately has to fund rent cannot satisfy this and
 * do not go through here; see `treasury.sponsorConfidentialAccountSetup`, which
 * uses a different key with its own bounded policy.
 */
export function assertSponsorNotUsedByInstructions(tx: InspectedTransaction, sponsor: Address): void {
  for (const ix of tx.instructions) {
    if (ix.programAddress === sponsor) {
      reject("sponsor-as-program", `instruction ${ix.index} names the sponsor as its program`);
    }
    for (const account of ix.accounts) {
      if (account.address !== sponsor) continue;
      const how = [account.isWritable ? "writable" : "readonly", account.isSigner ? "signer" : "non-signer"].join(" ");
      reject("sponsor-in-instruction", `instruction ${ix.index} uses the fee payer as a ${how} account; the fee payer may only pay fees`);
    }
  }
}

/** The client must send a transaction whose only empty signature slot is ours. */
export function assertOnlySponsorSignatureMissing(tx: InspectedTransaction, sponsor: Address): void {
  if (tx.feePayer !== sponsor) {
    reject("wrong-fee-payer", `transaction fee payer is ${tx.feePayer}, expected ${sponsor}`);
  }
  const others = tx.missingSigners.filter((a) => a !== sponsor);
  if (others.length > 0) {
    reject("incomplete-signatures", `these signers have not signed yet: ${others.join(", ")}`);
  }
  if (!tx.missingSigners.includes(sponsor)) {
    reject("already-signed", "the fee payer slot is already filled");
  }
}

/**
 * Verifies the signatures the client did provide, over the exact message bytes
 * we are about to co-sign. Without this a client could submit a transaction
 * carrying junk in another signer's slot; it would pass the static checks, we
 * would sign and broadcast, and the fee would be wasted on a transaction the
 * runtime rejects.
 */
export async function assertPresentSignaturesValid(tx: InspectedTransaction): Promise<void> {
  const encoder = getAddressEncoder();
  for (const account of tx.accounts) {
    if (!account.isSigner) continue;
    const signature = tx.transaction.signatures[account.address];
    if (signature == null) continue;
    let valid: boolean;
    try {
      const key = await crypto.subtle.importKey("raw", new Uint8Array(encoder.encode(account.address)), "Ed25519", false, ["verify"]);
      valid = await verifySignature(key, signature as SignatureBytes, tx.transaction.messageBytes);
    } catch (cause) {
      return reject("bad-signature", `could not verify the signature of ${account.address}: ${String(cause)}`);
    }
    if (!valid) reject("bad-signature", `the signature of ${account.address} does not match the transaction`);
  }
}

/** Compute-budget caps, and the resulting worst-case fee. */
export function assertComputeBudgetWithinPolicy(tx: InspectedTransaction, policy: SponsorPolicy): bigint {
  const budget = readComputeBudget(tx);
  if (budget.unitLimit !== undefined && budget.unitLimit > BigInt(policy.maxComputeUnits)) {
    reject("compute-limit", `requested ${budget.unitLimit} compute units, cap is ${policy.maxComputeUnits}`);
  }
  if (budget.unitPriceMicroLamports !== undefined && budget.unitPriceMicroLamports > policy.maxCuPriceMicroLamports) {
    reject("compute-price", `requested ${budget.unitPriceMicroLamports} micro-lamports per unit, cap is ${policy.maxCuPriceMicroLamports}`);
  }
  const fee = worstCaseFeeLamports(tx, budget);
  if (fee > policy.maxFeeLamports) {
    reject("fee-too-high", `worst-case fee ${fee} lamports exceeds the cap of ${policy.maxFeeLamports}`);
  }
  return fee;
}
