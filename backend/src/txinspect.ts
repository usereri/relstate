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
import { instructionDiscriminator } from "./anchor.ts";
import { ADMIN_ONLY_RELSTATE_INSTRUCTIONS, ASSOCIATED_TOKEN_PROGRAM, RELSTATE_PROGRAM, SPONSORABLE_RELSTATE_INSTRUCTIONS } from "./contracts.ts";

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

/**
 * Rent-exempt minimum the sponsor fronts for the verdict's create-ATA (see
 * {@link sponsorFundedAtaInstructions}), in lamports.
 *
 * A plain SPL token account is 165 bytes, whose rent-exempt minimum is ~2,039,280 lamports at the
 * network's current rent rate. This is a fixed, slightly conservative constant rather than a
 * computed one — the sponsor route never builds the create instruction itself, only inspects one
 * built by the client — so it is rounded up and documented instead of read live from the cluster.
 * A Token-2022 mint with extensions needs a larger account and a correspondingly larger minimum;
 * this demo's mints are plain SPL (`ASSOCIATED_TOKEN_PROGRAM`'s legacy derivation, not
 * Token-2022's), so 165 bytes is the shape actually created. Revisit this constant if a
 * Token-2022 mint with extensions is ever put behind this route.
 */
export const ATA_RENT_LAMPORTS = 2_100_000n;

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
 * Within the relstate program, only the instructions a lease party or a bound appraiser signs for
 * themselves may be co-signed ({@link SPONSORABLE_RELSTATE_INSTRUCTIONS}).
 *
 * `assertProgramsAllowed` cannot express this: it reasons about program ids, and relstate's id
 * covers the admin instructions too. The check is on the 8-byte Anchor prefix, which is the only
 * part of the data that selects a handler; an admin instruction is named in the refusal, because
 * "init_config is not sponsored" is a far more useful answer than an unknown discriminator.
 */
export function assertRelstateInstructionsAllowed(
  tx: InspectedTransaction,
  program: Address = RELSTATE_PROGRAM as Address,
  sponsorable: readonly string[] = SPONSORABLE_RELSTATE_INSTRUCTIONS,
  adminOnly: readonly string[] = ADMIN_ONLY_RELSTATE_INSTRUCTIONS,
): void {
  const allowed = new Map(sponsorable.map((name) => [hexPrefix(instructionDiscriminator(name)), name]));
  const refused = new Map(adminOnly.map((name) => [hexPrefix(instructionDiscriminator(name)), name]));
  for (const ix of tx.instructions) {
    if (ix.programAddress !== program) continue;
    // Shorter than 8 bytes selects no handler at all, so it is malformed rather than unknown.
    if (ix.data.length < 8) {
      reject("malformed-program-instruction", `instruction ${ix.index} on ${program} carries ${ix.data.length} bytes, too few for an instruction prefix`);
    }
    const prefix = hexPrefix(ix.data.subarray(0, 8));
    if (allowed.has(prefix)) continue;
    const admin = refused.get(prefix);
    reject(
      "instruction-not-allowed",
      admin === undefined
        ? `instruction ${ix.index} calls an unknown relstate instruction (${prefix}); the sponsor co-signs only ${sponsorable.length} known ones`
        : `instruction ${ix.index} calls ${admin}, which only the program's admin or issuer signs; the sponsor does not co-sign it`,
    );
  }
}

const hexPrefix = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * `submit_verdict`'s account positions, by name. Reproduced by hand and **pinned against the
 * program's IDL by name** in `test/txinspect.test.ts`, the same way `providers/kyc-chain.ts` pins
 * its instruction mirrors.
 *
 * Not read from the IDL at runtime, deliberately: everything in this module is pure — no
 * filesystem, no RPC — which is what lets the sponsor's checks be reasoned about and tested in
 * isolation, and the IDL is in any case optional (a fresh clone has none). The pinning test is the
 * guarantee instead, so a reordered account list fails loudly rather than silently moving which
 * account the check below constrains.
 */
export const SUBMIT_VERDICT_ACCOUNTS = { appraiser: 0, mint: 3, appraiserAta: 8, tokenProgram: 11 } as const;

/** `CreateIdempotent`: a one-byte discriminator and six accounts, in this order. */
const ATA_CREATE_IDEMPOTENT = 1;
const ATA_ACCOUNTS = { payer: 0, ata: 1, owner: 2, mint: 3, systemProgram: 4, tokenProgram: 5 } as const;
const ATA_ACCOUNT_COUNT = 6;

/**
 * The one shape in which a sponsored transaction may name the fee payer inside an instruction: an
 * idempotent create of the **bound appraiser's** token account, in the same transaction as the
 * verdict that pays into it.
 *
 * Why an exception has to exist at all. The appraiser's wallet is created when they open the
 * invitation and holds neither SOL nor a token account, but `submit_verdict` transfers the fee to
 * `appraiser_ata` as an initialised account, so the client must put a create-idempotent in front of
 * it and *somebody* must pay the rent (docs/contracts/dispute-mediation.md §4, phase 3). The payer
 * slot of that instruction is a writable signer, which
 * {@link assertSponsorNotUsedByInstructions} otherwise refuses outright — correctly, because that
 * slot is exactly how a System transfer would drain the sponsor.
 *
 * So the exception is made structural rather than trusted, and all of it is checkable without any
 * RPC:
 *
 *   * the instruction is `CreateIdempotent` on the associated-token program, with **no trailing
 *     data** and exactly six accounts, so it cannot be some other ATA instruction;
 *   * the fee payer appears **only** in the payer slot, and nowhere else in that account list;
 *   * the account being created, its owner and its mint are **the very accounts the verdict
 *     instruction uses** as `appraiser_ata`, `appraiser` and `mint`. The ATA program derives the
 *     address from (owner, mint, token program) and refuses a mismatch, so the sponsor can only
 *     ever fund the canonical token account of the wallet signing the verdict;
 *   * the owner **signs** the transaction, so the sponsor is not funding an account for a wallet
 *     that is merely named;
 *   * it comes *before* the verdict, which is where it has to be for Anchor to see an initialised
 *     account, and there is **at most one** of them.
 *
 * The property that makes this safe is the last one in that list combined with atomicity: **no rent
 * leaves the sponsor unless a valid `submit_verdict` lands in the same transaction.** If the verdict
 * fails any of the program's checks — not the bound appraiser, not in mediation, past the verdict
 * deadline — the whole transaction reverts and the account is never created. The blast radius is
 * therefore one token-account rent per lease that actually reaches a verdict, which is a cost the
 * platform is paying for on purpose.
 *
 * What this does NOT bound is the sponsor's lamport budget: `worstCaseFeeLamports` counts fees, and
 * the rent is debited by the System program inside the instruction, so it is not booked against the
 * per-wallet daily cap. That is a deliberate, documented gap — the structural bound above is what
 * limits it — and it is noted in `docs/env-checklist.md`.
 */
export function sponsorFundedAtaInstructions(
  tx: InspectedTransaction,
  sponsor: Address,
  program: Address = RELSTATE_PROGRAM as Address,
): ReadonlySet<number> {
  const verdict = instructionDiscriminator("submit_verdict");
  const verdicts = tx.instructions.filter(
    (ix) => ix.programAddress === program && ix.data.length >= 8 && hexPrefix(ix.data.subarray(0, 8)) === hexPrefix(verdict),
  );
  // Two verdicts in one transaction is not a shape we understand, so nothing is exempt.
  if (verdicts.length !== 1) return new Set();
  const paying = verdicts[0]!;
  const account = (index: number): Address | undefined => paying.accounts[index]?.address;
  const appraiser = paying.accounts[SUBMIT_VERDICT_ACCOUNTS.appraiser];
  if (appraiser === undefined || !appraiser.isSigner) return new Set();

  const exempt = new Set<number>();
  for (const ix of tx.instructions) {
    if (ix.programAddress !== ASSOCIATED_TOKEN_PROGRAM) continue;
    if (ix.index >= paying.index) continue;
    if (ix.data.length !== 1 || ix.data[0] !== ATA_CREATE_IDEMPOTENT) continue;
    if (ix.accounts.length !== ATA_ACCOUNT_COUNT) continue;
    const payer = ix.accounts[ATA_ACCOUNTS.payer]!;
    if (payer.address !== sponsor || !payer.isSigner || !payer.isWritable) continue;
    if (ix.accounts.some((a, i) => i !== ATA_ACCOUNTS.payer && a.address === sponsor)) continue;
    if (ix.accounts[ATA_ACCOUNTS.ata]!.address !== account(SUBMIT_VERDICT_ACCOUNTS.appraiserAta)) continue;
    if (ix.accounts[ATA_ACCOUNTS.owner]!.address !== appraiser.address) continue;
    if (ix.accounts[ATA_ACCOUNTS.mint]!.address !== account(SUBMIT_VERDICT_ACCOUNTS.mint)) continue;
    if (ix.accounts[ATA_ACCOUNTS.systemProgram]!.address !== SYSTEM_PROGRAM) continue;
    if (ix.accounts[ATA_ACCOUNTS.tokenProgram]!.address !== account(SUBMIT_VERDICT_ACCOUNTS.tokenProgram)) continue;
    exempt.add(ix.index);
  }
  // One account, one rent. Several matching creates would all be for the same ATA — idempotent, so
  // only the first can charge rent — but a shape nobody needs is a shape not worth allowing.
  return exempt.size > 1 ? new Set() : exempt;
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
 *
 * **The one exception** is the verdict's create-ATA, whose shape is constrained so tightly by
 * {@link sponsorFundedAtaInstructions} that the sponsor cannot be made to fund any other account —
 * read that function's comment for why it is safe. The exemption is computed here rather than
 * passed in, so no call site can forget it or widen it; `exempt` is a test seam.
 */
export function assertSponsorNotUsedByInstructions(
  tx: InspectedTransaction,
  sponsor: Address,
  exempt: ReadonlySet<number> = sponsorFundedAtaInstructions(tx, sponsor),
): void {
  for (const ix of tx.instructions) {
    if (ix.programAddress === sponsor) {
      reject("sponsor-as-program", `instruction ${ix.index} names the sponsor as its program`);
    }
    if (exempt.has(ix.index)) continue;
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
